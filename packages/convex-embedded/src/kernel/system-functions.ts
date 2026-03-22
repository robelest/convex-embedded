/**
 * Auto-registered system functions for internal use.
 *
 * These functions are registered at runtime construction and bypass the
 * module loader entirely. They operate directly on the {@link Database}
 * within a transaction managed by the caller.
 *
 * Path convention: `_system:<functionName>` (e.g. `_system:idMapSet`).
 * The `_system` prefix is reserved and must never collide with user modules.
 *
 * System functions support two categories:
 *
 * **ID Map (`_resolve_id_map` table)**
 * Maps local embedded UUIDs to remote Convex IDs so the monitor can
 * translate IDs when forwarding mutations to the remote backend.
 *
 * **Pending Queue (`_resolve_pending` table)**
 * Persists queued mutations so they survive page reloads. The monitor
 * hydrates this queue on startup and replays entries to the remote.
 *
 * @packageDocumentation
 */

import type { Database } from "@/core/database";
import type { DocumentId, StoredDocument } from "@/core/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A system function receives the database and args, returns a result. */
export type SystemFn = (db: Database, args: Record<string, unknown>) => unknown;

/** System function descriptor with type and handler. */
export interface SystemFunctionDef {
  type: "query" | "mutation";
  handler: SystemFn;
}

function matchesIdentityKey(
  value: { identityKey?: string | null },
  identityKey: string | null,
): boolean {
  return (value.identityKey ?? null) === identityKey;
}

// ---------------------------------------------------------------------------
// ID Map functions (_resolve_id_map table)
// ---------------------------------------------------------------------------

/**
 * Insert or update an ID mapping.
 *
 * Args: `{ localId: string, remoteId: string, table: string }`
 */
const idMapSet: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { localId, remoteId, table, identityKey } = args as {
      localId: string;
      remoteId: string;
      table: string;
      identityKey?: string | null;
    };

    // Check if a mapping already exists for this localId.
    let existingId: DocumentId | null = null;
    const qid = db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_resolve_id_map",
        order: null,
      },
      operators: [],
    });
    let next = db.queryNext(qid);
    while (!next.done) {
      if (
        next.value &&
        (next.value as any).localId === localId &&
        matchesIdentityKey(next.value as any, identityKey ?? null)
      ) {
        existingId = next.value._id as DocumentId;
        break;
      }
      next = db.queryNext(qid);
    }
    db.queryCleanup(qid);

    if (existingId !== null) {
      db.patch("_resolve_id_map", existingId, {
        remoteId,
        table,
        identityKey: identityKey ?? null,
      });
    } else {
      db.insert("_resolve_id_map", {
        localId,
        remoteId,
        table,
        identityKey: identityKey ?? null,
      });
    }

    return null;
  },
};

/**
 * Look up a remote ID by local ID.
 *
 * Args: `{ localId: string }`
 * Returns: `string | null`
 */
const idMapGet: SystemFunctionDef = {
  type: "query",
  handler: (db, args) => {
    const { localId, identityKey } = args as {
      localId: string;
      identityKey?: string | null;
    };

    const qid = db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_resolve_id_map",
        order: null,
      },
      operators: [],
    });
    let next = db.queryNext(qid);
    while (!next.done) {
      if (
        next.value &&
        (next.value as any).localId === localId &&
        matchesIdentityKey(next.value as any, identityKey ?? null)
      ) {
        db.queryCleanup(qid);
        return (next.value as any).remoteId as string;
      }
      next = db.queryNext(qid);
    }
    db.queryCleanup(qid);
    return null;
  },
};

/**
 * Return all ID mappings.
 *
 * Args: `{}`
 * Returns: `Array<{ localId: string, remoteId: string, table: string }>`
 */
const idMapGetAll: SystemFunctionDef = {
  type: "query",
  handler: (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    const results: Array<{
      localId: string;
      remoteId: string;
      table: string;
      identityKey?: string;
    }> = [];

    const qid = db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_resolve_id_map",
        order: null,
      },
      operators: [],
    });
    let next = db.queryNext(qid);
    while (!next.done) {
      if (next.value) {
        const doc = next.value as StoredDocument & {
          localId: string;
          remoteId: string;
          table: string;
          identityKey?: string | null;
        };
        if (!matchesIdentityKey(doc, identityKey ?? null)) {
          next = db.queryNext(qid);
          continue;
        }
        results.push({
          localId: doc.localId,
          remoteId: doc.remoteId,
          table: doc.table,
          identityKey: doc.identityKey ?? undefined,
        });
      }
      next = db.queryNext(qid);
    }
    db.queryCleanup(qid);
    return results;
  },
};

/**
 * Delete a mapping by localId.
 *
 * Args: `{ localId: string }`
 */
