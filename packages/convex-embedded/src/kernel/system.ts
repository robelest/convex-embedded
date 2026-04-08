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
 * Maps local embedded UUIDs to remote Convex IDs so the sync engine can
 * translate IDs when forwarding mutations to the remote backend.
 *
 * **Pending Queue (`_resolve_pending` table)**
 * Persists queued mutations so they survive page reloads. The sync engine
 * hydrates this queue on startup and replays entries to the remote.
 *
 * @packageDocumentation
 */

import type { Database } from "@/runtime/db/database";
import type { DocumentId, StoredDocument } from "@/runtime/db/types";

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

function readActiveAuthState(
  db: Database,
): (StoredDocument & { activeIdentityKey?: string | null }) | null {
  const qid = db.startQuery({
    source: {
      type: "FullTableScan",
      tableName: "_resolve_auth_state",
      order: null,
    },
    operators: [],
  });
  const next = db.queryNext(qid);
  db.queryCleanup(qid);
  return next.done || !next.value
    ? null
    : (next.value as StoredDocument & { activeIdentityKey?: string | null });
}

function firstByIndex(
  db: Database,
  tableName: string,
  indexName: string,
  range: Array<{
    type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
    fieldPath: string;
    value: unknown;
  }>,
): StoredDocument | null {
  const qid = db.startQuery({
    source: {
      type: "IndexRange",
      indexName: `${tableName}.${indexName}`,
      range: range as never,
      order: "asc",
    } as never,
    operators: [{ limit: 1 }],
  });
  const next = db.queryNext(qid);
  db.queryCleanup(qid);
  return next.done ? null : (next.value as StoredDocument);
}

function readPendingById(
  db: Database,
  id: string,
): (StoredDocument & { owner?: string; state?: string }) | null {
  if (db.getTableForId(id) !== "_resolve_pending") {
    return null;
  }

  return db.get("_resolve_pending", id as DocumentId) as
    | (StoredDocument & { owner?: string; state?: string })
    | null;
}

