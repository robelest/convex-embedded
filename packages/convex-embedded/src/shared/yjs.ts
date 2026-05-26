import * as Y from "yjs";

import { createEmptyProseContent } from "@/crdt/prose/content";
import { normalizeProseContent } from "@/crdt/prose/content";
import { yDocToProseContent } from "@/crdt/prose/yjs";
import { proseContentToYDoc } from "@/crdt/prose/yjs";
import type { Definition } from "@/shared/schema";
import { getCrdtType } from "@/shared/schema";
import { CrdtType } from "@/shared/types";

export function initYjsDoc(
  schemaDef: Definition,
  row: Record<string, unknown>,
  seq: number = 0,
  options?: { skipProse?: boolean },
): Y.Doc {
  const doc = new Y.Doc();
  const fields = doc.getMap("fields");
  const shape = schemaDef.getShape();

  doc.transact(() => {
    for (const [key, fieldDef] of Object.entries(shape)) {
      const crdtType = getCrdtType(fieldDef);
      if (crdtType === null) continue;
      if (crdtType === CrdtType.Omitted) continue;

      const value = row[key];

      if (crdtType === CrdtType.Prose) {
        if (options?.skipProse) continue;
        const seeded = proseContentToYDoc(normalizeProseContent(value), key);
        Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(seeded));
        seeded.destroy();
      } else if (crdtType === CrdtType.Register) {
        const registerMap = new Y.Map<{ value: unknown; timestamp: number }>();
        registerMap.set("_init", { value, timestamp: seq });
        fields.set(key, registerMap);
      } else if (crdtType === CrdtType.Counter) {
        const counterArr = new Y.Array<{
          client: string;
          delta: number;
          timestamp: number;
        }>();
        if (typeof value === "number" && value !== 0) {
          counterArr.push([{ client: "_init", delta: value, timestamp: seq }]);
        }
        fields.set(key, counterArr);
      } else if (crdtType === CrdtType.Set) {
        const setMap = new Y.Map<{ addedBy: string; addedAt: number }>();
        if (Array.isArray(value)) {
          for (const item of value) {
            const serialized =
              typeof item === "string" ? item : JSON.stringify(item);
            setMap.set(serialized, { addedBy: "_init", addedAt: seq });
          }
        }
        fields.set(key, setMap);
      }
    }
  }, "init");

  return doc;
}

export function encodeDocumentState(
  schemaDef: Definition,
  row: Record<string, unknown>,
  seq: number = 0,
): Uint8Array {
  const doc = initYjsDoc(schemaDef, row, seq);
  try {
    return Y.encodeStateAsUpdateV2(doc);
  } finally {
    doc.destroy();
  }
}

export function computeDiff(
  serverUpdate: Uint8Array,
  clientVector: Uint8Array,
): Uint8Array {
  return Y.diffUpdateV2(serverUpdate, clientVector);
}

export function mergeUpdate(...updates: Uint8Array[]): Uint8Array {
  return Y.mergeUpdatesV2(updates);
}

export function isDiffEmpty(update: Uint8Array): boolean {
  const EMPTY_YJS_V2_UPDATE = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];

  return (
    update.byteLength === 0 ||
    (update.byteLength === EMPTY_YJS_V2_UPDATE.length &&
      update.every((value, index) => EMPTY_YJS_V2_UPDATE[index] === value))
  );
}

function getRegisterValue(
  doc: Y.Doc,
  fieldName: string,
  resolver?: (conflict: { latest(): unknown; values: unknown[] }) => unknown,
): unknown {
  const fields = doc.getMap("fields");
  const registerMap = fields.get(fieldName);

  if (!(registerMap instanceof Y.Map)) return undefined;

  const entries: Array<{ value: unknown; timestamp: number }> = [];
  registerMap.forEach((val) => {
    const record = val as { value: unknown; timestamp?: number };
    entries.push({ value: record.value, timestamp: record.timestamp ?? 0 });
  });

  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0]!.value;

  const latest = () =>
    [...entries].sort((a, b) => b.timestamp - a.timestamp)[0]?.value;
  return resolver
    ? resolver({ latest, values: entries.map((entry) => entry.value) })
    : latest();
}

