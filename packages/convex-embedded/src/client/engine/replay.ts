import type { ConvexClient } from "convex/browser";

import type { EmbeddedClientLike, TableConfig } from "@/client/engine";
import * as pull from "@/client/engine/pull";
import type { PullState } from "@/client/engine/pull";
import type { IdMap } from "@/client/ids";
import {
  MAX_REPLAY_RETRIES,
  type PendingEntry,
  type PendingQueue,
} from "@/client/pending/queue";
import {
  type PendingUploadEntry,
  type PendingUploadQueue,
} from "@/client/pending/uploads";
import { parseErrorMetadata } from "@/shared/errors";
import { createLogger } from "@/shared/logger";
import { makeFunctionReference } from "@/shared/refs";
import type { Definition } from "@/shared/schema";
import type { EngineStatus } from "@/shared/types";
import { recordCounter } from "@/tracing/metrics";
import { withSpan } from "@/tracing/spans";
import { runDetached } from "@/utils/detached";

const log = createLogger("resolve");

const REPLAY_GRACE_MS = 3_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RemoteCallable {
  mutation(ref: unknown, args: unknown): Promise<unknown>;
  query(ref: unknown, args: unknown): Promise<unknown>;
}

type QueueEntryRoute =
  | { _tag: "Stop" }
  | { _tag: "DropMappedCreate"; localResult: string }
  | { _tag: "Push"; localResult: unknown };

type StorageDependency = {
  localStorageId: string;
  metadata: Record<string, unknown>;
  blob: Blob;
};

export interface ReplayState {
  inFlight: Promise<Set<string>> | null;
  requestedWhileActive: boolean;
  activeEntry: PendingEntry | null;
  recentlyReplayedIds: Map<string, number>;
}

export interface ReplayDeps {
  pendingQueue: PendingQueue;
  pendingUploadQueue: PendingUploadQueue;
  embedded: EmbeddedClientLike;
  idMap: IdMap;
  remoteClient: ConvexClient;
  tables: Record<string, TableConfig>;
  tableSchemas: Record<string, Definition>;
  maxRetries: number;
  retryDelayMs: number;
  processorId: string;
  leaseMs: number;
  uploadUrlRef?: unknown;
  uploadFetch?: typeof globalThis.fetch;
  pullState: PullState;
  softResetSubsBuffers: () => void;
  hasActiveSubs: () => boolean;
  emit: (status: EngineStatus) => void;
  isOnline: () => boolean;
  isStarted: () => boolean;
  runScheduler: () => Promise<void>;
  stopRemoteSubscriptions: () => void;
  pullTable: (
    tableName: string,
    tableConfig: TableConfig,
    signal?: AbortSignal,
  ) => Promise<void>;
}

export function createReplayState(): ReplayState {
  return {
    inFlight: null,
    requestedWhileActive: false,
    activeEntry: null,
    recentlyReplayedIds: new Map<string, number>(),
  };
}

export function activeEntry(state: ReplayState): PendingEntry | null {
  return state.activeEntry;
}

export function setActiveEntry(
  state: ReplayState,
  entry: PendingEntry | null,
): void {
  state.activeEntry = entry;
}

function sweepRecent(state: ReplayState, now: number): void {
  for (const [id, timestamp] of state.recentlyReplayedIds) {
    if (now - timestamp >= REPLAY_GRACE_MS) {
      state.recentlyReplayedIds.delete(id);
    }
  }
}

function addRecentlyReplayed(state: ReplayState, id: string): void {
  const now = Date.now();
  sweepRecent(state, now);
  state.recentlyReplayedIds.set(id, now);
}

export function recentlyReplayedIdSet(state: ReplayState): ReadonlySet<string> {
  const now = Date.now();
  sweepRecent(state, now);
  const active = new Set<string>();
  for (const [id, timestamp] of state.recentlyReplayedIds) {
    if (now - timestamp < REPLAY_GRACE_MS) {
      active.add(id);
    }
  }
  return active;
}

