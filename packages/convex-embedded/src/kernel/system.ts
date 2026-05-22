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
 * hydrates this queue on load and replays entries to the remote.
 *
 * @packageDocumentation
 */

import type { Database } from "@/runtime/db/database";
import type { DocumentId, StoredDocument } from "@/runtime/db/types";

/** A system function receives the database and args, returns a result. */
export type SystemFn = (db: Database, args: Record<string, unknown>) => unknown;

/** System function descriptor with type and handler. */
export interface SystemFunctionDef {
  type: "query" | "mutation";
  handler: SystemFn;
}

interface IdMapRow {
  _id: DocumentId;
  localId: string;
  remoteId: string;
  table: string;
  identityKey?: string | null;
}

interface PendingRow {
  _id: DocumentId;
  ref: string;
  args: string;
  localResult: string;
  table: string;
  payloadVersion?: number;
  identityKey?: string | null;
  state?: string;
  owner?: string;
  processingStartedAt?: number;
  leaseExpiresAt?: number;
  blockedReason?: string;
  createdAt?: number;
}

interface PendingUploadRow {
  _id: DocumentId;
  localStorageId: string;
  sha256: string;
  size: number;
  contentType: string;
  identityKey?: string | null;
  state?: string;
  owner?: string;
  processingStartedAt?: number;
  leaseExpiresAt?: number;
  createdAt?: number;
}

interface DocumentMetadataRow {
  _id: DocumentId;
  collection: string;
  docId: string;
  seq: number;
  identityKey?: string | null;
  schemaVersion?: number;
}

const AUTH_STATE_DOCUMENT_ID = "auth_state" as DocumentId;

async function readActiveAuthState(
  db: Database,
): Promise<(StoredDocument & { activeIdentityKey?: string | null }) | null> {
  const singleton = (await db.getAsync(
    "_resolve_auth_state",
    AUTH_STATE_DOCUMENT_ID,
  )) as (StoredDocument & { activeIdentityKey?: string | null }) | null;
  if (singleton !== null) {
    return singleton;
  }
  const rows = await db.listDocumentsAsync("_resolve_auth_state");
  const first = rows[0] ?? null;
  return first as
    | (StoredDocument & { activeIdentityKey?: string | null })
    | null;
}

async function firstByIndex<T = StoredDocument>(
  db: Database,
  tableName: string,
  indexName: string,
  range: Array<{
    type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
    fieldPath: string;
    value: unknown;
  }>,
): Promise<T | null> {
  const qid = db.startQueryAsync({
    source: {
      type: "IndexRange",
      indexName: `${tableName}.${indexName}`,
      range: range as never,
      order: "asc",
    } as never,
    operators: [{ limit: 1 }],
  });
  const next = await db.queryNextAsync(qid);
  db.queryCleanup(qid);
  return next.done ? null : (next.value as T);
}

async function readPendingById(
  db: Database,
  id: string,
): Promise<(StoredDocument & { owner?: string; state?: string }) | null> {
  if (db.getTableForId(id) !== "_resolve_pending") {
    return null;
  }

  return (await db.getAsync("_resolve_pending", id as DocumentId)) as
    | (StoredDocument & { owner?: string; state?: string })
    | null;
}

async function readProcessor(
  db: Database,
  identityKey: string | null,
  processorId: string,
): Promise<(StoredDocument & { lastSeenAt?: number }) | null> {
  return (await firstByIndex(
    db,
    "_resolve_processors",
    "by_identity_key_and_processor_id",
    [
      { type: "Eq", fieldPath: "identityKey", value: identityKey },
      { type: "Eq", fieldPath: "processorId", value: processorId },
    ],
  )) as (StoredDocument & { lastSeenAt?: number }) | null;
}

async function readCollectionMetadata(
  db: Database,
  input: {
    identityKey: string | null;
    collection: string;
    schemaVersion: number;
  },
): Promise<StoredDocument | null> {
  return firstByIndex(
    db,
    "_resolve_collection_metadata",
    "by_identity_key_and_collection",
    [
      { type: "Eq", fieldPath: "identityKey", value: input.identityKey },
      { type: "Eq", fieldPath: "collection", value: input.collection },
      { type: "Eq", fieldPath: "schemaVersion", value: input.schemaVersion },
    ],
  );
}