function getCounterValue(doc: Y.Doc, fieldName: string): number {
  const fields = doc.getMap("fields");
  const counterArr = fields.get(fieldName);

  if (!(counterArr instanceof Y.Array)) return 0;

  let sum = 0;
  for (let index = 0; index < counterArr.length; index += 1) {
    const entry = counterArr.get(index);
    if (
      entry &&
      typeof entry === "object" &&
      "delta" in entry &&
      typeof entry.delta === "number"
    ) {
      sum += entry.delta;
    }
  }
  return sum;
}

function getSetMembers<T = string>(doc: Y.Doc, fieldName: string): T[] {
  const fields = doc.getMap("fields");
  const setMap = fields.get(fieldName);

  if (!(setMap instanceof Y.Map)) return [];

  const members: T[] = [];
  setMap.forEach((_value, key) => {
    try {
      members.push(JSON.parse(key) as T);
    } catch {
      members.push(key as unknown as T);
    }
  });
  return members;
}

export function materializeYjsDoc(
  schemaDef: Definition,
  doc: Y.Doc,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, fieldDef] of Object.entries(schemaDef.getShape())) {
    const crdtType = getCrdtType(fieldDef);

    if (crdtType === null) continue;
    if (crdtType === CrdtType.Omitted) continue;

    if (crdtType === CrdtType.Prose) {
      result[key] =
        doc.getXmlFragment(key).length > 0
          ? yDocToProseContent(doc, key)
          : createEmptyProseContent();
    } else if (crdtType === CrdtType.Register) {
      result[key] = getRegisterValue(
        doc,
        key,
        (
          fieldDef as {
            resolve?:
              | ((conflict: {
                  latest(): unknown;
                  values: unknown[];
                }) => unknown)
              | undefined;
          }
        )?.resolve,
      );
    } else if (crdtType === CrdtType.Counter) {
      result[key] = getCounterValue(doc, key);
    } else if (crdtType === CrdtType.Set) {
      result[key] = getSetMembers(doc, key);
    }
  }

  return result;
}

const MATERIALIZE_CACHE_MAX = 100;

/**
 * Bounded LRU keyed by a cheap hash of the update bytes plus the docId.
 * Y.Doc reconstruction is O(updates), so the same row materialized by
 * multiple subscribers benefits from a shared decoded copy. Map iteration
 * order is insertion order, so re-setting on hit moves the entry to the
 * tail — that's how we approximate LRU with one Map.
 */
const materializeCache = new Map<string, Record<string, unknown>>();

function hashUpdateBytes(bytes: Uint8Array): string {
  const length = bytes.byteLength;
  if (length === 0) return "0:";
  let head = "";
  const headLen = Math.min(16, length);
  for (let i = 0; i < headLen; i += 1) {
    const byte = bytes[i] ?? 0;
    head += (byte < 16 ? "0" : "") + byte.toString(16);
  }
  let tail = "";
  if (length > 16) {
    const tailStart = Math.max(headLen, length - 8);
    for (let i = tailStart; i < length; i += 1) {
      const byte = bytes[i] ?? 0;
      tail += (byte < 16 ? "0" : "") + byte.toString(16);
    }
  }
  return `${length}:${head}:${tail}`;
}

export function materializeDocumentFromUpdate(input: {
  schemaDef: Definition;
  docId: string;
  docCreationTime: number;
  update: ArrayBuffer;
}): Record<string, unknown> {
  const bytes = new Uint8Array(input.update);
  const cacheKey = `${input.docId}|${input.docCreationTime}|${hashUpdateBytes(bytes)}`;
  const cached = materializeCache.get(cacheKey);
  if (cached !== undefined) {
    // Re-set to mark recently used. Return a shallow copy so callers that
    // mutate the result don't poison the cache.
    materializeCache.delete(cacheKey);
    materializeCache.set(cacheKey, cached);
    return { ...cached };
  }

  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, bytes);
  const materialized = materializeYjsDoc(input.schemaDef, doc);
  materialized._id = input.docId;
  materialized._creationTime = input.docCreationTime;
  doc.destroy();

  if (materializeCache.size >= MATERIALIZE_CACHE_MAX) {
    const oldest = materializeCache.keys().next().value;
    if (oldest !== undefined) {
      materializeCache.delete(oldest);
    }
  }
  materializeCache.set(cacheKey, materialized);
  return { ...materialized };
}
