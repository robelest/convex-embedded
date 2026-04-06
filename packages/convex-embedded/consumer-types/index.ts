import {
  AuthResolver,
  EmbeddedRuntime,
  createEmbeddedClient,
  createEmbeddedRuntime,
  createTestIdentity,
  createTransport,
  ephemeralStorage,
  type EmbeddedClientOptions,
  type EmbeddedPlatformAdapter,
  type EmbeddedRuntimeOptions,
} from "@robelest/convex-embedded";
import {
  getAuthState,
  getAuthIdentity,
  compileWasmModule,
  createBrowserPlatformAdapter,
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
  createReplica,
  IdMap,
  type CreateReplicaOptions,
  type Replica,
  clientSchema,
  engine,
  runtime,
  type EngineConfig,
} from "@robelest/convex-embedded/client";
import embedded from "@robelest/convex-embedded/convex.config";
import {
  CrdtType,
  counter,
  createConflict,
  prose,
  register as registerCrdt,
  schema,
  set as setCrdt,
  type Conflict,
} from "@robelest/convex-embedded/crdt";
import {
  createConvexReactClient,
  wrapConvexBrowserClientForReact,
} from "@robelest/convex-embedded/react";
import {
  embeddedTable,
  localOnly,
  migration,
  remoteOnly,
  setup,
  view,
  type EmbeddedTableHandle,
  type SetupConfig,
} from "@robelest/convex-embedded/server";
import { register } from "@robelest/convex-embedded/test";

type _RootSurface = {
  AuthResolver: typeof AuthResolver;
  EmbeddedRuntime: typeof EmbeddedRuntime;
  createEmbeddedClient: typeof createEmbeddedClient;
  createEmbeddedRuntime: typeof createEmbeddedRuntime;
  createTestIdentity: typeof createTestIdentity;
  createTransport: typeof createTransport;
  ephemeralStorage: typeof ephemeralStorage;
  embeddedClientOptions: EmbeddedClientOptions | null;
  embeddedPlatformAdapter: EmbeddedPlatformAdapter | null;
  runtimeOptions: EmbeddedRuntimeOptions | null;
};

type _BrowserSurface = {
  compileWasmModule: typeof compileWasmModule;
  createBrowserPlatformAdapter: typeof createBrowserPlatformAdapter;
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

type _ReactSurface = {
  createConvexReactClient: typeof createConvexReactClient;
  wrapConvexBrowserClientForReact: typeof wrapConvexBrowserClientForReact;
};

type _ClientSurface = {
  IdMap: typeof IdMap;
  createReplica: typeof createReplica;
  clientSchema: typeof clientSchema;
  engine: typeof engine;
  runtime: typeof runtime;
  createReplicaOptions: CreateReplicaOptions | null;
  engineConfig: EngineConfig | null;
  replica: Replica | null;
};

type _CrdtSurface = {
  CrdtType: typeof CrdtType;
  counter: typeof counter;
  createConflict: typeof createConflict;
  prose: typeof prose;
  register: typeof registerCrdt;
  schema: typeof schema;
  set: typeof setCrdt;
  conflict: Conflict<unknown> | null;
};

type _ServerSurface = {
  embedded: typeof embedded;
  embeddedTable: typeof embeddedTable;
  localOnly: typeof localOnly;
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
  createEmbeddedClient,
  createEmbeddedRuntime,
  createTestIdentity,
  createTransport,
  ephemeralStorage,
  embeddedClientOptions: null,
  embeddedPlatformAdapter: null,
  runtimeOptions: null,
});

void (<_BrowserSurface>{
  compileWasmModule,
  createBrowserPlatformAdapter,
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

void (<_ReactSurface>{
  createConvexReactClient,
  wrapConvexBrowserClientForReact,
});

void (<_ClientSurface>{
  IdMap,
  createReplica,
  clientSchema,
  engine,
  runtime,
  createReplicaOptions: null,
  engineConfig: null,
  replica: null,
});

void (<_CrdtSurface>{
  CrdtType,
  counter,
  createConflict,
  prose,
  register: registerCrdt,
  schema,
  set: setCrdt,
  conflict: null,
});

void (<_ServerSurface>{
  embedded,
  embeddedTable,
  localOnly,
  migration,
  register,
  remoteOnly,
  setup,
  view,
  setupConfig: null,
  tableHandle: null,
});