async function readDocumentMetadata(
  db: Database,
  input: {
    identityKey: string | null;
    collection: string;
    docId: string;
    schemaVersion: number;
  },
): Promise<StoredDocument | null> {
  return firstByIndex(
    db,
    "_resolve_document_metadata",
    "by_identity_key_and_collection_and_doc_id",
    [
      { type: "Eq", fieldPath: "identityKey", value: input.identityKey },
      { type: "Eq", fieldPath: "collection", value: input.collection },
      { type: "Eq", fieldPath: "docId", value: input.docId },
      { type: "Eq", fieldPath: "schemaVersion", value: input.schemaVersion },
    ],
  );
}

async function allByIndex<T = StoredDocument>(
  db: Database,
  tableName: string,
  indexName: string,
  range: Array<{
    type: "Eq" | "Gt" | "Gte" | "Lt" | "Lte";
    fieldPath: string;
    value: unknown;
  }>,
): Promise<T[]> {
  const qid = db.startQueryAsync({
    source: {
      type: "IndexRange",
      indexName: `${tableName}.${indexName}`,
      range: range as never,
      order: "asc",
    } as never,
    operators: [],
  });
  const results: T[] = [];
  let next = await db.queryNextAsync(qid);
  while (!next.done) {
    if (next.value) {
      results.push(next.value as T);
    }
    next = await db.queryNextAsync(qid);
  }
  db.queryCleanup(qid);
  return results;
}

/**
 * Insert or update an ID mapping.
 *
 * Args: `{ localId: string, remoteId: string, table: string }`
 */
