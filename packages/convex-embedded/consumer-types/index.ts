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
  getAuthState,
  getAuthIdentity,
  compileWasmModule,
  createConvexClient,
  getRemoteState,
  logout,
  reauthenticate,
  setAuthIdentity,
  subscribeAuthState,
  subscribeRemoteState,
  switchIdentity,
  type AuthOptions,
  type AuthState,
  type ClientOptions,
  type RemoteOptions,
  type RemoteState,
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
  getAuthIdentity: typeof getAuthIdentity;
  getAuthState: typeof getAuthState;
  getRemoteState: typeof getRemoteState;
  logout: typeof logout;
  reauthenticate: typeof reauthenticate;
  setAuthIdentity: typeof setAuthIdentity;
  subscribeAuthState: typeof subscribeAuthState;
  subscribeRemoteState: typeof subscribeRemoteState;
  switchIdentity: typeof switchIdentity;
  authOptions: AuthOptions | null;
  authState: AuthState | null;
  clientOptions: ClientOptions | null;
  remoteOptions: RemoteOptions | null;
  remoteState: RemoteState | null;
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
  getAuthIdentity,
  getAuthState,
  getRemoteState,
  logout,
  reauthenticate,
  setAuthIdentity,
  subscribeAuthState,
  subscribeRemoteState,
  switchIdentity,
  authOptions: null,
  authState: null,
  clientOptions: null,
  remoteOptions: null,
  remoteState: null,
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
