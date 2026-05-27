import type { ConvexClient } from "convex/browser";
import * as Y from "yjs";

import type { EmbeddedClientLike, TableConfig } from "@/client/engine";
import type { ScopeRecord } from "@/client/engine/subscriptions";
import type { IdMap } from "@/client/ids";
import { materializeYjsDoc } from "@/client/schema";
import { SystemPaths } from "@/kernel/system";
import type { IngestDocumentsOptions } from "@/runtime/embedded";
import { unwrapSchemaField } from "@/shared/canonicalize";
import { createLogger } from "@/shared/logger";
import { getCrdtType, type Definition } from "@/shared/schema";
import type {
  EngineStatus,
  PullDocumentResponse,
  PullProgress,
  PullResponse,
} from "@/shared/types";
import { initYjsDoc } from "@/shared/yjs";
import { withSpan } from "@/tracing/spans";
import { retryWithBackoff } from "@/utils/retry";

const log = createLogger("resolve");

interface RemoteCallable {
  mutation(ref: unknown, args: unknown): Promise<unknown>;
  query(ref: unknown, args: unknown): Promise<unknown>;
}

interface TableCoalesceEntry {
  signalSeqs: Set<number>;
  pendingThunks: Map<string, () => void>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PullState {
  expectedSelfCausedSignals: Map<string, number[]>;
  lastKnownCollectionSeqByTable: Map<string, number>;
  lastPulledScopeSeq: Map<string, number>;
  pullInFlight: Map<string, Promise<void>>;
  pullRerun: Set<string>;
  tableCoalesceMap: Map<string, TableCoalesceEntry>;
  coalesceWindowMs: number;
}

export interface MergeState {
  dirtyRows: Set<string>;
  crdtFieldsByTable: Map<string, Set<string>>;
}

export function createPullState(opts?: {
  coalesceWindowMs?: number;
}): PullState {
  return {
    expectedSelfCausedSignals: new Map(),
    lastKnownCollectionSeqByTable: new Map(),
    lastPulledScopeSeq: new Map(),
    pullInFlight: new Map(),
    pullRerun: new Set(),
    tableCoalesceMap: new Map(),
    coalesceWindowMs: opts?.coalesceWindowMs ?? 32,
  };
}

export function createMergeState(
  tables: Record<string, { schema?: Definition }>,
): MergeState {
  const crdtFieldsByTable = new Map<string, Set<string>>();
  for (const [tableName, tableConfig] of Object.entries(tables)) {
    const shape = tableConfig.schema?.getShape();
    if (!shape) continue;
    const crdtFields = new Set<string>();
    for (const [fieldName, fieldDef] of Object.entries(shape)) {
      if (getCrdtType(fieldDef) !== null) {
        crdtFields.add(fieldName);
      }
    }
    if (crdtFields.size > 0) {
      crdtFieldsByTable.set(tableName, crdtFields);
    }
  }
  return {
    dirtyRows: new Set(),
    crdtFieldsByTable,
  };
}

function retryable<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { maxRetries: number; retryDelayMs: number; signal?: AbortSignal },
): Promise<T> {
  let attempt = 0;
  return retryWithBackoff(
    () => {
      if (opts.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const current = attempt++;
      return fn(current);
    },
    {
      maxRetries: Math.max(opts.maxRetries - 1, 0),
      baseMs: opts.retryDelayMs,
      jitter: true,
      signal: opts.signal,
    },
  );
}

export function recordExpectedSelfCausedSignal(
  state: PullState,
  tableName: string,
  postCommitSeq: number,
): void {
  const existing = state.expectedSelfCausedSignals.get(tableName) ?? [];
  existing.push(postCommitSeq);
  existing.sort((a, b) => a - b);
  state.expectedSelfCausedSignals.set(tableName, existing);
}

export function nextExpectedSelfCausedSeq(
  state: PullState,
  tableName: string,
): number {
  const lastKnown = state.lastKnownCollectionSeqByTable.get(tableName) ?? -1;
  const pending = state.expectedSelfCausedSignals.get(tableName);
  const highestPending =
    pending && pending.length > 0 ? pending[pending.length - 1]! : -1;
  return Math.max(lastKnown, highestPending) + 1;
}

export function consumeExpectedSelfCausedSignal(
  state: PullState,
  tableName: string,
  signalSeq: number,
): boolean {
  const seqs = state.expectedSelfCausedSignals.get(tableName);
  if (!seqs || seqs.length === 0) return false;
  let bestIndex = -1;
  for (let i = seqs.length - 1; i >= 0; i--) {
    if (seqs[i]! <= signalSeq) {
      bestIndex = i;
      break;
    }
  }
  if (bestIndex < 0) return false;
  seqs.splice(bestIndex, 1);
  if (seqs.length === 0) {
    state.expectedSelfCausedSignals.delete(tableName);
  } else {
    state.expectedSelfCausedSignals.set(tableName, seqs);
  }
  if (signalSeq >= 0) {
    state.lastKnownCollectionSeqByTable.set(tableName, signalSeq);
  }
  log.debug(
    `sync: skipping self-caused bind for "${tableName}" (signalSeq=${signalSeq})`,
  );
  return true;
}

function hasPendingSelfCausedSignal(
  state: PullState,
  tableName: string,
): boolean {
  const pending = state.expectedSelfCausedSignals.get(tableName);
  return pending !== undefined && pending.length > 0;
}

function getLastKnownCollectionSeq(
  state: PullState,
  tableName: string,
): number | undefined {
  return state.lastKnownCollectionSeqByTable.get(tableName);
}

function recordPulledScopeSeq(
  state: PullState,
  deps: { buildScopeKey: PullDeps["buildScopeKey"] },
  tableName: string,
  scopeArgs: Record<string, unknown> | undefined,
  collectionSeq: number | null,
): void {
  if (collectionSeq === null) return;
  const scopeKey = deps.buildScopeKey(tableName, scopeArgs ?? {});
  const prev = state.lastPulledScopeSeq.get(scopeKey) ?? -Infinity;
  if (collectionSeq > prev) {
    state.lastPulledScopeSeq.set(scopeKey, collectionSeq);
  }
}

export function hasPulledScopeSeq(state: PullState, scopeKey: string): boolean {
  return state.lastPulledScopeSeq.has(scopeKey);
}

export function shouldSkipRedundantPartialPull(
  state: PullState,
  deps: { buildScopeKey: PullDeps["buildScopeKey"] },
  tableName: string,
  scopeArgs: Record<string, unknown> | undefined,
  signalSeq: number,
): boolean {
  if (signalSeq < 0) return false;
  const scopeKey = deps.buildScopeKey(tableName, scopeArgs ?? {});
  const pulledSeq = state.lastPulledScopeSeq.get(scopeKey);
  if (pulledSeq === undefined) return false;
  if (signalSeq <= pulledSeq) {
    log.debug(
      `sync: skipping redundant partial resolve for "${tableName}" ` +
        `(signalSeq=${signalSeq} <= pulledSeq=${pulledSeq})`,
    );
    return true;
  }
  return false;
}

export function scheduleTableCoalesce(
  state: PullState,
  input: {
    tableName: string;
    scopeKey: string;
    signalSeq: number;
    runHandler: () => void;
  },
): void {
  const { tableName, scopeKey, signalSeq, runHandler } = input;
  let entry = state.tableCoalesceMap.get(tableName);
  if (!entry) {
    entry = {
      signalSeqs: new Set(),
      pendingThunks: new Map(),
      timer: null,
    };
    state.tableCoalesceMap.set(tableName, entry);
  }
  if (signalSeq >= 0) {
    entry.signalSeqs.add(signalSeq);
  }
  entry.pendingThunks.set(scopeKey, runHandler);
  if (entry.timer === null) {
    entry.timer = setTimeout(() => {
      fireCoalescedTableUpdate(state, tableName);
    }, state.coalesceWindowMs);
  }
}

function fireCoalescedTableUpdate(
  state: PullState,
  tableName: string,
): void {
  const entry = state.tableCoalesceMap.get(tableName);
  if (!entry) return;
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.pendingThunks.size === 0) {
    state.tableCoalesceMap.delete(tableName);
    return;
  }
  if (entry.signalSeqs.size > 0) {
    const highestSeq = Math.max(...Array.from(entry.signalSeqs));
    if (highestSeq >= 0) {
      state.lastKnownCollectionSeqByTable.set(tableName, highestSeq);
    }
  }
  const thunks = Array.from(entry.pendingThunks.values());
  state.tableCoalesceMap.delete(tableName);
  for (const thunk of thunks) {
    try {
      thunk();
    } catch (err) {
      log.warn(`sync: coalesced bind thunk for "${tableName}" failed`, err);
    }
  }
}