const idMapSet: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { localId, remoteId, table, identityKey } = args as {
      localId: string;
      remoteId: string;
      table: string;
      identityKey?: string | null;
    };

    const existing = await firstByIndex(
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
  handler: async (db, args) => {
    const { localId, identityKey } = args as {
      localId: string;
      identityKey?: string | null;
    };

    const row = await firstByIndex<IdMapRow>(
      db,
      "_resolve_id_map",
      "by_identity_key_and_local_id",
      [
        { type: "Eq", fieldPath: "identityKey", value: identityKey ?? null },
        { type: "Eq", fieldPath: "localId", value: localId },
      ],
    );
    return row?.remoteId ?? null;
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
  handler: async (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    const results: Array<{
      localId: string;
      remoteId: string;
      table: string;
      identityKey?: string;
    }> = [];

    for (const row of await allByIndex<IdMapRow>(
      db,
      "_resolve_id_map",
      "by_identity_key_and_local_id",
      [{ type: "Eq", fieldPath: "identityKey", value: identityKey ?? null }],
    )) {
      results.push({
        localId: row.localId,
        remoteId: row.remoteId,
        table: row.table,
        identityKey: row.identityKey ?? undefined,
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
  handler: async (db, args) => {
    const { localId, identityKey } = args as {
      localId: string;
      identityKey?: string | null;
    };

    const existing = await firstByIndex(
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
  handler: async (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    return (
      await allByIndex<PendingRow>(
        db,
        "_resolve_pending",
        "by_identity_key_and_creation_time",
        [{ type: "Eq", fieldPath: "identityKey", value: identityKey ?? null }],
      )
    ).map((row) => {
      return {
        _id: row._id,
        ref: row.ref,
        args: row.args,
        localResult: row.localResult,
        table: row.table,
        payloadVersion: row.payloadVersion,
        identityKey: row.identityKey,
        state: row.state,
        owner: row.owner,
        processingStartedAt: row.processingStartedAt,
        leaseExpiresAt: row.leaseExpiresAt,
        blockedReason: row.blockedReason,
        createdAt: row.createdAt,
      };
    });
  },
};

const pendingClaimNext: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { identityKey, owner, leaseMs, processorStaleMs } = args as {
      identityKey?: string | null;
      owner: string;
      leaseMs?: number;
      processorStaleMs?: number;
    };
    const now = Date.now();
    const expiresAt = now + (leaseMs ?? 30_000);
    const processorCutoff = now - (processorStaleMs ?? leaseMs ?? 30_000);

    const candidates = await allByIndex<PendingRow>(
      db,
      "_resolve_pending",
      "by_identity_key_and_creation_time",
      [{ type: "Eq", fieldPath: "identityKey", value: identityKey ?? null }],
    );
    for (const doc of candidates) {
      const state = doc.state ?? "pending";
      const processingOwner = doc.owner ?? null;
      const leaseExpiresAt = doc.leaseExpiresAt;
      const processor =
        processingOwner === null
          ? null
          : await readProcessor(db, identityKey ?? null, processingOwner);
      const processorStale =
        processingOwner !== null &&
        (processor === null ||
          typeof processor.lastSeenAt !== "number" ||
          processor.lastSeenAt <= processorCutoff);
      const claimable =
        state === "pending" ||
        (state === "processing" &&
          ((typeof leaseExpiresAt === "number" && leaseExpiresAt <= now) ||
            processorStale));
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

      const claimed = (await db.getAsync(
        "_resolve_pending",
        doc._id as DocumentId,
      )) as PendingRow | null;
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
  handler: async (db, args) => {
    const { id, owner, leaseMs } = args as {
      id: string;
      owner: string;
      leaseMs?: number;
    };
    const doc = await readPendingById(db, id);
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
 *
 * Returns `true` when the entry was deleted, `false` when the row no longer
 * exists or is owned by a different processor (lease lost / stale remove).
 */
const pendingRemove: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { id, owner } = args as { id: string; owner?: string };
    const doc = await readPendingById(db, id);
    if (doc !== null && (owner === undefined || doc.owner === owner)) {
      db.delete("_resolve_pending", id as DocumentId);
      return true;
    }
    return false;
  },
};

const pendingRelease: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { id, owner } = args as { id: string; owner?: string };
    const doc = await readPendingById(db, id);
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
  handler: async (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    for (const doc of await allByIndex(
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
  handler: async (db, args) => {
    const { id, reason } = args as {
      id: string;
      reason: "reauthRequired" | "authorizationDenied" | "scopeChanged";
    };
    const doc = await readPendingById(db, id);
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
  handler: async (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    for (const doc of await allByIndex(
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
// Pending blob uploads — mirrors the pending mutations queue but for
// `ctx.storage.store(blob)` calls that need to upload to remote.
// ---------------------------------------------------------------------------

async function readPendingUploadById(
  db: Database,
  id: string,
): Promise<
  | (StoredDocument & {
      owner?: string;
      state?: string;
      localStorageId?: string;
    })
  | null
> {
  if (db.getTableForId(id) !== "_resolve_pending_uploads") {
    return null;
  }
  return (await db.getAsync("_resolve_pending_uploads", id as DocumentId)) as
    | (StoredDocument & {
        owner?: string;
        state?: string;
        localStorageId?: string;
      })
    | null;
}

const pendingUploadPush: SystemFunctionDef = {
  type: "mutation",
  handler: (db, args) => {
    const { localStorageId, sha256, size, contentType, identityKey } = args as {
      localStorageId: string;
      sha256: string;
      size: number;
      contentType: string;
      identityKey?: string | null;
    };
    const id = db.insert("_resolve_pending_uploads", {
      localStorageId,
      sha256,
      size,
      contentType,
      identityKey: identityKey ?? null,
      state: "pending" as const,
      owner: { $undefined: true },
      processingStartedAt: { $undefined: true },
      leaseExpiresAt: { $undefined: true },
      createdAt: Date.now(),
    });
    return id as string;
  },
};

const pendingUploadGetAll: SystemFunctionDef = {
  type: "query",
  handler: async (db, args) => {
    const { identityKey } = args as { identityKey?: string | null };
    return (
      await allByIndex<PendingUploadRow>(
        db,
        "_resolve_pending_uploads",
        "by_identity_key_and_creation_time",
        [
          {
            type: "Eq",
            fieldPath: "identityKey",
            value: identityKey ?? null,
          },
        ],
      )
    ).map((row) => {
      return {
        _id: row._id,
        localStorageId: row.localStorageId,
        sha256: row.sha256,
        size: row.size,
        contentType: row.contentType,
        identityKey: row.identityKey,
        state: row.state,
        owner: row.owner,
        processingStartedAt: row.processingStartedAt,
        leaseExpiresAt: row.leaseExpiresAt,
        createdAt: row.createdAt,
      };
    });
  },
};

const pendingUploadClaimNext: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { identityKey, owner, leaseMs, processorStaleMs } = args as {
      identityKey?: string | null;
      owner: string;
      leaseMs?: number;
      processorStaleMs?: number;
    };
    const now = Date.now();
    const expiresAt = now + (leaseMs ?? 30_000);
    const processorCutoff = now - (processorStaleMs ?? leaseMs ?? 30_000);

    const candidates = await allByIndex<PendingUploadRow>(
      db,
      "_resolve_pending_uploads",
      "by_identity_key_and_creation_time",
      [
        {
          type: "Eq",
          fieldPath: "identityKey",
          value: identityKey ?? null,
        },
      ],
    );
    for (const doc of candidates) {
      const state = doc.state ?? "pending";
      const processingOwner = doc.owner ?? null;
      const leaseExpiresAt = doc.leaseExpiresAt;
      const processor =
        processingOwner === null
          ? null
          : await readProcessor(db, identityKey ?? null, processingOwner);
      const processorStale =
        processingOwner !== null &&
        (processor === null ||
          typeof processor.lastSeenAt !== "number" ||
          processor.lastSeenAt <= processorCutoff);
      const claimable =
        state === "pending" ||
        (state === "processing" &&
          ((typeof leaseExpiresAt === "number" && leaseExpiresAt <= now) ||
            processorStale));
      if (!claimable) continue;

      db.patch("_resolve_pending_uploads", doc._id as DocumentId, {
        state: "processing",
        owner,
        processingStartedAt: now,
        leaseExpiresAt: expiresAt,
      });
      const claimed = (await db.getAsync(
        "_resolve_pending_uploads",
        doc._id as DocumentId,
      )) as PendingUploadRow | null;
      if (!claimed) return null;
      return {
        _id: claimed._id,
        localStorageId: claimed.localStorageId,
        sha256: claimed.sha256,
        size: claimed.size,
        contentType: claimed.contentType,
        identityKey: claimed.identityKey,
        state: claimed.state,
        owner: claimed.owner,
        processingStartedAt: claimed.processingStartedAt,
        leaseExpiresAt: claimed.leaseExpiresAt,
        createdAt: claimed.createdAt,
      };
    }
    return null;
  },
};

const pendingUploadRenewLease: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { id, owner, leaseMs } = args as {
      id: string;
      owner: string;
      leaseMs?: number;
    };
    const doc = await readPendingUploadById(db, id);
    if (doc === null || doc.owner !== owner) return false;
    db.patch("_resolve_pending_uploads", id as DocumentId, {
      leaseExpiresAt: Date.now() + (leaseMs ?? 30_000),
    });
    return true;
  },
};

const pendingUploadRemove: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { id, owner } = args as { id: string; owner?: string };
    const doc = await readPendingUploadById(db, id);
    if (doc !== null && (owner === undefined || doc.owner === owner)) {
      db.delete("_resolve_pending_uploads", id as DocumentId);
      return true;
    }
    return false;
  },
};

const pendingUploadRelease: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { id, owner } = args as { id: string; owner?: string };
    const doc = await readPendingUploadById(db, id);
    if (doc !== null && (owner === undefined || doc.owner === owner)) {
      db.patch("_resolve_pending_uploads", id as DocumentId, {
        state: "pending",
        owner: { $undefined: true },
        processingStartedAt: { $undefined: true },
        leaseExpiresAt: { $undefined: true },
      });
    }
    return null;
  },
};

const processorHeartbeat: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { processorId, identityKey } = args as {
      processorId: string;
      identityKey?: string | null;
    };
    const existing = await readProcessor(db, identityKey ?? null, processorId);
    if (existing) {
      db.patch("_resolve_processors", existing._id as DocumentId, {
        lastSeenAt: Date.now(),
      });
      return null;
    }

    db.insert("_resolve_processors", {
      processorId,
      identityKey: identityKey ?? null,
      lastSeenAt: Date.now(),
    });
    return null;
  },
};

const processorRemove: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { processorId, identityKey } = args as {
      processorId: string;
      identityKey?: string | null;
    };
    const existing = await readProcessor(db, identityKey ?? null, processorId);
    if (existing) {
      db.delete("_resolve_processors", existing._id as DocumentId);
    }
    return null;
  },
};

const collectionMetadataGet: SystemFunctionDef = {
  type: "query",
  handler: async (db, args) => {
    const { collection, identityKey, schemaVersion } = args as {
      collection: string;
      identityKey?: string | null;
      schemaVersion: number;
    };
    const row = (await readCollectionMetadata(db, {
      identityKey: identityKey ?? null,
      collection,
      schemaVersion,
    })) as { seq?: number } | null;
    return typeof row?.seq === "number" ? row.seq : null;
  },
};

const collectionMetadataSet: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { collection, seq, identityKey, schemaVersion } = args as {
      collection: string;
      seq: number;
      identityKey?: string | null;
      schemaVersion: number;
    };
    const existing = await readCollectionMetadata(db, {
      identityKey: identityKey ?? null,
      collection,
      schemaVersion,
    });
    const doc = {
      collection,
      seq,
      identityKey: identityKey ?? null,
      schemaVersion,
    };
    if (existing) {
      db.patch("_resolve_collection_metadata", existing._id as DocumentId, doc);
    } else {
      db.insert("_resolve_collection_metadata", doc);
    }
    return null;
  },
};

