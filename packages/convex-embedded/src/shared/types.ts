/**
 * CRDT field type identifiers used internally to map schema fields
 * to their corresponding Yjs data structures.
 */
export const CrdtType = {
  /** Y.XmlFragment — character-level merge via Yjs */
  Prose: "prose",
  /** Y.Map — multi-value register with conflict tracking */
  Register: "register",
  /** Y.Array — append-only array of increments, materialized as sum */
  Counter: "counter",
  /** Y.Map — add-wins set, key presence = membership */
  Set: "set",
  /** Plain value in Y.Map — last-write-wins, no conflict tracking */
  Plain: "plain",
  /** Marker for fields that exist only on remote Convex */
  Omitted: "omitted",
} as const;

/**
 * Union of the supported CRDT field kinds.
 */
export type CrdtType = (typeof CrdtType)[keyof typeof CrdtType];

// ---------------------------------------------------------------------------
// Conflict type — exposed to app code for custom resolvers on register fields
// ---------------------------------------------------------------------------

/**
 * Represents concurrent writes to a `schema.register()` field.
 * Passed to the custom `resolve` function when multiple clients
 * wrote to the same field while offline.
 */
export interface Conflict<T> {
  /** All concurrent values, unordered. */
  values: T[];
  /** Per-entry metadata including client ID and timestamp. */
  entries: ConflictEntry<T>[];
  /** Returns the value with the highest timestamp (default resolver). */
  latest(): T;
  /** Returns the value written by a specific client, if any. */
  byClient(id: string): T | undefined;
}

export interface ConflictEntry<T> {
  /** Conflicting value written by one client. */
  value: T;
  /** Authoritative client identifier that produced the value. */
  clientId: string;
  /** Logical timestamp used for default latest-write selection. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Engine status — used by the client-side engine state machine
// ---------------------------------------------------------------------------

/**
 * Snapshot of the local resolve engine state used by client UIs and devtools.
 */
export type EngineStatus =
  | { status: "idle" }
  | { status: "offline" }
  | { status: "resolving"; progress: ResolveProgress }
  | { status: "resolved" }
  | { status: "error"; error: Error };

/**
 * Progress metadata for a table resolve cycle.
 */
export interface ResolveProgress {
  /** Tables currently being resolved. */
  tables: string[];
  /** Number of tables completed so far. */
  completed: number;
  /** Total number of tables to resolve. */
  total: number;
}

// ---------------------------------------------------------------------------
// Migration types
// ---------------------------------------------------------------------------

/**
 * Recovery instruction returned by a migration error handler.
 */
export type RecoveryAction =
  | { action: "reset" }
  | { action: "keep-old-schema" }
  | { action: "retry" }
  | { action: "custom"; handler: () => Promise<void> };

/**
 * Recovery context supplied to migration error handlers.
 */
export interface RecoveryContext {
  /** Whether it's safe to wipe local data and resync from remote. */
  canResetSafely: boolean;
  /** The schema version the local data is on. */
  currentVersion: number;
  /** The schema version the app expects. */
  targetVersion: number;
}

/**
 * Application-defined recovery hook invoked when local migrations fail.
 *
 * @param error - The migration failure.
 * @param ctx - Current schema/recovery context.
 * @returns The recovery action the runtime should take next.
 */
export type MigrationErrorHandler = (
  error: Error,
  ctx: RecoveryContext,
) => Promise<RecoveryAction>;

// ---------------------------------------------------------------------------
// Schema definition types
// ---------------------------------------------------------------------------

/**
 * Minimal serializable schema descriptor used across runtime boundaries.
 */
export interface SchemaDefinition {
  /** Monotonic schema version for the table or artifact. */
  version: number;
  /** Public field shape keyed by field name. */
  shape: Record<string, unknown>;
  /** Optional default values for missing fields. */
  defaults?: Record<string, unknown>;
}

/**
 * Metadata attached to a CRDT field descriptor.
 */
export interface CrdtFieldDescriptor {
  type: CrdtType;
  validator: unknown;
  resolve?: (conflict: Conflict<unknown>) => unknown;
}

/**
 * Typed reference to one field inside an embedded document.
 *
 * Field references are produced by `table.field(id, fieldName)` and are used by
 * the CRDT helpers such as `prose.open(...)`, `register.open(...)`, and
 * `counter.open(...)`.
 */
export interface FieldRef<
  TableName extends string = string,
  FieldName extends string = string,
  Value = unknown,
  Kind extends string = string,
> {
  /** Embedded table name that owns the field. */
  table: TableName;
  /** Document id containing the field. */
  id: string;
  /** Field name inside the document. */
  field: FieldName;
  /** Phantom type carrying the field value type. */
  readonly __value?: Value;
  /** Phantom type carrying the CRDT kind. */
  readonly __kind?: Kind;
}

// ---------------------------------------------------------------------------
// Resolve / remote types — wire format between client and server
// ---------------------------------------------------------------------------

/**
 * Client-to-server resolve request.
 *
 * Sent during reconnect / prefetch reconciliation to reconcile local Yjs documents with the
 * authoritative remote embedded state.
 */
export interface ResolveRequest {
  /** Last acknowledged collection sequence for the table, or `null` for full prefetch sync. */
  collectionSeq: number | null;
  /** Requested document vectors and per-document sequence cursors. */
  documents: ResolveDocumentRequest[];
  /** Optional bound query arguments for scoped resolve queries. */
  scopeArgs?: Record<string, unknown>;
  /** Cursor for paged full fallback responses. */
  fullCursor?: string | null;
}

/**
 * Per-document resolve request payload.
 */
export interface ResolveDocumentRequest {
  /** Embedded document id. */
  docId: string;
  /** Y.encodeStateVector(localDoc) */
  vector: ArrayBuffer;
  /** Last acknowledged atomic sequence for the document, or `null` when unknown. */
  lastSeq: number | null;
}

/**
 * Server-to-client resolve response.
 *
 * Incremental responses contain diffs and per-document sequence updates.
 * Full responses stream a paged authoritative snapshot until `isDone` becomes
 * `true`.
 */
export interface ResolveResponse {
  /** Whether the response is incremental or a full snapshot fallback. */
  mode: "full" | "incremental";
  /** Latest collection atomic sequence observed by the server. */
  collectionSeq: number;
  /** Document updates for the current page. */
  documents: ResolveDocumentResponse[];
  /** Cursor for the next full snapshot page, if any. */
  continueCursor?: string | null;
  /** Whether the full snapshot stream is complete. */
  isDone?: boolean;
}

/**
 * Per-document resolve response payload.
 */
export interface ResolveDocumentResponse {
  /** Embedded document id. */
  docId: string;
  /** Latest atomic sequence for the document, or `null` when deleted. */
  seq: number | null;
  /** Y.encodeStateAsUpdate(serverDoc, clientVector) — undefined if up to date */
  diff?: ArrayBuffer;
  /** Fully materialized document for full-mode responses or remote-only upserts. */
  document?: Record<string, unknown>;
  /** Marker for hard deletes. */
  deleted?: true;
}

/**
 * Client-to-server push request containing local Yjs updates.
 */
export interface PushRequest {
  /** Documents whose local Yjs state should be pushed to the server. */
  documents: PushDocumentRequest[];
}

/**
 * Per-document push payload.
 */
export interface PushDocumentRequest {
  /** Embedded document id. */
  docId: string;
  /** Y.encodeStateAsUpdateV2(localDoc) */
  update: ArrayBuffer;
}