function inFlightGet(
  state: PullState,
  key: string,
): Promise<void> | undefined {
  return state.pullInFlight.get(key);
}

function inFlightSet(
  state: PullState,
  key: string,
  promise: Promise<void>,
): void {
  state.pullInFlight.set(key, promise);
}

function inFlightDelete(state: PullState, key: string): void {
  state.pullInFlight.delete(key);
}

function markRerun(state: PullState, key: string): void {
  state.pullRerun.add(key);
}

function takeRerun(state: PullState, key: string): boolean {
  return state.pullRerun.delete(key);
}

export function clearAll(state: PullState): void {
  for (const entry of state.tableCoalesceMap.values()) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
    }
  }
  state.tableCoalesceMap.clear();
  state.expectedSelfCausedSignals.clear();
  state.lastKnownCollectionSeqByTable.clear();
  state.lastPulledScopeSeq.clear();
  state.pullInFlight.clear();
  state.pullRerun.clear();
}

export function shouldTrackCrdt(
  mergeState: MergeState,
  tableName: string,
): boolean {
  return mergeState.crdtFieldsByTable.has(tableName);
}

export function markDirty(
  mergeState: MergeState,
  tableName: string,
  docId: string,
): void {
  if (!mergeState.crdtFieldsByTable.has(tableName)) return;
  mergeState.dirtyRows.add(`${tableName}:${docId}`);
}

function clearDirty(
  mergeState: MergeState,
  tableName: string,
  docId: string,
): void {
  mergeState.dirtyRows.delete(`${tableName}:${docId}`);
}

export function clearAllDirty(mergeState: MergeState): void {
  mergeState.dirtyRows.clear();
}

export function hasDirty(mergeState: MergeState): boolean {
  return mergeState.dirtyRows.size > 0;
}

function iterateGroupedDirty(
  mergeState: MergeState,
  orderedTables: string[],
): Array<{ tableName: string; docIds: Set<string> }> {
  const rowsByTable = new Map<string, Set<string>>();
  for (const key of mergeState.dirtyRows) {
    const sep = key.indexOf(":");
    if (sep < 0) continue;
    const tableName = key.slice(0, sep);
    const docId = key.slice(sep + 1);
    if (!mergeState.crdtFieldsByTable.has(tableName)) continue;
    const set = rowsByTable.get(tableName) ?? new Set<string>();
    set.add(docId);
    rowsByTable.set(tableName, set);
  }
  return orderedTables.flatMap((tableName) => {
    const docIds = rowsByTable.get(tableName);
    return docIds && docIds.size > 0 ? [{ tableName, docIds }] : [];
  });
}

type LocalYjsEntry = {
  localDoc: Record<string, unknown>;
};

type PullDocument = {
  docId: string;
  vector: ArrayBuffer;
  lastSeq: number | null;
};

type PullArgs = {
  collectionSeq: number | null;
  documents: Array<PullDocument>;
  docIds?: string[];
  scopeArgs?: Record<string, unknown>;
  fullCursor?: string | null;
};

type PullResultRow = PullDocumentResponse;

type PullMetadata = {
  collectionSeq: number | null;
  documentSeqById: Map<string, number>;
};

type PreparedResolveInput = {
  localDocs: Array<Record<string, unknown>>;
  localYjsMap: Map<string, LocalYjsEntry>;
  pullDocuments: Array<PullDocument>;
  schemaDef: Definition;
};

type MergeResolveOutput = {
  deletedDocIds: string[];
  diffCount: number;
  mergedDocs: Array<Record<string, unknown>>;
  metadataEntries: Array<{ docId: string; seq: number }>;
};

type MissingReference = {
  tableName: string;
  id: string;
};

type ReferenceValidator = Record<string, unknown> & { kind?: string };

export interface PullDeps {
  tables: Record<string, TableConfig>;
  orderedTables: string[];
  getRemoteApplyOrder: () => string[];
  activeScopes: ReadonlyMap<string, ScopeRecord>;
  buildScopeKey: (
    tableName: string,
    scopeArgs?: Record<string, unknown>,
  ) => string;
  ingestDocuments: (
    table: string,
    docs: Array<Record<string, unknown>>,
    scopeArgs?: Record<string, unknown>,
    options?: IngestDocumentsOptions,
  ) => Promise<void>;
  getDocumentsForTable: (
    table: string,
  ) => Promise<Array<Record<string, unknown>>>;
  getDocumentsForScope?: (
    table: string,
    scopeArgs: Record<string, unknown>,
  ) => Promise<Array<Record<string, unknown>> | null>;
  idMap: IdMap;
  embedded: EmbeddedClientLike;
  remoteClient: ConvexClient;
  maxRetries: number;
  retryDelayMs: number;
  emit: (status: EngineStatus) => void;
  yieldToEventLoop: () => Promise<void>;
  runLocalSystemQuery: <T>(
    path: string,
    args: Record<string, unknown>,
  ) => Promise<T>;
  runLocalSystemMutation: (
    path: string,
    args: Record<string, unknown>,
  ) => Promise<void>;
  getCurrentIdentityKey: () => string | null;
}