const documentMetadataGetBatch: SystemFunctionDef = {
  type: "query",
  handler: async (db, args) => {
    const { collection, docIds, identityKey, schemaVersion } = args as {
      collection: string;
      docIds: string[];
      identityKey?: string | null;
      schemaVersion: number;
    };
    const rows = await allByIndex<DocumentMetadataRow>(
      db,
      "_resolve_document_metadata",
      "by_identity_key_and_collection_and_doc_id",
      [
        { type: "Eq", fieldPath: "identityKey", value: identityKey ?? null },
        { type: "Eq", fieldPath: "collection", value: collection },
        { type: "Eq", fieldPath: "schemaVersion", value: schemaVersion },
      ],
    );
    const wanted = new Set(docIds);
    return rows
      .filter((row) => wanted.has(String(row.docId)))
      .map((row) => ({
        docId: String(row.docId),
        seq: Number(row.seq),
      }));
  },
};

const documentMetadataSetBatch: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { collection, entries, identityKey, schemaVersion } = args as {
      collection: string;
      entries: Array<{ docId: string; seq: number }>;
      identityKey?: string | null;
      schemaVersion: number;
    };
    for (const entry of entries) {
      const existing = await readDocumentMetadata(db, {
        identityKey: identityKey ?? null,
        collection,
        docId: entry.docId,
        schemaVersion,
      });
      const doc = {
        collection,
        docId: entry.docId,
        seq: entry.seq,
        identityKey: identityKey ?? null,
        schemaVersion,
      };
      if (existing) {
        db.patch("_resolve_document_metadata", existing._id as DocumentId, doc);
      } else {
        db.insert("_resolve_document_metadata", doc);
      }
    }
    return null;
  },
};