export function projectRemoteSnapshot(input: {
  localDocs: Array<Record<string, unknown>>;
  remoteDocs: Array<Record<string, unknown>>;
  pendingEntries: readonly PendingEntry[];
  recentlyReplayedIds: ReadonlySet<string>;
  tableName: string;
  getAliases: (id: string) => Set<string>;
}): Array<Record<string, unknown>> {
  const localById = new Map<string, Record<string, unknown>>();
  for (const doc of input.localDocs) {
    if (typeof doc._id === "string") {
      localById.set(doc._id, doc);
    }
  }

  const dirtyAliasKeys = new Set<string>();
  for (const entry of input.pendingEntries) {
    if (entry.table !== input.tableName) continue;
    const logicalId = extractPendingLogicalId(entry);
    if (!logicalId) continue;
    for (const alias of input.getAliases(logicalId)) {
      dirtyAliasKeys.add(alias);
    }
  }
  for (const id of input.recentlyReplayedIds) {
    for (const alias of input.getAliases(id)) {
      dirtyAliasKeys.add(alias);
    }
  }

  if (dirtyAliasKeys.size === 0) {
    return input.remoteDocs;
  }

  const projected = input.remoteDocs.filter((doc) => {
    const id = doc._id;
    return typeof id !== "string" || !dirtyAliasKeys.has(id);
  });

  const injected = new Set<string>();
  for (const alias of dirtyAliasKeys) {
    const localDoc = localById.get(alias);
    if (!localDoc || typeof localDoc._id !== "string") continue;
    if (injected.has(localDoc._id)) continue;
    projected.push(localDoc);
    injected.add(localDoc._id);
  }

  return projected;
}

function extractPendingLogicalId(entry: PendingEntry): string | null {
  try {
    const localResult = JSON.parse(entry.localResult) as unknown;
    if (typeof localResult === "string") {
      return localResult;
    }

    const args = JSON.parse(entry.args) as Record<string, unknown>;
    if (typeof args.id === "string") return args.id;
    if (typeof args._id === "string") return args._id;
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string" && /(^|[a-zA-Z])Id$/.test(key)) {
        return value;
      }
    }
    return null;
  } catch (error) {
    log.warn("sync: failed to parse pending entry identity", error, {
      ref: entry.ref,
      table: entry.table,
      entryId: entry._id,
    });
    return null;
  }
}

class ReplayLeaseLostError extends Error {
  constructor(entry: PendingEntry) {
    super(
      `[convex-embedded] Lost replay lease for pending entry ${entry._id} (${entry.ref}).`,
    );
    this.name = "ReplayLeaseLostError";
  }
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

function classifyReplayError(
  error: Error,
): "reauthRequired" | "authorizationDenied" | "scopeChanged" | "unknown" {
  const { code, message } = parseErrorMetadata(error);
  const lowered = message.toLowerCase();
  if (code === "UNAUTHENTICATED") return "reauthRequired";
  if (code === "FORBIDDEN") return "authorizationDenied";
  if (
    lowered.includes("unauthenticated") ||
    lowered.includes("invalid token") ||
    lowered.includes("expired token") ||
    lowered.includes("authentication required")
  ) {
    return "reauthRequired";
  }
  if (
    lowered.includes("forbidden") ||
    lowered.includes("not authorized") ||
    lowered.includes("permission denied") ||
    lowered.includes("access denied")
  ) {
    return "authorizationDenied";
  }
  if (
    lowered.includes("scope changed") ||
    lowered.includes("scope mismatch") ||
    lowered.includes("invalid scope")
  ) {
    return "scopeChanged";
  }
  return "unknown";
}

function isAlreadyAppliedReplayError(
  entry: PendingEntry,
  error: Error,
): boolean {
  const { code, message } = parseErrorMetadata(error);
  return (
    entry.ref.endsWith(":remove") &&
    (code === "DOCUMENT_NOT_FOUND" ||
      message.includes("delete on nonexistent document id"))
  );
}

function startReplayLeaseHeartbeat(input: {
  entry: PendingEntry;
  renew: () => Promise<boolean>;
  leaseMs: number;
}): { race<T>(operation: Promise<T>): Promise<T>; stop(): void } {
  const intervalMs = Math.max(1_000, Math.floor(input.leaseMs / 3));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rejectLost!: (error: Error) => void;
  const lost = new Promise<never>((_, reject) => {
    rejectLost = reject;
  });
  lost.catch(() => undefined);

  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = null;
      void (async () => {
        if (stopped) return;
        try {
          const renewed = await input.renew();
          if (stopped) return;
          if (!renewed) {
            stopped = true;
            rejectLost(new ReplayLeaseLostError(input.entry));
            return;
          }
          schedule();
        } catch (error) {
          if (stopped) return;
          stopped = true;
          rejectLost(
            error instanceof Error ? error : new Error(toErrorMessage(error)),
          );
        }
      })();
    }, intervalMs);
  };

  schedule();

  return {
    race<T>(operation: Promise<T>): Promise<T> {
      return Promise.race([operation, lost]);
    },
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    },
  };
}