function stripOmittedFields(
  schemaDef: Definition,
  docs: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const omittedFields = schemaDef.getOmittedFields();
  if (omittedFields.length === 0) return docs;
  return docs.map((doc) => {
    const stripped = { ...doc };
    for (const field of omittedFields) {
      delete stripped[field];
    }
    return stripped;
  });
}

function getFieldValueByPath(
  doc: Record<string, unknown>,
  fieldPath: string,
): unknown {
  return fieldPath.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, doc);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error == null) return "unknown error";
  try {
    return JSON.stringify(error);
  } catch {
    return "unknown error";
  }
}

function isUnsupportedDocIdsPullError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("extra field") &&
    message.includes("docids") &&
    message.includes("validator")
  );
}

function canonicalizePullResponse(
  response: PullResponse | Array<PullResultRow>,
  fallbackCollectionSeq: number | null,
): PullResponse {
  if (Array.isArray(response)) {
    return {
      mode: "incremental",
      collectionSeq: fallbackCollectionSeq ?? -1,
      documents: response,
    };
  }
  return response;
}

function hasResolvableReferences(
  value: unknown,
  field: unknown,
  hasDocumentId: (id: string) => boolean,
  getAliases: (id: string) => Set<string>,
): boolean {
  const unwrapped = unwrapSchemaField(field);
  if (value === null || value === undefined) return true;
  if (typeof unwrapped === "string") return true;
  if (typeof unwrapped !== "object" || unwrapped === null) return true;

  const validator = unwrapped as ReferenceValidator;
  if (validator.kind === "id") {
    return (
      typeof value !== "string" ||
      hasDocumentId(value) ||
      Array.from(getAliases(value)).some((alias) => hasDocumentId(alias))
    );
  } else if (validator.kind === "array") {
    return (
      !Array.isArray(value) ||
      value.every((entry) =>
        hasResolvableReferences(
          entry,
          validator.element,
          hasDocumentId,
          getAliases,
        ),
      )
    );
  } else if (validator.kind === "record") {
    return (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.values(value).every((entry) =>
        hasResolvableReferences(
          entry,
          validator.value,
          hasDocumentId,
          getAliases,
        ),
      )
    );
  } else if (validator.kind === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return true;
    }
    const fields = validator.fields as Record<string, unknown> | undefined;
    if (!fields) return true;
    return Object.entries(fields).every(([key, nestedField]) =>
      hasResolvableReferences(
        (value as Record<string, unknown>)[key],
        nestedField,
        hasDocumentId,
        getAliases,
      ),
    );
  } else if (validator.kind === "union") {
    const members = validator.members;
    if (!Array.isArray(members)) return true;
    return members.some((member) =>
      hasResolvableReferences(value, member, hasDocumentId, getAliases),
    );
  } else if (validator.kind === "optional") {
    return hasResolvableReferences(
      value,
      validator.field,
      hasDocumentId,
      getAliases,
    );
  }
  return true;
}

function recordMissingId(
  value: unknown,
  validator: ReferenceValidator,
  hasDocumentId: (id: string) => boolean,
  getAliases: (id: string) => Set<string>,
  missing: Map<string, Set<string>>,
): void {
  const tableName = validator.tableName;
  if (typeof value !== "string" || typeof tableName !== "string") return;
  if (hasDocumentId(value)) return;
  if (Array.from(getAliases(value)).some((alias) => hasDocumentId(alias))) {
    return;
  }
  const ids = missing.get(tableName) ?? new Set<string>();
  ids.add(value);
  missing.set(tableName, ids);
}

function gatherMissingReferences(
  value: unknown,
  field: unknown,
  hasDocumentId: (id: string) => boolean,
  getAliases: (id: string) => Set<string>,
  missing: Map<string, Set<string>>,
): void {
  const unwrapped = unwrapSchemaField(field);
  if (value === null || value === undefined) return;
  if (typeof unwrapped !== "object" || unwrapped === null) return;
  const validator = unwrapped as ReferenceValidator;
  const recurse = (innerValue: unknown, innerField: unknown): void =>
    gatherMissingReferences(
      innerValue,
      innerField,
      hasDocumentId,
      getAliases,
      missing,
    );

  switch (validator.kind) {
    case "id":
      return recordMissingId(
        value,
        validator,
        hasDocumentId,
        getAliases,
        missing,
      );
    case "array":
      if (!Array.isArray(value)) return;
      for (const entry of value) recurse(entry, validator.element);
      return;
    case "record":
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return;
      for (const entry of Object.values(value)) recurse(entry, validator.value);
      return;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return;
      const fields = validator.fields as Record<string, unknown> | undefined;
      if (!fields) return;
      for (const [key, nestedField] of Object.entries(fields)) {
        recurse((value as Record<string, unknown>)[key], nestedField);
      }
      return;
    }
    case "union": {
      const members = validator.members;
      if (!Array.isArray(members)) return;
      if (
        members.some((member) =>
          hasResolvableReferences(value, member, hasDocumentId, getAliases),
        )
      ) {
        return;
      }
      for (const member of members) recurse(value, member);
      return;
    }
    case "optional":
      recurse(value, validator.field);
      return;
  }
}

function getMissingReferences(input: {
  docs: Array<Record<string, unknown>>;
  schema?: Definition;
  hasDocumentId: (id: string) => boolean;
  getAliases?: (id: string) => Set<string>;
}): MissingReference[] {
  if (!input.schema) return [];
  const missing = new Map<string, Set<string>>();
  const getAliases = input.getAliases ?? (() => new Set<string>());
  for (const doc of input.docs) {
    for (const [fieldName, field] of Object.entries(input.schema.getShape())) {
      gatherMissingReferences(
        doc[fieldName],
        field,
        input.hasDocumentId,
        getAliases,
        missing,
      );
    }
  }
  return Array.from(missing.entries()).flatMap(([tableName, ids]) =>
    Array.from(ids).map((id) => ({ tableName, id })),
  );
}