const documentMetadataDeleteBatch: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { collection, docIds, identityKey, schemaVersion } = args as {
      collection: string;
      docIds: string[];
      identityKey?: string | null;
      schemaVersion: number;
    };
    for (const docId of docIds) {
      const existing = await readDocumentMetadata(db, {
        identityKey: identityKey ?? null,
        collection,
        docId,
        schemaVersion,
      });
      if (existing) {
        db.delete("_resolve_document_metadata", existing._id as DocumentId);
      }
    }
    return null;
  },
};

const documentMetadataClearCollection: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { collection, identityKey, schemaVersion } = args as {
      collection: string;
      identityKey?: string | null;
      schemaVersion: number;
    };
    for (const doc of await allByIndex(
      db,
      "_resolve_document_metadata",
      "by_identity_key_and_collection_and_doc_id",
      [
        { type: "Eq", fieldPath: "identityKey", value: identityKey ?? null },
        { type: "Eq", fieldPath: "collection", value: collection },
        { type: "Eq", fieldPath: "schemaVersion", value: schemaVersion },
      ],
    )) {
      db.delete("_resolve_document_metadata", doc._id as DocumentId);
    }
    return null;
  },
};

const authStateSetActive: SystemFunctionDef = {
  type: "mutation",
  handler: async (db, args) => {
    const { activeIdentityKey } = args as {
      activeIdentityKey?: string | null;
    };

    const updatedAt = Date.now();
    const existingRows = await db.listDocumentsAsync("_resolve_auth_state");
    const singleton = existingRows.find(
      (row) => row._id === AUTH_STATE_DOCUMENT_ID,
    );
    const seed = singleton ?? existingRows[0] ?? null;

    for (const row of existingRows) {
      if (row._id !== AUTH_STATE_DOCUMENT_ID) {
        db.delete("_resolve_auth_state", row._id as DocumentId);
      }
    }

    db.putDocument("_resolve_auth_state", {
      _id: AUTH_STATE_DOCUMENT_ID,
      _creationTime:
        typeof seed?._creationTime === "number"
          ? seed._creationTime
          : updatedAt,
      activeIdentityKey: activeIdentityKey ?? null,
      updatedAt,
    });

    return null;
  },
};

