import {
  AuthResolver,
  EmbeddedRuntime,
  createEmbeddedConvex,
  createTestIdentity,
  createTransport,
  ephemeralStorage,
  type EmbeddedRuntimeOptions,
} from "@robelest/convex-embedded";
import {
  compileWasmModule,
  createConvexClient,
  getResolveState,
  subscribeResolveState,
  type ClientOptions,
  type ResolveOptions,
  type ResolveState,
} from "@robelest/convex-embedded/browser";
import {
  IdMap,
  clientSchema,
  engine,
  runtime,
  type EngineConfig,
} from "@robelest/convex-embedded/client";
import embedded from "@robelest/convex-embedded/convex.config";
import {
  CrdtType,
  getConflict,
  getCounterValue,
  getSetMembers,
  schema,
  type Conflict,
} from "@robelest/convex-embedded/crdt";
import {
  embeddedTable,
  migration,
  remoteOnly,
  setup,
  view,
  type EmbeddedTableHandle,
  type SetupConfig,
} from "@robelest/convex-embedded/server";
import { register } from "@robelest/convex-embedded/test";
import "@robelest/convex-embedded/worker";

type _RootSurface = {
  AuthResolver: typeof AuthResolver;
  EmbeddedRuntime: typeof EmbeddedRuntime;
  createEmbeddedConvex: typeof createEmbeddedConvex;
  createTestIdentity: typeof createTestIdentity;
  createTransport: typeof createTransport;
  ephemeralStorage: typeof ephemeralStorage;
  runtimeOptions: EmbeddedRuntimeOptions | null;
};

type _BrowserSurface = {
  compileWasmModule: typeof compileWasmModule;
  createConvexClient: typeof createConvexClient;
  getResolveState: typeof getResolveState;
  subscribeResolveState: typeof subscribeResolveState;
  clientOptions: ClientOptions | null;
  resolveOptions: ResolveOptions | null;
  resolveState: ResolveState | null;
};

type _ClientSurface = {
  IdMap: typeof IdMap;
  clientSchema: typeof clientSchema;
  engine: typeof engine;
  runtime: typeof runtime;
  engineConfig: EngineConfig | null;
};

type _CrdtSurface = {
  CrdtType: typeof CrdtType;
  getConflict: typeof getConflict;
  getCounterValue: typeof getCounterValue;
  getSetMembers: typeof getSetMembers;
  schema: typeof schema;
  conflict: Conflict<unknown> | null;
};

type _ServerSurface = {
  embedded: typeof embedded;
  embeddedTable: typeof embeddedTable;
  migration: typeof migration;
  register: typeof register;
  remoteOnly: typeof remoteOnly;
  setup: typeof setup;
  view: typeof view;
  setupConfig: SetupConfig | null;
  tableHandle: EmbeddedTableHandle | null;
};

void (<_RootSurface>{
  AuthResolver,
  EmbeddedRuntime,
  createEmbeddedConvex,
  createTestIdentity,
  createTransport,
  ephemeralStorage,
  runtimeOptions: null,
});

void (<_BrowserSurface>{
  compileWasmModule,
  createConvexClient,
  getResolveState,
  subscribeResolveState,
  clientOptions: null,
  resolveOptions: null,
  resolveState: null,
});

void (<_ClientSurface>{
  IdMap,
  clientSchema,
  engine,
  runtime,
  engineConfig: null,
});

void (<_CrdtSurface>{
  CrdtType,
  getConflict,
  getCounterValue,
  getSetMembers,
  schema,
  conflict: null,
});

void (<_ServerSurface>{
  embedded,
  embeddedTable,
  migration,
  register,
  remoteOnly,
  setup,
  view,
  setupConfig: null,
  tableHandle: null,
});