function getQueueEntryRoute(input: {
  entry: PendingEntry | undefined;
  hasMappedLocalId: (localId: string) => boolean;
  hasActiveLocalDocument: (localId: string) => boolean;
  getRemoteId: (localId: string) => string | null;
  isOnline: boolean;
  signal?: AbortSignal;
}): QueueEntryRoute {
  if (input.entry === undefined || !input.isOnline || input.signal?.aborted) {
    return { _tag: "Stop" };
  }

  let localResult: unknown;
  try {
    localResult = JSON.parse(input.entry.localResult);
  } catch {
    return { _tag: "Stop" };
  }
  const remoteId =
    typeof localResult === "string" ? input.getRemoteId(localResult) : null;
  return input.entry.ref.endsWith(":create") &&
    input.entry.hydrated === true &&
    typeof localResult === "string" &&
    input.hasMappedLocalId(localResult) &&
    !input.hasActiveLocalDocument(localResult) &&
    remoteId !== null &&
    input.hasActiveLocalDocument(remoteId)
    ? { _tag: "DropMappedCreate", localResult }
    : { _tag: "Push", localResult };
}

function isUuidLike(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function gatherCandidateStorageIds(
  value: unknown,
  seen = new Set<string>(),
): Set<string> {
  if (typeof value === "string") {
    if (isUuidLike(value)) seen.add(value);
    return seen;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => gatherCandidateStorageIds(entry, seen));
    return seen;
  }
  if (
    value instanceof ArrayBuffer ||
    value instanceof Uint8Array ||
    value === null ||
    typeof value !== "object"
  ) {
    return seen;
  }
  Object.values(value).forEach((entry) =>
    gatherCandidateStorageIds(entry, seen),
  );
  return seen;
}