function allByIndex(
  db: Database,
  tableName: string,
  indexName: string,
  range: Array<{
    type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
    fieldPath: string;
    value: unknown;
  }>,
): StoredDocument[] {
  const qid = db.startQuery({
    source: {
      type: "IndexRange",
      indexName: `${tableName}.${indexName}`,
      range: range as never,
      order: "asc",
    } as never,
    operators: [],
  });
  const results: StoredDocument[] = [];
  let next = db.queryNext(qid);
  while (!next.done) {
    if (next.value) {
      results.push(next.value as StoredDocument);
    }
    next = db.queryNext(qid);
  }
  db.queryCleanup(qid);
  return results;
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

    const existing = firstByIndex(
      db,
      "_resolve_id_map",
      "by_identity_key_and_local_id",
      [
        { type: "Eq", fieldPath: "identityKey", value: identityKey ?? null },
        { type: "Eq", fieldPath: "localId", value: localId },
      ],
    );

    if (existing !== null) {
      db.patch("_resolve_id_map", existing._id as DocumentId, {
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

    return (
      (
        firstByIndex(db, "_resolve_id_map", "by_identity_key_and_local_id", [
          { type: "Eq", fieldPath: "identityKey", value: identityKey ?? null },
          { type: "Eq", fieldPath: "localId", value: localId },
        ]) as any
      )?.remoteId ?? null
    );
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

    for (const doc of allByIndex(
      db,
      "_resolve_id_map",
      "by_identity_key_and_local_id",
      [{ type: "Eq", fieldPath: "identityKey", value: identityKey ?? null }],
    )) {
      results.push({
        localId: (doc as any).localId,
        remoteId: (doc as any).remoteId,
        table: (doc as any).table,
        identityKey: (doc as any).identityKey ?? undefined,
      });
    }
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

    const existing = firstByIndex(
      db,
      "_resolve_id_map",
      "by_identity_key_and_local_id",
      [
        { type: "Eq", fieldPath: "identityKey", value: identityKey ?? null },
        { type: "Eq", fieldPath: "localId", value: localId },
      ],
    );
    if (existing) {
      db.delete("_resolve_id_map", existing._id as DocumentId);
    }
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
      payloadVersion,
      identityKey,
      state,
    } = args as {
      ref: string;
      args: string;
      localResult: string;
      table: string;
      payloadVersion?: number;
      identityKey?: string | null;
      state?: "pending" | "blocked";
    };
    const id = db.insert("_resolve_pending", {
      ref,
      args: mutArgs,
      localResult,
      table,
      payloadVersion: payloadVersion ?? 1,
      identityKey: identityKey ?? null,
      state: state ?? "pending",
      owner: { $undefined: true },
      processingStartedAt: { $undefined: true },
      leaseExpiresAt: { $undefined: true },
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
    return allByIndex(
      db,
      "_resolve_pending",
      "by_identity_key_and_creation_time",
      [{ type: "Eq", fieldPath: "identityKey", value: identityKey ?? null }],
    ).map((doc) => ({
      _id: doc._id,
      ref: (doc as any).ref,
      args: (doc as any).args,
      localResult: (doc as any).localResult,
      table: (doc as any).table,
      payloadVersion: (doc as any).payloadVersion,
      identityKey: (doc as any).identityKey,
      state: (doc as any).state,
      owner: (doc as any).owner,
      processingStartedAt: (doc as any).processingStartedAt,
      leaseExpiresAt: (doc as any).leaseExpiresAt,
      blockedReason: (doc as any).blockedReason,
      createdAt: (doc as any).createdAt,
    }));
  },
};

const pendingClaimNext: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { identityKey, owner, leaseMs } = args as {
      identityKey?: string | null;
      owner: string;
      leaseMs?: number;
    };
    const now = Date.now();
    const expiresAt = now + (leaseMs ?? 30_000);

    for (const doc of allByIndex(
      db,
      "_resolve_pending",
      "by_identity_key_and_creation_time",
      [{ type: "Eq", fieldPath: "identityKey", value: identityKey ?? null }],
    )) {
      const state = (doc as { state?: string }).state ?? "pending";
      const leaseExpiresAt = (doc as { leaseExpiresAt?: number })
        .leaseExpiresAt;
      const claimable =
        state === "pending" ||
        (state === "processing" &&
          typeof leaseExpiresAt === "number" &&
          leaseExpiresAt <= now);
      if (!claimable) {
        continue;
      }

      db.patch("_resolve_pending", doc._id as DocumentId, {
        state: "processing",
        owner,
        processingStartedAt: now,
        leaseExpiresAt: expiresAt,
        blockedReason: { $undefined: true },
      });

      const claimed = db.get("_resolve_pending", doc._id as DocumentId) as
        | (StoredDocument & {
            ref?: string;
            args?: string;
            localResult?: string;
            table?: string;
            payloadVersion?: number;
            identityKey?: string | null;
            state?: string;
            owner?: string;
            processingStartedAt?: number;
            leaseExpiresAt?: number;
            blockedReason?: string;
            createdAt?: number;
          })
        | null;
      if (!claimed) {
        return null;
      }

      return {
        _id: claimed._id,
        ref: claimed.ref,
        args: claimed.args,
        localResult: claimed.localResult,
        table: claimed.table,
        payloadVersion: claimed.payloadVersion,
        identityKey: claimed.identityKey,
        state: claimed.state,
        owner: claimed.owner,
        processingStartedAt: claimed.processingStartedAt,
        leaseExpiresAt: claimed.leaseExpiresAt,
        blockedReason: claimed.blockedReason,
        createdAt: claimed.createdAt,
      };
    }

    return null;
  },
};

const pendingRenewLease: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { id, owner, leaseMs } = args as {
      id: string;
      owner: string;
      leaseMs?: number;
    };
    const doc = readPendingById(db, id);
    if (
      doc !== null &&
      ((doc.owner === owner && doc.state === "processing") ||
        ((doc.owner === undefined || doc.owner === null) &&
          (doc.state === undefined || doc.state === "pending")))
    ) {
      db.patch("_resolve_pending", id as DocumentId, {
        state: "processing",
        owner,
        leaseExpiresAt: Date.now() + (leaseMs ?? 30_000),
      });
      return true;
    }
    return false;
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
    const { id, owner } = args as { id: string; owner?: string };
    const doc = readPendingById(db, id);
    if (doc !== null && (owner === undefined || doc.owner === owner)) {
      db.delete("_resolve_pending", id as DocumentId);
    }
    return null;
  },
};

const pendingRelease: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { id, owner } = args as { id: string; owner?: string };
    const doc = readPendingById(db, id);
    if (doc !== null && (owner === undefined || doc.owner === owner)) {
      db.patch("_resolve_pending", id as DocumentId, {
        state: "pending",
        owner: { $undefined: true },
        processingStartedAt: { $undefined: true },
        leaseExpiresAt: { $undefined: true },
        blockedReason: { $undefined: true },
      });
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
    for (const doc of allByIndex(
      db,
      "_resolve_pending",
      "by_identity_key_and_creation_time",
      [{ type: "Eq", fieldPath: "identityKey", value: identityKey ?? null }],
    )) {
      db.delete("_resolve_pending", doc._id as DocumentId);
    }
    return null;
  },
};

