export type DevtoolsView =
  | "operations"
  | "subscriptions"
  | "sync"
  | "pending"
  | "auth"
  | "data"
  | "schema"
  | "crdt";

export interface DevtoolsLogLine {
  severity: string;
  body: string;
  timeMs: number;
  category?: string;
}

export interface OperationEntry {
  id: string;
  kind: "query" | "mutation" | "action";
  path: string;
  status: "ok" | "error";
  startMs: number;
  durationMs: number;
  error?: string;
  args?: unknown;
  result?: unknown;
  resultSize?: number;
  logs: DevtoolsLogLine[];
}

export interface PerfBucket {
  kind: string;
  count: number;
  meanMs: number;
  p50: number;
  p99: number;
}

export interface PerfSummary {
  buckets: PerfBucket[];
  slowest: OperationEntry[];
}

export interface SubscriptionEntry {
  id: string;
  path: string;
  args: unknown;
  value?: unknown;
  updateCount: number;
  lastUpdateMs: number;
}

export interface ReplicationSnapshot {
  status: string;
  online: boolean;
  detail?: Record<string, unknown>;
}

export interface PendingEntry {
  id: string;
  ref: string;
  table?: string;
  status: string;
  createdAt: number;
}

export interface AuthSnapshot {
  status: string;
  identityKey: string | null;
}

export interface DataTable {
  name: string;
  rowCount: number;
}

export interface DataRows {
  table: string;
  rows: Record<string, unknown>[];
  cursor: string | null;
  isDone: boolean;
}

export interface SchemaTable {
  name: string;
  indexes: Array<{ name: string; fields: string[] }>;
}

export interface CrdtEntry {
  collection: string;
  docId: string;
  seq: number;
  byteLength: number;
}

export interface DevtoolsSnapshot {
  operations: OperationEntry[];
  performance: PerfSummary;
  logs: DevtoolsLogLine[];
  subscriptions: SubscriptionEntry[];
  sync: ReplicationSnapshot;
  pending: PendingEntry[];
  auth: AuthSnapshot;
  data: DataTable[];
  schema: SchemaTable[];
  crdt: CrdtEntry[];
}

export interface RunFunctionInput {
  kind: "query" | "mutation" | "action";
  path: string;
  args: Record<string, unknown>;
}

export interface EmbeddedDevtoolsSource {
  getSnapshot<V extends keyof DevtoolsSnapshot>(view: V): DevtoolsSnapshot[V];
  subscribe(view: keyof DevtoolsSnapshot, callback: () => void): () => void;
  listTableRows(
    table: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<DataRows>;
  runFunction(input: RunFunctionInput): Promise<unknown>;
  patchDocument(
    table: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<void>;
  clearLocalData(): Promise<void>;
  clearActivity(): void;
  dispose(): void;
}
