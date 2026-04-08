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
  value: T;
  clientId: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Engine status — used by the client-side engine state machine
// ---------------------------------------------------------------------------

export type EngineStatus =
  | { status: "idle" }
  | { status: "offline" }
  | { status: "resolving"; progress: ResolveProgress }
  | { status: "resolved" }
  | { status: "error"; error: Error };

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

export type RecoveryAction =
  | { action: "reset" }
  | { action: "keep-old-schema" }
  | { action: "retry" }
  | { action: "custom"; handler: () => Promise<void> };

export interface RecoveryContext {
  /** Whether it's safe to wipe local data and resync from remote. */
  canResetSafely: boolean;
  /** The schema version the local data is on. */
  currentVersion: number;
  /** The schema version the app expects. */
  targetVersion: number;
}

export type MigrationErrorHandler = (
  error: Error,
  ctx: RecoveryContext,
) => Promise<RecoveryAction>;

// ---------------------------------------------------------------------------
// Schema definition types
// ---------------------------------------------------------------------------

export interface SchemaDefinition {
  version: number;
  shape: Record<string, unknown>;
  defaults?: Record<string, unknown>;
}

/** Metadata attached to a CRDT field descriptor. */
export interface CrdtFieldDescriptor {
  type: CrdtType;
  validator: unknown;
  resolve?: (conflict: Conflict<unknown>) => unknown;
}

export interface FieldRef<
  TableName extends string = string,
  FieldName extends string = string,
  Value = unknown,
  Kind extends string = string,
> {
  table: TableName;
  id: string;
  field: FieldName;
  readonly __value?: Value;
  readonly __kind?: Kind;
}

// ---------------------------------------------------------------------------
// Resolve / remote types — wire format between client and server
// ---------------------------------------------------------------------------

export interface ResolveRequest {
  documents: ResolveDocumentRequest[];
}

export interface ResolveDocumentRequest {
  docId: string;
  /** Y.encodeStateVector(localDoc) */
  vector: ArrayBuffer;
}

export interface ResolveResponse {
  documents: ResolveDocumentResponse[];
}

export interface ResolveDocumentResponse {
  docId: string;
  /** Y.encodeStateAsUpdate(serverDoc, clientVector) — undefined if up to date */
  diff?: ArrayBuffer;
}

export interface PushRequest {
  documents: PushDocumentRequest[];
}

export interface PushDocumentRequest {
  docId: string;
  /** Y.encodeStateAsUpdateV2(localDoc) */
  update: ArrayBuffer;
}