const idMapDelete: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { localId, identityKey } = args as {
      localId: string;
      identityKey?: string | null;
    };

    const qid = db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_resolve_id_map",
        order: null,
      },
      operators: [],
    });
    let next = db.queryNext(qid);
    while (!next.done) {
      if (
        next.value &&
        (next.value as any).localId === localId &&
        matchesIdentityKey(next.value as any, identityKey ?? null)
      ) {
        db.delete("_resolve_id_map", next.value._id as DocumentId);
        db.queryCleanup(qid);
        return null;
      }
      next = db.queryNext(qid);
    }
    db.queryCleanup(qid);
    return null;
  },
};

// ---------------------------------------------------------------------------
// Pending Queue functions (_resolve_pending table)
// ---------------------------------------------------------------------------

/**
 * Append a mutation to the pending queue.
 *
 * Args: `{ ref: string, args: string, localResult: string, table: string }`
 * All values are JSON-serialized strings for safe storage.
 * Returns: the document ID of the queue entry.
 */
const pendingPush: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const {
      ref,
      args: mutArgs,
      localResult,
      table,
      identityKey,
    } = args as {
      ref: string;
      args: string;
      localResult: string;
      table: string;
      identityKey?: string | null;
    };
    const id = db.insert("_resolve_pending", {
      ref,
      args: mutArgs,
      localResult,
      table,
      identityKey: identityKey ?? null,
      createdAt: Date.now(),
    });
    return id as string;
  },
};

/**
 * Return all pending mutations, ordered by _creationTime.
 *
 * Args: `{}`
 * Returns: `Array<{ _id, ref, args, localResult, table, createdAt }>`
 */
const pendingGetAll: SystemFunctionDef = {
  type: "query",
  handler: (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    const results: Array<Record<string, unknown>> = [];

    const qid = db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_resolve_pending",
        order: "asc",
      },
      operators: [],
    });
    let next = db.queryNext(qid);
    while (!next.done) {
      if (next.value) {
        if (!matchesIdentityKey(next.value as any, identityKey ?? null)) {
          next = db.queryNext(qid);
          continue;
        }
        results.push({
          _id: next.value._id,
          ref: (next.value as any).ref,
          args: (next.value as any).args,
          localResult: (next.value as any).localResult,
          table: (next.value as any).table,
          identityKey: (next.value as any).identityKey,
          createdAt: (next.value as any).createdAt,
        });
      }
      next = db.queryNext(qid);
    }
    db.queryCleanup(qid);

    // Sort by _creationTime to preserve insertion order.
    results.sort(
      (a, b) =>
        ((a._creationTime as number) ?? 0) - ((b._creationTime as number) ?? 0),
    );

    return results;
  },
};

/**
 * Remove a specific pending mutation by document ID.
 *
 * Args: `{ id: string }`
 */
const pendingRemove: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { id } = args as { id: string };
    const doc = db.get("_resolve_pending", id as DocumentId);
    if (doc !== null) {
      db.delete("_resolve_pending", id as DocumentId);
    }
    return null;
  },
};

/**
 * Clear all pending mutations.
 *
 * Args: `{}`
 */
const pendingClear: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    const ids: DocumentId[] = [];
    const qid = db.startQuery({
      source: {
        type: "FullTableScan",
        tableName: "_resolve_pending",
        order: null,
      },
      operators: [],
    });
    let next = db.queryNext(qid);
    while (!next.done) {
      if (next.value) {
        if (!matchesIdentityKey(next.value as any, identityKey ?? null)) {
          next = db.queryNext(qid);
          continue;
        }
        ids.push(next.value._id as DocumentId);
      }
      next = db.queryNext(qid);
    }
    db.queryCleanup(qid);

    for (const id of ids) {
      db.delete("_resolve_pending", id);
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All auto-registered system functions.
 *
 * Keys are the full UDF paths (e.g. `"_system:idMapSet"`).
 * The runtime registers these at construction time.
 */
/**
 * All auto-registered system functions.
 *
 * Keys are the full UDF paths (e.g. `"_system:idMapSet"`).
 * The runtime registers these at construction time.
 */
export const SYSTEM_FUNCTIONS: Record<string, SystemFunctionDef> = {
  "_system:idMapSet": idMapSet,
  "_system:idMapGet": idMapGet,
  "_system:idMapGetAll": idMapGetAll,
  "_system:idMapDelete": idMapDelete,
  "_system:pendingPush": pendingPush,
  "_system:pendingGetAll": pendingGetAll,
  "_system:pendingRemove": pendingRemove,
  "_system:pendingClear": pendingClear,
};

/**
 * System function path constants for use by external consumers
 * (e.g. the monitor in convex-resolve).
 */
export const SystemPaths = {
  idMapSet: "_system:idMapSet",
  idMapGet: "_system:idMapGet",
  idMapGetAll: "_system:idMapGetAll",
  idMapDelete: "_system:idMapDelete",
  pendingPush: "_system:pendingPush",
  pendingGetAll: "_system:pendingGetAll",
  pendingRemove: "_system:pendingRemove",
  pendingClear: "_system:pendingClear",
} as const;