async function uploadBlobToRemote(input: {
  remoteClient: ConvexClient;
  uploadUrlRef: unknown;
  blob: Blob;
  contentType?: string;
  uploadFetch?: typeof globalThis.fetch;
}): Promise<string> {
  const uploadUrl = (await (
    input.remoteClient as unknown as RemoteCallable
  ).mutation(input.uploadUrlRef, {})) as string;

  if (typeof uploadUrl !== "string" || uploadUrl.length === 0) {
    throw new Error(
      "[convex-embedded] remote upload URL mutation did not return a URL string.",
    );
  }

  const headers: Record<string, string> = {};
  if (input.contentType) {
    headers["content-type"] = input.contentType;
  }

  const doFetch = input.uploadFetch ?? globalThis.fetch;
  const response = await doFetch(uploadUrl, {
    method: "POST",
    body: input.blob,
    headers,
  });

  const payloadText = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch (parseError) {
    throw new Error(
      `[convex-embedded] remote blob upload returned invalid JSON: ${String(parseError)}`,
    );
  }

  const parsed = payload as {
    storageId?: unknown;
    error?: unknown;
  };

  if (response.status >= 200 && response.status < 300) {
    if (typeof parsed.storageId === "string") {
      return parsed.storageId;
    }
    throw new Error(
      "[convex-embedded] remote blob upload response did not include a storageId.",
    );
  }

  throw new Error(
    typeof parsed.error === "string"
      ? parsed.error
      : `[convex-embedded] remote blob upload failed with status ${response.status}.`,
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

async function gatherUnmappedStorageDependencies(
  deps: ReplayDeps,
  args: Record<string, unknown>,
): Promise<StorageDependency[]> {
  const getStorageBlob = deps.embedded.getStorageBlob?.bind(deps.embedded);
  const getStorageMetadata = deps.embedded.getStorageMetadata?.bind(
    deps.embedded,
  );
  if (!getStorageBlob || !getStorageMetadata) return [];

  const dependencies: StorageDependency[] = [];
  for (const candidate of gatherCandidateStorageIds(args)) {
    if (deps.idMap.getRemoteId(candidate) !== null) continue;

    const metadata = await getStorageMetadata(candidate);
    if (metadata === null) continue;

    const blob = await getStorageBlob(candidate);
    if (blob === null) {
      throw new Error(
        `[convex-embedded] Missing local blob data for storage id ${candidate}.`,
      );
    }

    dependencies.push({
      localStorageId: candidate,
      metadata,
      blob,
    });
  }
  return dependencies;
}

async function ensureRemoteStorageMappings(
  deps: ReplayDeps,
  entry: PendingEntry,
  args: Record<string, unknown>,
): Promise<void> {
  const dependencies = await gatherUnmappedStorageDependencies(deps, args);
  if (dependencies.length === 0) return;

  for (const dependency of dependencies) {
    const dependencyUploadUrlRef =
      typeof dependency.metadata.uploadSourceRef === "string"
        ? dependency.metadata.uploadSourceRef
        : deps.uploadUrlRef;

    if (
      dependencyUploadUrlRef === undefined ||
      dependencyUploadUrlRef === null
    ) {
      throw new Error(
        "[convex-embedded] Pending mutation references local storage blobs but no remote upload URL function is configured or discoverable.",
      );
    }

    const uploadRef =
      typeof dependencyUploadUrlRef === "string"
        ? makeFunctionReference<"mutation">(dependencyUploadUrlRef)
        : dependencyUploadUrlRef;

    const leaseHeld = await deps.pendingQueue.renewLease(
      entry,
      deps.processorId,
      deps.leaseMs,
    );
    if (!leaseHeld) {
      if (entry.hydrated === true) {
        throw new ReplayLeaseLostError(entry);
      }
      log.warn(
        `sync: continuing upload replay for current-session entry after lease renewal miss (${entry._id})`,
      );
    }
    const heartbeat = startReplayLeaseHeartbeat({
      entry,
      renew: () =>
        deps.pendingQueue.renewLease(entry, deps.processorId, deps.leaseMs),
      leaseMs: deps.leaseMs,
    });
    let remoteStorageId: string;
    try {
      remoteStorageId = await heartbeat.race(
        uploadBlobToRemote({
          remoteClient: deps.remoteClient,
          uploadUrlRef: uploadRef,
          blob: dependency.blob,
          contentType:
            typeof dependency.metadata.contentType === "string"
              ? dependency.metadata.contentType
              : dependency.blob.type || undefined,
          uploadFetch: deps.uploadFetch,
        }),
      );
    } finally {
      heartbeat.stop();
    }
    await deps.idMap.set(
      dependency.localStorageId,
      remoteStorageId,
      "_storage",
    );
  }
}

async function cleanupMappedCreateAlias(
  deps: ReplayDeps,
  localId: string,
): Promise<void> {
  if (deps.embedded.hasLocalDocumentId?.(localId) ?? false) return;
  if (!deps.idMap.hasLocalId(localId)) return;
  await deps.idMap.delete(localId);
}

export async function processUploadQueue(
  _state: ReplayState,
  deps: ReplayDeps,
  signal?: AbortSignal,
): Promise<void> {
  const getStorageBlob = deps.embedded.getStorageBlob?.bind(deps.embedded);
  const getStorageMetadata = deps.embedded.getStorageMetadata?.bind(
    deps.embedded,
  );
  if (!getStorageBlob || !getStorageMetadata) return;
  if (deps.uploadUrlRef === undefined || deps.uploadUrlRef === null) {
    return;
  }
  while (true) {
    if (signal?.aborted) return;
    let entry: PendingUploadEntry | undefined;
    try {
      entry = await deps.pendingUploadQueue.claimNext(
        deps.processorId,
        deps.leaseMs,
      );
    } catch (err) {
      log.warn("sync: pending-upload claim failed", err);
      return;
    }
    if (!entry) return;

    try {
      if (deps.idMap.getRemoteId(entry.localStorageId) !== null) {
        await deps.pendingUploadQueue.remove(entry, deps.processorId);
        continue;
      }
      const blob = await getStorageBlob(entry.localStorageId);
      if (blob === null) {
        log.warn(
          `sync: pending-upload missing local blob (storageId: ${entry.localStorageId}); dropping`,
        );
        await deps.pendingUploadQueue.remove(entry, deps.processorId);
        continue;
      }
      const heartbeat = startReplayLeaseHeartbeat({
        entry: entry as unknown as PendingEntry,
        renew: () =>
          deps.pendingUploadQueue.renewLease(
            entry!,
            deps.processorId,
            deps.leaseMs,
          ),
        leaseMs: deps.leaseMs,
      });
      let remoteStorageId: string;
      try {
        const uploadRef =
          typeof deps.uploadUrlRef === "string"
            ? makeFunctionReference<"mutation">(deps.uploadUrlRef)
            : deps.uploadUrlRef;
        remoteStorageId = await heartbeat.race(
          uploadBlobToRemote({
            remoteClient: deps.remoteClient,
            uploadUrlRef: uploadRef,
            blob,
            contentType: entry.contentType,
            uploadFetch: deps.uploadFetch,
          }),
        );
      } finally {
        heartbeat.stop();
      }
      await deps.idMap.set(entry.localStorageId, remoteStorageId, "_storage");
      await deps.pendingUploadQueue.remove(entry, deps.processorId);
    } catch (err) {
      log.warn(
        `sync: pending-upload failed (storageId: ${entry.localStorageId}); will retry next cycle`,
        err,
      );
      try {
        await deps.pendingUploadQueue.release(entry, deps.processorId);
      } catch (releaseErr) {
        log.warn("sync: failed to release upload queue entry", releaseErr);
      }
      return;
    }
  }
}

export async function processQueue(
  state: ReplayState,
  deps: ReplayDeps,
  signal?: AbortSignal,
): Promise<Set<string>> {
  if (state.inFlight) {
    state.requestedWhileActive = true;
    return state.inFlight;
  }
  if (deps.pendingQueue.isEmpty) {
    await deps.pendingQueue.hydrate();
  }
  if (deps.pendingQueue.isEmpty) return new Set();

  const deadLetteredTables = new Set<string>();

  log.info(`sync: processing ${deps.pendingQueue.length} queued mutation(s)`);

  const canonicalizeMappedCreate =
    deps.embedded.canonicalizeMappedCreate?.bind(deps.embedded) ??
    (async () => {
      throw new Error(
        "[convex-embedded] Embedded client is missing canonicalizeMappedCreate().",
      );
    });

  const cyclePromise = (async () => {
    try {
      outer: while (deps.isOnline() && !signal?.aborted) {
        state.requestedWhileActive = false;
        while (
          !deps.pendingQueue.isEmpty &&
          deps.isOnline() &&
          !signal?.aborted
        ) {
          const entry = await deps.pendingQueue.claimNext(
            deps.processorId,
            deps.leaseMs,
            deps.leaseMs,
          );
          if (!entry) break;
          state.activeEntry = entry;
          if (entry.state === "blocked") {
            log.warn(
              `sync: blocked pending entry for ${entry.ref}; halting replay`,
            );
            break outer;
          }

          const replayDocId = extractPendingLogicalId(entry);
          const route = getQueueEntryRoute({
            entry,
            hasMappedLocalId: (localId: string) =>
              deps.idMap.hasLocalId(localId),
            hasActiveLocalDocument: (localId: string) =>
              deps.embedded.hasLocalDocumentId?.(localId) ?? false,
            getRemoteId: (localId: string) => deps.idMap.getRemoteId(localId),
            isOnline: deps.isOnline(),
            signal,
          });
          await runSpan({
            name: "convex_embedded.replay.route_decision",
            attributes: {
              "replay.route": route._tag,
              "replay.ref": entry.ref,
              "replay.table": entry.table,
              "replay.hydrated": entry.hydrated === true,
            },
            run: async () => undefined,
          });

          if (route._tag === "Stop") break;
          if (route._tag === "DropMappedCreate") {
            await deps.pendingQueue.remove(entry, deps.processorId);
            if (replayDocId) addRecentlyReplayed(state, replayDocId);
            await cleanupMappedCreateAlias(deps, route.localResult);
            log.debug(
              `sync: dropping already-mapped create mutation (remaining: ${deps.pendingQueue.length})`,
            );
            recordCounter("replay.outcome", { result: "drop_mapped" });
            continue;
          }
          if (route._tag !== "Push") break;

          try {
            const ref = makeFunctionReference<"mutation">(entry.ref);
            const originalArgs = JSON.parse(entry.args) as Record<
              string,
              unknown
            >;
            await ensureRemoteStorageMappings(deps, entry, originalArgs);
            const translatedArgs = deps.idMap.translateArgs(originalArgs);
            const leaseHeld = await deps.pendingQueue.renewLease(
              entry,
              deps.processorId,
              deps.leaseMs,
            );
            if (!leaseHeld) {
              if (entry.hydrated === true) {
                state.activeEntry = null;
                log.warn(
                  `sync: lost replay lease before remote push (table: ${entry.table})`,
                );
                break;
              }
              log.warn(
                `sync: continuing replay for current-session entry after lease renewal miss (table: ${entry.table})`,
              );
            }

            const heartbeat = startReplayLeaseHeartbeat({
              entry,
              renew: () =>
                deps.pendingQueue.renewLease(
                  entry,
                  deps.processorId,
                  deps.leaseMs,
                ),
              leaseMs: deps.leaseMs,
            });
            let remoteResult: unknown;
            try {
              remoteResult = await heartbeat.race(
                (deps.remoteClient as unknown as RemoteCallable).mutation(
                  ref,
                  translatedArgs,
                ),
              );
            } finally {
              heartbeat.stop();
            }

            pull.recordExpectedSelfCausedSignal(
              deps.pullState,
              entry.table,
              pull.nextExpectedSelfCausedSeq(deps.pullState, entry.table),
            );

            if (
              typeof route.localResult === "string" &&
              typeof remoteResult === "string" &&
              route.localResult !== remoteResult
            ) {
              await canonicalizeMappedCreate({
                localId: route.localResult,
                remoteId: remoteResult,
                tableName: entry.table,
                schemas: deps.tableSchemas,
              });
              await deps.idMap.set(
                route.localResult,
                remoteResult,
                entry.table,
              );
            }
            await deps.pendingQueue.remove(entry, deps.processorId);
            if (replayDocId) addRecentlyReplayed(state, replayDocId);
            state.activeEntry = null;
            log.debug(
              `sync: pushed mutation to remote (table: ${entry.table}, remaining: ${deps.pendingQueue.length})`,
            );
            recordCounter("replay.outcome", {
              result: "success",
              "convex.table": entry.table,
            });
          } catch (err) {
            if (isAlreadyAppliedReplayError(entry, err as Error)) {
              await deps.pendingQueue.remove(entry, deps.processorId);
              if (replayDocId) addRecentlyReplayed(state, replayDocId);
              state.activeEntry = null;
              log.debug(
                `sync: dropping already-applied mutation (table: ${entry.table}, remaining: ${deps.pendingQueue.length})`,
              );
              recordCounter("replay.outcome", {
                result: "drop_already_applied",
                "convex.table": entry.table,
              });
              continue;
            }
            if (err instanceof ReplayLeaseLostError) {
              state.activeEntry = null;
              log.warn(`sync: replay lease lost while processing ${entry.ref}`);
              recordCounter("replay.outcome", {
                result: "lease_lost",
                "convex.table": entry.table,
              });
              break;
            }
            const reason = classifyReplayError(err as Error);
            if (reason !== "unknown") {
              await deps.pendingQueue.block(entry, reason);
              state.activeEntry = null;
              recordCounter("replay.outcome", {
                result: "blocked",
                reason,
                "convex.table": entry.table,
              });
              break;
            }
            entry.retryCount = (entry.retryCount ?? 0) + 1;
            if (entry.retryCount >= MAX_REPLAY_RETRIES) {
              log.error(
                `sync: mutation exceeded max retries (${MAX_REPLAY_RETRIES}), dead-lettering (table: ${entry.table}, ref: ${entry.ref})`,
                err,
              );
              await deps.pendingQueue.remove(entry, deps.processorId);
              deadLetteredTables.add(entry.table);
              state.activeEntry = null;
              recordCounter("replay.outcome", {
                result: "dead_letter",
                "convex.table": entry.table,
              });
            } else {
              log.warn(
                `sync: remote push failed (attempt ${entry.retryCount}/${MAX_REPLAY_RETRIES}), releasing (table: ${entry.table})`,
                err,
              );
              await deps.pendingQueue.release(entry, deps.processorId);
              state.activeEntry = null;
              recordCounter("replay.outcome", {
                result: "released",
                "convex.table": entry.table,
              });
            }
            break;
          }
        }
        if (
          !state.requestedWhileActive ||
          deps.pendingQueue.isEmpty ||
          !deps.isOnline() ||
          signal?.aborted
        ) {
          break;
        }
        log.debug(
          `sync: continuing queue processing after concurrent enqueue (remaining: ${deps.pendingQueue.length})`,
        );
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        log.error("sync: unhandled error in queue processing loop", err);
      }
    }
    return deadLetteredTables;
  })().finally(() => {
    state.inFlight = null;
  });
  state.inFlight = cyclePromise;

  const result = await cyclePromise;

  if (deps.pendingQueue.isEmpty) {
    log.info("sync: queue fully processed");
  }
  return result ?? new Set();
}

export async function rollbackDeadLetteredTables(
  _state: ReplayState,
  deps: ReplayDeps,
  tablesToRollback: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  if (tablesToRollback.size === 0) return;
  log.info(
    `sync: rolling back dead-lettered tables: ${[...tablesToRollback].join(", ")}`,
  );
  for (const tableName of tablesToRollback) {
    if (signal?.aborted) break;
    const tableConfig = deps.tables[tableName];
    if (!tableConfig) continue;
    try {
      await deps.pullTable(tableName, tableConfig, signal);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") break;
      log.error(`sync: rollback resolve failed for table "${tableName}"`, err);
    }
  }
}

export function ensureProcessing(state: ReplayState, deps: ReplayDeps): void {
  if (!deps.isOnline()) return;
  const hasPendingMutation = !deps.pendingQueue.isEmpty;
  const hasPendingUpload = deps.pendingUploadQueue.length > 0;
  if (!hasPendingMutation && !hasPendingUpload) return;

  runDetached(async () => {
    await processUploadQueue(state, deps);
    const deadLettered = await processQueue(state, deps);
    await rollbackDeadLetteredTables(state, deps, deadLettered);

    if (deps.pendingQueue.isEmpty) {
      deps.softResetSubsBuffers();
      if (!deps.hasActiveSubs() && deps.isStarted()) {
        void deps.runScheduler();
      }
      return;
    }

    deps.stopRemoteSubscriptions();
  }, "[sync] ensureReplayProcessing:");
}