function filterDocumentsWithResolvableReferences(input: {
  docs: Array<Record<string, unknown>>;
  schema?: Definition;
  hasDocumentId: (id: string) => boolean;
  getAliases?: (id: string) => Set<string>;
}): {
  accepted: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
} {
  if (!input.schema) return { accepted: input.docs, skipped: [] };
  const accepted: Array<Record<string, unknown>> = [];
  const skipped: Array<Record<string, unknown>> = [];
  for (const doc of input.docs) {
    const resolvable = Object.entries(input.schema.getShape()).every(
      ([fieldName, field]) =>
        hasResolvableReferences(
          doc[fieldName],
          field,
          input.hasDocumentId,
          input.getAliases ?? (() => new Set()),
        ),
    );
    if (resolvable) {
      accepted.push(doc);
    } else {
      skipped.push(doc);
    }
  }
  return { accepted, skipped };
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

function preparePullInput(
  schemaDef: Definition,
  localDocs: Array<Record<string, unknown>>,
  metadata: PullMetadata,
): PreparedResolveInput {
  return localDocs.reduce<PreparedResolveInput>(
    (acc, doc) => {
      const docId = doc._id as string | undefined;
      if (!docId) return acc;
      const yjsDoc = initYjsDoc(schemaDef, doc, 0, { skipProse: true });
      const vector = toArrayBuffer(Y.encodeStateVector(yjsDoc));
      yjsDoc.destroy();
      acc.localYjsMap.set(docId, { localDoc: doc });
      acc.pullDocuments.push({
        docId,
        lastSeq: metadata.documentSeqById.get(docId) ?? null,
        vector,
      });
      return acc;
    },
    {
      localDocs,
      schemaDef,
      localYjsMap: new Map<string, LocalYjsEntry>(),
      pullDocuments: [],
    },
  );
}

function mergeCrdtFieldsWithPlain(
  schemaDef: Definition,
  localDoc: Record<string, unknown>,
  yjsDoc: Y.Doc,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...localDoc };
  const crdtFields = materializeYjsDoc(schemaDef, yjsDoc);
  for (const [key, value] of Object.entries(crdtFields)) {
    merged[key] = value;
  }
  return merged;
}

function mergePullResult(input: {
  localDocs: Array<Record<string, unknown>>;
  localYjsMap: Map<string, LocalYjsEntry>;
  pullResult: PullResponse;
  schemaDef: Definition;
  tableName: string;
  localSeqsByDocId: Map<string, number>;
  translateRemoteDocument: (
    document: Record<string, unknown>,
  ) => Record<string, unknown>;
}): MergeResolveOutput {
  const seqAdvanced = (docId: string, seq: number): boolean =>
    seq > (input.localSeqsByDocId.get(docId) ?? -Infinity);
  if (input.pullResult.mode === "full") {
    const mergedDocs = input.pullResult.documents.flatMap((row) => {
      if (!row.document) return [];
      return [input.translateRemoteDocument(row.document)];
    });
    const deletedDocIds = input.pullResult.documents.flatMap((row) =>
      row.deleted ? [row.docId] : [],
    );
    const metadataEntries = input.pullResult.documents.flatMap((row) =>
      typeof row.seq === "number" && seqAdvanced(row.docId, row.seq)
        ? [{ docId: row.docId, seq: row.seq }]
        : [],
    );
    return { deletedDocIds, diffCount: 0, mergedDocs, metadataEntries };
  }

  const mergedDocsById = new Map(
    input.localDocs
      .filter((doc) => typeof doc._id === "string")
      .map(
        (doc) => [String(doc._id), input.translateRemoteDocument(doc)] as const,
      ),
  );

  const output = input.pullResult.documents.reduce<MergeResolveOutput>(
    (acc, { docId, deleted, diff, document, seq }) => {
      if (deleted) {
        mergedDocsById.delete(docId);
        acc.deletedDocIds.push(docId);
        return acc;
      }
      const entry = input.localYjsMap.get(docId);
      if (!entry) {
        if (document) {
          mergedDocsById.set(docId, input.translateRemoteDocument(document));
          if (typeof seq === "number" && seqAdvanced(docId, seq)) {
            acc.metadataEntries.push({ docId, seq });
          }
          return acc;
        }
        log.warn(
          `sync: resolve returned diff for unknown doc "${docId}" in "${input.tableName}"`,
        );
        return acc;
      }
      if (diff) {
        const yjsDoc = initYjsDoc(input.schemaDef, entry.localDoc, 0, {
          skipProse: true,
        });
        Y.applyUpdateV2(yjsDoc, new Uint8Array(diff));
        acc.diffCount += 1;
        const merged = mergeCrdtFieldsWithPlain(
          input.schemaDef,
          entry.localDoc,
          yjsDoc,
        );
        yjsDoc.destroy();
        merged._id = entry.localDoc._id;
        merged._creationTime = entry.localDoc._creationTime;
        mergedDocsById.set(docId, input.translateRemoteDocument(merged));
        if (typeof seq === "number" && seqAdvanced(docId, seq)) {
          acc.metadataEntries.push({ docId, seq });
        }
        return acc;
      }
      mergedDocsById.set(docId, input.translateRemoteDocument(entry.localDoc));
      if (typeof seq === "number" && seqAdvanced(docId, seq)) {
        acc.metadataEntries.push({ docId, seq });
      }
      return acc;
    },
    {
      deletedDocIds: [],
      diffCount: 0,
      mergedDocs: [],
      metadataEntries: [],
    },
  );
  output.mergedDocs = Array.from(mergedDocsById.values());
  return output;
}

async function ingestMergedDocs(input: {
  ingestDocuments: PullDeps["ingestDocuments"];
  mergedDocs: Array<Record<string, unknown>>;
  scopeArgs?: Record<string, unknown>;
  tableName: string;
  ingestOptions?: IngestDocumentsOptions;
}): Promise<void> {
  if (
    input.mergedDocs.length === 0 &&
    input.ingestOptions?.keepIds === undefined
  ) {
    return;
  }
  await input.ingestDocuments(
    input.tableName,
    input.mergedDocs,
    input.scopeArgs,
    input.ingestOptions,
  );
}

async function runSpan<A>(input: {
  name: string;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  run: () => Promise<A> | A;
}): Promise<A> {
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    if (value !== null && value !== undefined) {
      attributes[key] = value;
    }
  }
  return withSpan(input.name, () => input.run(), { attributes });
}