const authStateGetActive: SystemFunctionDef = {
  type: "query",
  handler: async (db) => {
    const existing = await readActiveAuthState(db);
    return existing?.activeIdentityKey ?? null;
  },
};

const pendingListIdentityKeys: SystemFunctionDef = {
  type: "query",
  handler: async (db) => {
    const keys = new Set<string>();
    for (const doc of await db.listDocumentsAsync("_resolve_pending")) {
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
  handler: async (db, args) => {
    const { identityKey } = args as { identityKey: string };

    for (const tableName of [
      "_resolve_id_map",
      "_resolve_pending",
      "_resolve_collection_metadata",
      "_resolve_document_metadata",
    ] as const) {
      const indexName =
        tableName === "_resolve_id_map"
          ? "by_identity_key_and_local_id"
          : tableName === "_resolve_pending"
            ? "by_identity_key_and_creation_time"
            : tableName === "_resolve_collection_metadata"
              ? "by_identity_key_and_collection"
              : "by_identity_key_and_collection_and_doc_id";
      for (const doc of await allByIndex(db, tableName, indexName, [
        { type: "Eq", fieldPath: "identityKey", value: null },
      ])) {
        db.patch(tableName, doc._id as DocumentId, { identityKey });
      }
    }

    return null;
  },
};

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
  "_system:pendingUploadPush": pendingUploadPush,
  "_system:pendingUploadGetAll": pendingUploadGetAll,
  "_system:pendingUploadClaimNext": pendingUploadClaimNext,
  "_system:pendingUploadRenewLease": pendingUploadRenewLease,
  "_system:pendingUploadRemove": pendingUploadRemove,
  "_system:pendingUploadRelease": pendingUploadRelease,
  "_system:processorHeartbeat": processorHeartbeat,
  "_system:processorRemove": processorRemove,
  "_system:collectionMetadataGet": collectionMetadataGet,
  "_system:collectionMetadataSet": collectionMetadataSet,
  "_system:documentMetadataGetBatch": documentMetadataGetBatch,
  "_system:documentMetadataSetBatch": documentMetadataSetBatch,
  "_system:documentMetadataDeleteBatch": documentMetadataDeleteBatch,
  "_system:documentMetadataClearCollection": documentMetadataClearCollection,
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
  pendingUploadPush: "_system:pendingUploadPush",
  pendingUploadGetAll: "_system:pendingUploadGetAll",
  pendingUploadClaimNext: "_system:pendingUploadClaimNext",
  pendingUploadRenewLease: "_system:pendingUploadRenewLease",
  pendingUploadRemove: "_system:pendingUploadRemove",
  pendingUploadRelease: "_system:pendingUploadRelease",
  processorHeartbeat: "_system:processorHeartbeat",
  processorRemove: "_system:processorRemove",
  collectionMetadataGet: "_system:collectionMetadataGet",
  collectionMetadataSet: "_system:collectionMetadataSet",
  documentMetadataGetBatch: "_system:documentMetadataGetBatch",
  documentMetadataSetBatch: "_system:documentMetadataSetBatch",
  documentMetadataDeleteBatch: "_system:documentMetadataDeleteBatch",
  documentMetadataClearCollection: "_system:documentMetadataClearCollection",
  authStateSetActive: "_system:authStateSetActive",
  authStateGetActive: "_system:authStateGetActive",
  pendingListIdentityKeys: "_system:pendingListIdentityKeys",
  identityMoveAnonymousToIdentity: "_system:identityMoveAnonymousToIdentity",
} as const;
