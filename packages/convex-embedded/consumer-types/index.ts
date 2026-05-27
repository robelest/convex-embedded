import {
  getAuthState,
  getAuthIdentity,
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
} from "../dist/browser/index.js";
import {
  createEmbeddedPrefetch,
  type CreateEmbeddedPrefetchOptions,
  type Prefetch,
} from "../dist/client/index.js";
import embedded from "../dist/component/convex.config.js";
import {
  CrdtType,
  counter,
  createConflict,
  prose,
  register as registerCrdt,
  schema,
  set as setCrdt,
  type Conflict,
} from "../dist/crdt/index.js";
import {
  AuthResolver,
  createEmbeddedClient,
  createEmbeddedRuntime,
  createTransport,
  type EmbeddedClientOptions,
  type EmbeddedPlatformAdapter,
  type EmbeddedRuntime,
  type EmbeddedRuntimeOptions,
} from "../dist/index.js";
import {
  createConvexReactClient,
  wrapConvexBrowserClientForReact,
} from "../dist/react.js";
import {
  embeddedTable,
  localOnly,
  migration,
  remoteOnly,
  view,
  type EmbeddedTableHandle,
} from "../dist/server/index.js";
import { createTestIdentity, register } from "../dist/test.js";

type _RootSurface = {
  AuthResolver: typeof AuthResolver;
  embeddedRuntime: EmbeddedRuntime | null;
  createEmbeddedClient: typeof createEmbeddedClient;
  createEmbeddedRuntime: typeof createEmbeddedRuntime;
  createTestIdentity: typeof createTestIdentity;
  createTransport: typeof createTransport;
  embeddedClientOptions: EmbeddedClientOptions | null;
  embeddedPlatformAdapter: EmbeddedPlatformAdapter | null;
  runtimeOptions: EmbeddedRuntimeOptions | null;
};

type _BrowserSurface = {
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
  createEmbeddedPrefetch: typeof createEmbeddedPrefetch;
  prefetchOptions: CreateEmbeddedPrefetchOptions<Record<string, never>> | null;
  prefetchData: Prefetch | null;
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
  view: typeof view;
  tableHandle: EmbeddedTableHandle | null;
};

void (<_RootSurface>{
  AuthResolver,
  embeddedRuntime: null,
  createEmbeddedClient,
  createEmbeddedRuntime,
  createTestIdentity,
  createTransport,
  embeddedClientOptions: null,
  embeddedPlatformAdapter: null,
  runtimeOptions: null,
});

void (<_BrowserSurface>{
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
  createEmbeddedPrefetch,
  prefetchOptions: null,
  prefetchData: null,
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
  view,
  tableHandle: null,
});