const pendingBlock: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { id, reason } = args as {
      id: string;
      reason: "reauthRequired" | "authorizationDenied" | "scopeChanged";
    };
    const doc = readPendingById(db, id);
    if (doc !== null) {
      db.patch("_resolve_pending", id as DocumentId, {
        state: "blocked",
        owner: { $undefined: true },
        processingStartedAt: { $undefined: true },
        leaseExpiresAt: { $undefined: true },
        blockedReason: reason,
      });
    }
    return null;
  },
};

const pendingUnblockAll: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    for (const doc of allByIndex(
      db,
      "_resolve_pending",
      "by_identity_key_and_creation_time",
      [{ type: "Eq", fieldPath: "identityKey", value: identityKey ?? null }],
    )) {
      db.patch("_resolve_pending", doc._id as DocumentId, {
        state: "pending",
        owner: { $undefined: true },
        processingStartedAt: { $undefined: true },
        leaseExpiresAt: { $undefined: true },
        blockedReason: { $undefined: true },
      });
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Auth state functions (_resolve_auth_state table)
// ---------------------------------------------------------------------------

const authStateSetActive: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { activeIdentityKey } = args as {
      activeIdentityKey?: string | null;
    };

    const existing = readActiveAuthState(db);
    if (existing) {
      db.patch("_resolve_auth_state", existing._id as DocumentId, {
        activeIdentityKey: activeIdentityKey ?? null,
        updatedAt: Date.now(),
      });
    } else {
      db.insert("_resolve_auth_state", {
        activeIdentityKey: activeIdentityKey ?? null,
        updatedAt: Date.now(),
      });
    }

    return null;
  },
};

const authStateGetActive: SystemFunctionDef = {
  type: "query",
  handler: (db) => {
    const existing = readActiveAuthState(db);
    return existing?.activeIdentityKey ?? null;
  },
};

const pendingListIdentityKeys: SystemFunctionDef = {
  type: "query",
  handler: (db) => {
    const keys = new Set<string>();
    for (const doc of db.getDocumentsForTable("_resolve_pending")) {
      const identityKey = (doc as { identityKey?: string | null }).identityKey;
      if (identityKey) {
        keys.add(identityKey);
      }
    }
    return Array.from(keys.values()).sort();
  },
};

const identityMoveAnonymousToIdentity: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { identityKey } = args as { identityKey: string };

    for (const tableName of ["_resolve_id_map", "_resolve_pending"] as const) {
      const indexName =
        tableName === "_resolve_id_map"
          ? "by_identity_key_and_local_id"
          : "by_identity_key_and_creation_time";
      for (const doc of allByIndex(db, tableName, indexName, [
        { type: "Eq", fieldPath: "identityKey", value: null },
      ])) {
        db.patch(tableName, doc._id as DocumentId, { identityKey });
      }
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
  "_system:pendingClaimNext": pendingClaimNext,
  "_system:pendingRenewLease": pendingRenewLease,
  "_system:pendingRemove": pendingRemove,
  "_system:pendingRelease": pendingRelease,
  "_system:pendingClear": pendingClear,
  "_system:pendingBlock": pendingBlock,
  "_system:pendingUnblockAll": pendingUnblockAll,
  "_system:authStateSetActive": authStateSetActive,
  "_system:authStateGetActive": authStateGetActive,
  "_system:pendingListIdentityKeys": pendingListIdentityKeys,
  "_system:identityMoveAnonymousToIdentity": identityMoveAnonymousToIdentity,
};

/**
 * System function path constants for use by external consumers
 * (for example, the embedded sync engine).
 */
export const SystemPaths = {
  idMapSet: "_system:idMapSet",
  idMapGet: "_system:idMapGet",
  idMapGetAll: "_system:idMapGetAll",
  idMapDelete: "_system:idMapDelete",
  pendingPush: "_system:pendingPush",
  pendingGetAll: "_system:pendingGetAll",
  pendingClaimNext: "_system:pendingClaimNext",
  pendingRenewLease: "_system:pendingRenewLease",
  pendingRemove: "_system:pendingRemove",
  pendingRelease: "_system:pendingRelease",
  pendingClear: "_system:pendingClear",
  pendingBlock: "_system:pendingBlock",
  pendingUnblockAll: "_system:pendingUnblockAll",
  authStateSetActive: "_system:authStateSetActive",
  authStateGetActive: "_system:authStateGetActive",
  pendingListIdentityKeys: "_system:pendingListIdentityKeys",
  identityMoveAnonymousToIdentity: "_system:identityMoveAnonymousToIdentity",
} as const;