async function readPullMetadata(
  deps: PullDeps,
  tableName: string,
  tableConfig: TableConfig,
  docIds: string[] = [],
): Promise<PullMetadata> {
  const schemaVersion = tableConfig.schema.version;
  const identityKey = deps.getCurrentIdentityKey();
  const [collectionSeq, documentEntries] = await Promise.all([
    deps.runLocalSystemQuery<number | null>(SystemPaths.collectionMetadataGet, {
      collection: tableName,
      identityKey,
      schemaVersion,
    }),
    deps.runLocalSystemQuery<Array<{ docId: string; seq: number }>>(
      SystemPaths.documentMetadataGetBatch,
      {
        collection: tableName,
        docIds,
        identityKey,
        schemaVersion,
      },
    ),
  ]);
  return {
    collectionSeq: collectionSeq ?? null,
    documentSeqById: new Map(
      (documentEntries ?? []).map((entry) => [entry.docId, entry.seq]),
    ),
  };
}

async function readPullMetadataFastPath(
  deps: PullDeps,
  tableName: string,
  tableConfig: TableConfig,
  docIds: string[],
  knownCollectionSeq: number,
): Promise<PullMetadata> {
  const schemaVersion = tableConfig.schema.version;
  const identityKey = deps.getCurrentIdentityKey();
  const documentEntries = await deps.runLocalSystemQuery<
    Array<{ docId: string; seq: number }>
  >(SystemPaths.documentMetadataGetBatch, {
    collection: tableName,
    docIds,
    identityKey,
    schemaVersion,
  });
  return {
    collectionSeq: knownCollectionSeq,
    documentSeqById: new Map(
      (documentEntries ?? []).map((entry) => [entry.docId, entry.seq]),
    ),
  };
}

async function writePullMetadata(
  deps: PullDeps,
  input: {
    tableConfig: TableConfig;
    tableName: string;
    pullResult: PullResponse;
    metadataEntries: Array<{ docId: string; seq: number }>;
    deletedDocIds: string[];
    clearCollection?: boolean;
    advanceCollectionSeq?: boolean;
  },
): Promise<void> {
  const schemaVersion = input.tableConfig.schema.version;
  const identityKey = deps.getCurrentIdentityKey();

  const currentMeta = await readPullMetadata(
    deps,
    input.tableName,
    input.tableConfig,
    [],
  );
  const newCollectionSeq = input.pullResult.collectionSeq;
  const operations: Array<Promise<void>> = [];
  if (
    input.advanceCollectionSeq !== false &&
    (currentMeta.collectionSeq === null ||
      newCollectionSeq > currentMeta.collectionSeq)
  ) {
    operations.push(
      deps.runLocalSystemMutation(SystemPaths.collectionMetadataSet, {
        collection: input.tableName,
        seq: newCollectionSeq,
        identityKey,
        schemaVersion,
      }),
    );
  }

  if (input.pullResult.mode === "full" && input.clearCollection !== false) {
    operations.push(
      deps.runLocalSystemMutation(SystemPaths.documentMetadataClearCollection, {
        collection: input.tableName,
        identityKey,
        schemaVersion,
      }),
    );
  }

  if (input.metadataEntries.length > 0) {
    operations.push(
      deps.runLocalSystemMutation(SystemPaths.documentMetadataSetBatch, {
        collection: input.tableName,
        entries: input.metadataEntries,
        identityKey,
        schemaVersion,
      }),
    );
  }

  if (input.deletedDocIds.length > 0) {
    operations.push(
      deps.runLocalSystemMutation(SystemPaths.documentMetadataDeleteBatch, {
        collection: input.tableName,
        docIds: input.deletedDocIds,
        identityKey,
        schemaVersion,
      }),
    );
  }

  await Promise.all(operations);
}

async function hydrateDocumentsById(
  deps: PullDeps,
  input: {
    tableName: string;
    ids: string[];
    signal?: AbortSignal;
    visited: Set<string>;
  },
): Promise<void> {
  const tableConfig = deps.tables[input.tableName];
  if (!tableConfig) return;
  const ids = Array.from(new Set(input.ids)).filter((id) => {
    if (deps.embedded.hasLocalDocumentId?.(id) ?? false) return false;
    const key = `${input.tableName}:${id}`;
    if (input.visited.has(key)) return false;
    input.visited.add(key);
    return true;
  });
  if (ids.length === 0) return;
  if (input.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  const idSet = new Set(ids);
  const localDocs = (await deps.getDocumentsForTable(input.tableName)).filter(
    (doc) => typeof doc._id === "string" && idSet.has(String(doc._id)),
  );
  const metadata = await readPullMetadata(
    deps,
    input.tableName,
    tableConfig,
    ids,
  );
  const { schemaDef, localYjsMap, pullDocuments } = preparePullInput(
    tableConfig.schema,
    localDocs,
    metadata,
  );

  let rawResolveResult: PullResponse | Array<PullResultRow>;
  try {
    rawResolveResult = (await (
      deps.remoteClient as unknown as RemoteCallable
    ).query(tableConfig.resolve, {
      collectionSeq: null,
      documents: pullDocuments,
      docIds: ids,
    } satisfies PullArgs)) as PullResponse | Array<PullResultRow>;
  } catch (error) {
    if (!isUnsupportedDocIdsPullError(error)) throw error;
    log.warn(
      `sync: remote resolve for "${input.tableName}" does not support exact doc hydration; falling back to full table resolve`,
    );
    await getTableSpec(
      createPullState(),
      deps,
      input.tableName,
      tableConfig,
      input.signal,
    );
    return;
  }
  const pullResult = canonicalizePullResponse(rawResolveResult, null);
  const { deletedDocIds, mergedDocs, metadataEntries } = mergePullResult({
    localDocs,
    localYjsMap,
    pullResult,
    schemaDef,
    tableName: input.tableName,
    localSeqsByDocId: metadata.documentSeqById,
    translateRemoteDocument: (document) =>
      stripOmittedFields(schemaDef, [document])[0] ?? document,
  });

  const { accepted, skipped } = await filterAfterHydratingReferences(deps, {
    docs: mergedDocs,
    tableName: input.tableName,
    signal: input.signal,
    visited: input.visited,
  });
  if (accepted.length > 0) {
    await ingestMergedDocs({
      ingestDocuments: deps.ingestDocuments,
      mergedDocs: accepted,
      tableName: input.tableName,
    });
  }

  const acceptedDocIds = new Set(
    accepted.flatMap((doc) =>
      typeof doc._id === "string" ? [String(doc._id)] : [],
    ),
  );
  await writePullMetadata(deps, {
    tableConfig,
    tableName: input.tableName,
    pullResult,
    metadataEntries: metadataEntries.filter((entry) =>
      acceptedDocIds.has(entry.docId),
    ),
    deletedDocIds,
    clearCollection: false,
  });

  if (skipped.length > 0) {
    log.warn(
      `sync: could not hydrate ${skipped.length} "${input.tableName}" referenced doc(s) due to unresolved references`,
    );
  }
}

async function hydrateMissingReferences(
  deps: PullDeps,
  input: {
    docs: Array<Record<string, unknown>>;
    tableName: string;
    signal?: AbortSignal;
    visited: Set<string>;
  },
): Promise<void> {
  const missing = getMissingReferences({
    docs: input.docs,
    schema: deps.tables[input.tableName]?.schema,
    hasDocumentId: (id) => deps.embedded.hasLocalDocumentId?.(id) ?? false,
    getAliases: (id) => deps.idMap.getAliases(id),
  });
  if (missing.length === 0) return;

  const byTable = new Map<string, Set<string>>();
  for (const ref of missing) {
    if (!(ref.tableName in deps.tables)) continue;
    const ids = byTable.get(ref.tableName) ?? new Set<string>();
    ids.add(ref.id);
    byTable.set(ref.tableName, ids);
  }

  for (const [tableName, ids] of byTable) {
    await hydrateDocumentsById(deps, {
      tableName,
      ids: Array.from(ids),
      signal: input.signal,
      visited: input.visited,
    });
  }
}

export async function filterAfterHydratingReferences(
  deps: PullDeps,
  input: {
    docs: Array<Record<string, unknown>>;
    tableName: string;
    signal?: AbortSignal;
    visited?: Set<string>;
  },
): Promise<{
  accepted: Array<Record<string, unknown>>;
  skipped: Array<Record<string, unknown>>;
}> {
  const visited = input.visited ?? new Set<string>();
  let result = filterDocumentsWithResolvableReferences({
    docs: input.docs,
    schema: deps.tables[input.tableName]?.schema,
    hasDocumentId: (id) => deps.embedded.hasLocalDocumentId?.(id) ?? false,
    getAliases: (id) => deps.idMap.getAliases(id),
  });
  if (result.skipped.length === 0) return result;

  try {
    await hydrateMissingReferences(deps, {
      docs: result.skipped,
      tableName: input.tableName,
      signal: input.signal,
      visited,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    log.warn(
      `sync: reference hydration failed for "${input.tableName}":`,
      error,
    );
    return result;
  }

  result = filterDocumentsWithResolvableReferences({
    docs: input.docs,
    schema: deps.tables[input.tableName]?.schema,
    hasDocumentId: (id) => deps.embedded.hasLocalDocumentId?.(id) ?? false,
    getAliases: (id) => deps.idMap.getAliases(id),
  });
  return result;
}

async function getTablePagePlan(
  state: PullState,
  deps: PullDeps,
  tableName: string,
  tableConfig: TableConfig,
  signal?: AbortSignal,
  scopeArgs?: Record<string, unknown>,
): Promise<void> {
  let attempts = 0;

  const indexScopedDocs =
    scopeArgs && Object.keys(scopeArgs).length > 0 && deps.getDocumentsForScope
      ? await deps.getDocumentsForScope(tableName, scopeArgs)
      : null;
  const scopedLocalDocs =
    indexScopedDocs ??
    (scopeArgs && Object.keys(scopeArgs).length > 0
      ? (await deps.getDocumentsForTable(tableName)).filter((doc) =>
          Object.entries(scopeArgs).every(
            ([fieldPath, expected]) =>
              getFieldValueByPath(doc, fieldPath) === expected,
          ),
        )
      : await deps.getDocumentsForTable(tableName));

  const docIds = scopedLocalDocs.flatMap((doc) =>
    typeof doc._id === "string" ? [String(doc._id)] : [],
  );

  let schemaDef: Definition;
  let localYjsMap: Map<string, LocalYjsEntry>;
  let pullDocuments: Array<PullDocument>;
  let metadataCollectionSeq: number | null = null;
  let localSeqsByDocId: Map<string, number> = new Map();

  {
    const pendingSelfCaused = hasPendingSelfCausedSignal(state, tableName);
    const cachedCollectionSeq = getLastKnownCollectionSeq(state, tableName);
    const metadata =
      pendingSelfCaused && typeof cachedCollectionSeq === "number"
        ? await readPullMetadataFastPath(
            deps,
            tableName,
            tableConfig,
            docIds,
            cachedCollectionSeq,
          )
        : await readPullMetadata(deps, tableName, tableConfig, docIds);
    metadataCollectionSeq = metadata.collectionSeq;
    localSeqsByDocId = metadata.documentSeqById;
    ({ schemaDef, localYjsMap, pullDocuments } = await runSpan({
      name: "convex_embedded.resolve.prepareInput",
      attributes: {
        table: tableName,
        local_doc_count: scopedLocalDocs.length,
      },
      run: () =>
        preparePullInput(tableConfig.schema, scopedLocalDocs, metadata),
    }));
  }

  const isNewScope =
    scopeArgs &&
    Object.keys(scopeArgs).length > 0 &&
    scopedLocalDocs.length === 0;
  const effectiveCollectionSeq = isNewScope ? null : metadataCollectionSeq;

  log.debug(
    `sync: resolving "${tableName}" with ${pullDocuments.length} local doc(s)`,
  );

  const fetchPullPage = async (cursor?: string | null) => {
    const rawResolveResult = await retryable<
      PullResponse | Array<PullResultRow>
    >(
      async () => {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        attempts++;
        try {
          const args: PullArgs = {
            collectionSeq: effectiveCollectionSeq,
            documents: pullDocuments,
            ...(scopeArgs && Object.keys(scopeArgs).length > 0
              ? { scopeArgs }
              : {}),
            ...(cursor !== undefined ? { fullCursor: cursor } : {}),
          };
          return (deps.remoteClient as unknown as RemoteCallable).query(
            tableConfig.resolve,
            args,
          ) as Promise<PullResponse | Array<PullResultRow>>;
        } catch (err) {
          if (!(err instanceof DOMException && err.name === "AbortError")) {
            log.warn(
              `sync: resolve attempt ${attempts}/${deps.maxRetries} failed for "${tableName}"`,
              err,
            );
          }
          throw err;
        }
      },
      { maxRetries: deps.maxRetries, retryDelayMs: deps.retryDelayMs, signal },
    );
    return canonicalizePullResponse(rawResolveResult, effectiveCollectionSeq);
  };

  const accumulatedMetadataEntries: Array<{ docId: string; seq: number }> = [];
  const accumulatedDeletedDocIds: string[] = [];
  const ingestedRemoteIds = new Set<string>();
  let totalResolvedDocs = 0;
  let totalDiffCount = 0;
  let finalResolveResult: PullResponse | null = null;

  const processPage = async (
    page: PullResponse,
    pageNumber: number,
    streamingFullMode: boolean,
  ): Promise<void> => {
    const { deletedDocIds, mergedDocs, diffCount, metadataEntries } =
      await runSpan({
        name: "convex_embedded.resolve.merge",
        attributes: {
          table: tableName,
          page: pageNumber,
          resolved_doc_count: page.documents.length,
          mode: page.mode,
        },
        run: () =>
          mergePullResult({
            localDocs: scopedLocalDocs,
            localYjsMap,
            pullResult: page,
            schemaDef,
            tableName,
            localSeqsByDocId,
            translateRemoteDocument: (document) =>
              stripOmittedFields(schemaDef, [document])[0] ?? document,
          }),
      });
    const { accepted: resolvableDocs, skipped: unresolvedDocs } =
      await filterAfterHydratingReferences(deps, {
        docs: mergedDocs,
        tableName,
        signal,
      });
    if (unresolvedDocs.length > 0) {
      await runSpan({
        name: "convex_embedded.resolve.unresolved_documents",
        attributes: {
          table: tableName,
          unresolved_count: unresolvedDocs.length,
          merged_count: mergedDocs.length,
        },
        run: async () => undefined,
      });
      log.warn(
        `sync: skipped ${unresolvedDocs.length} "${tableName}" resolve doc(s) with unresolved references`,
      );
    }
    const resolvableDocIds = new Set(
      resolvableDocs.flatMap((doc) =>
        typeof doc._id === "string" ? [String(doc._id)] : [],
      ),
    );
    for (const entry of metadataEntries) {
      if (resolvableDocIds.has(entry.docId)) {
        accumulatedMetadataEntries.push(entry);
      }
    }
    for (const id of resolvableDocIds) {
      ingestedRemoteIds.add(id);
    }
    accumulatedDeletedDocIds.push(...deletedDocIds);
    totalResolvedDocs += page.documents.length;
    totalDiffCount += diffCount;

    await runSpan({
      name: "convex_embedded.resolve.ingest",
      attributes: {
        table: tableName,
        page: pageNumber,
        resolved_doc_count: page.documents.length,
        diff_count: diffCount,
        ingest_count: resolvableDocs.length,
        streaming: streamingFullMode,
      },
      run: () =>
        ingestMergedDocs({
          ingestDocuments: deps.ingestDocuments,
          mergedDocs: resolvableDocs,
          scopeArgs,
          tableName,
          ingestOptions: streamingFullMode
            ? { deleteAbsent: false }
            : undefined,
        }),
    });
  };

  let fullyDrained: boolean;
  let shouldPrune: boolean;

  {
    const firstResolveResult = await runSpan({
      name: "convex_embedded.resolve.fetch",
      attributes: { table: tableName, page: 0 },
      run: () => fetchPullPage(),
    });
    const isStreamingFullMode =
      firstResolveResult.mode === "full" && firstResolveResult.isDone === false;
    await processPage(firstResolveResult, 0, isStreamingFullMode);
    finalResolveResult = firstResolveResult;

    if (isStreamingFullMode) {
      let continueCursor = firstResolveResult.continueCursor ?? null;
      let pageIndex = 1;

      while (continueCursor !== null) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const cursor = continueCursor;
        const pageNumber = pageIndex;
        const page = await runSpan({
          name: "convex_embedded.resolve.fetch",
          attributes: { table: tableName, page: pageNumber },
          run: () => fetchPullPage(cursor),
        });
        if (page.mode !== "full") {
          throw new Error(
            `[convex-embedded] resolve pagination changed mode unexpectedly for "${tableName}".`,
          );
        }
        await processPage(page, pageNumber, true);
        continueCursor = page.continueCursor ?? null;
        pageIndex += 1;
        finalResolveResult = page;
      }
    }
    fullyDrained = true;
    shouldPrune = isStreamingFullMode;
  }

  if (shouldPrune) {
    await runSpan({
      name: "convex_embedded.resolve.prune",
      attributes: {
        table: tableName,
        keep_count: ingestedRemoteIds.size,
      },
      run: () =>
        ingestMergedDocs({
          ingestDocuments: deps.ingestDocuments,
          mergedDocs: [],
          scopeArgs,
          tableName,
          ingestOptions: { deleteAbsent: true, keepIds: ingestedRemoteIds },
        }),
    });
  }

  if (finalResolveResult) {
    await writePullMetadata(deps, {
      tableConfig,
      tableName,
      pullResult: finalResolveResult,
      metadataEntries: accumulatedMetadataEntries,
      deletedDocIds: accumulatedDeletedDocIds,
      clearCollection: false,
      advanceCollectionSeq: fullyDrained,
    });

    recordPulledScopeSeq(
      state,
      deps,
      tableName,
      scopeArgs,
      finalResolveResult.collectionSeq,
    );
  }

  log.debug(
    `sync: resolved table "${tableName}" — ` +
      `${totalResolvedDocs} doc(s), ${totalDiffCount} diff(s) applied`,
  );
}

export async function getTableSpec(
  state: PullState,
  deps: PullDeps,
  tableName: string,
  tableConfig: TableConfig,
  signal?: AbortSignal,
  scopeArgs?: Record<string, unknown>,
): Promise<void> {
  const key = deps.buildScopeKey(tableName, scopeArgs ?? {});
  const inFlight = inFlightGet(state, key);
  if (inFlight) {
    markRerun(state, key);
    return inFlight;
  }
  const run = (async () => {
    try {
      await withSpan(
        "convex-embedded.getTableSpec",
        () =>
          getTablePagePlan(
            state,
            deps,
            tableName,
            tableConfig,
            signal,
            scopeArgs,
          ),
        {
          attributes: {
            "convex.table": tableName,
            "convex.source": "remote",
            "convex.resolve.scoped": Boolean(
              scopeArgs && Object.keys(scopeArgs).length > 0,
            ),
          },
        },
      );
    } finally {
      inFlightDelete(state, key);
    }
    if (takeRerun(state, key)) {
      await getTableSpec(
        state,
        deps,
        tableName,
        tableConfig,
        signal,
        scopeArgs,
      );
    }
  })();
  inFlightSet(state, key, run);
  return run;
}

export async function pullAll(
  state: PullState,
  deps: PullDeps,
  signal?: AbortSignal,
): Promise<void> {
  return withSpan("convex-embedded.pullAll", async () => {
    const remoteApplyOrder = deps.getRemoteApplyOrder();
    const scopedResolves = Array.from(deps.activeScopes.values())
      .filter((entry) => Object.keys(entry.scopeArgs).length > 0)
      .sort(
        (left, right) =>
          deps.orderedTables.indexOf(left.tableName) -
          deps.orderedTables.indexOf(right.tableName),
      );
    const progress: PullProgress = {
      tables: [
        ...remoteApplyOrder,
        ...scopedResolves.map((entry) =>
          deps.buildScopeKey(entry.tableName, entry.scopeArgs),
        ),
      ],
      completed: 0,
      total: remoteApplyOrder.length + scopedResolves.length,
    };

    deps.emit({ status: "resolving", progress });

    try {
      for (const tableName of remoteApplyOrder) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        await getTableSpec(
          state,
          deps,
          tableName,
          deps.tables[tableName]!,
          signal,
        );
        progress.completed++;
        deps.emit({ status: "resolving", progress: { ...progress } });
        await deps.yieldToEventLoop();
      }
      for (const entry of scopedResolves) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        await getTableSpec(
          state,
          deps,
          entry.tableName,
          deps.tables[entry.tableName]!,
          signal,
          entry.scopeArgs,
        );
        progress.completed++;
        deps.emit({ status: "resolving", progress: { ...progress } });
        await deps.yieldToEventLoop();
      }
      deps.emit({ status: "resolved" });
      log.info("sync: all tables resolved successfully");
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      log.error("sync: resolve failed", err);
      deps.emit({
        status: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  });
}

async function mergeDirtyRowsForTable(
  state: PullState,
  mergeState: MergeState,
  deps: PullDeps,
  tableName: string,
  tableConfig: TableConfig,
  docIds: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  const localDocs = await deps.getDocumentsForTable(tableName);
  const dirtyLocalDocs = localDocs.filter(
    (doc) => typeof doc._id === "string" && docIds.has(String(doc._id)),
  );
  if (dirtyLocalDocs.length === 0) {
    for (const docId of docIds) {
      clearDirty(mergeState, tableName, docId);
    }
    return;
  }

  const dirtyDocIds = dirtyLocalDocs.flatMap((doc) =>
    typeof doc._id === "string" ? [String(doc._id)] : [],
  );
  const metadata = await readPullMetadata(
    deps,
    tableName,
    tableConfig,
    dirtyDocIds,
  );
  const { schemaDef, localYjsMap, pullDocuments } = preparePullInput(
    tableConfig.schema,
    dirtyLocalDocs,
    metadata,
  );

  if (pullDocuments.length === 0) {
    for (const docId of docIds) {
      clearDirty(mergeState, tableName, docId);
    }
    return;
  }

  let attempts = 0;
  const rawResolveResult = await retryable<PullResponse | Array<PullResultRow>>(
    async () => {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      attempts++;
      try {
        return (deps.remoteClient as unknown as RemoteCallable).query(
          tableConfig.resolve,
          {
            collectionSeq: metadata.collectionSeq,
            documents: pullDocuments,
          } satisfies PullArgs,
        ) as Promise<PullResponse | Array<PullResultRow>>;
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          log.warn(
            `sync: targeted merge attempt ${attempts}/${deps.maxRetries} failed for "${tableName}"`,
            err,
          );
        }
        throw err;
      }
    },
    { maxRetries: deps.maxRetries, retryDelayMs: deps.retryDelayMs, signal },
  );
  const pullResult = canonicalizePullResponse(
    rawResolveResult,
    metadata.collectionSeq,
  );

  const { mergedDocs, metadataEntries, deletedDocIds } = mergePullResult({
    localDocs: dirtyLocalDocs,
    localYjsMap,
    pullResult,
    schemaDef,
    tableName,
    localSeqsByDocId: metadata.documentSeqById,
    translateRemoteDocument: (document) =>
      stripOmittedFields(schemaDef, [document])[0] ?? document,
  });

  const { accepted: resolvableDocs } = await filterAfterHydratingReferences(
    deps,
    {
      docs: mergedDocs,
      tableName,
      signal,
    },
  );

  await ingestMergedDocs({
    ingestDocuments: deps.ingestDocuments,
    mergedDocs: resolvableDocs,
    tableName,
  });

  const resolvableDocIds = new Set(
    resolvableDocs.flatMap((doc) =>
      typeof doc._id === "string" ? [String(doc._id)] : [],
    ),
  );
  const resolvableMetadataEntries = metadataEntries.filter((entry) =>
    resolvableDocIds.has(entry.docId),
  );

  await writePullMetadata(deps, {
    tableConfig,
    tableName,
    pullResult,
    metadataEntries: resolvableMetadataEntries,
    deletedDocIds,
  });

  for (const docId of docIds) {
    clearDirty(mergeState, tableName, docId);
  }

  void state;
}

export async function runMerge(
  state: PullState,
  mergeState: MergeState,
  deps: PullDeps,
  signal?: AbortSignal,
): Promise<void> {
  return withSpan("convex-embedded.mergeDirtyCrdtRows", async () => {
    if (!hasDirty(mergeState)) return;

    const grouped = iterateGroupedDirty(mergeState, deps.orderedTables);
    if (grouped.length === 0) {
      clearAllDirty(mergeState);
      return;
    }
    const orderedDirtyTables = grouped.map((entry) => entry.tableName);
    const rowsByTable = new Map(
      grouped.map((entry) => [entry.tableName, entry.docIds] as const),
    );

    deps.emit({
      status: "resolving",
      progress: {
        tables: orderedDirtyTables,
        completed: 0,
        total: orderedDirtyTables.length,
      },
    });

    try {
      let completed = 0;
      for (const tableName of orderedDirtyTables) {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        const tableConfig = deps.tables[tableName];
        if (!tableConfig) {
          completed += 1;
          continue;
        }
        const dirty = rowsByTable.get(tableName);
        if (!dirty || dirty.size === 0) {
          completed += 1;
          continue;
        }
        await mergeDirtyRowsForTable(
          state,
          mergeState,
          deps,
          tableName,
          tableConfig,
          dirty,
          signal,
        );
        completed += 1;
        deps.emit({
          status: "resolving",
          progress: {
            tables: orderedDirtyTables,
            completed,
            total: orderedDirtyTables.length,
          },
        });
        await deps.yieldToEventLoop();
      }
      deps.emit({ status: "resolved" });
    } catch (err) {
      if (signal?.aborted) return;
      if (err instanceof DOMException && err.name === "AbortError") return;
      log.error("sync: targeted CRDT merge failed", err);
      deps.emit({
        status: "error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  });
}
