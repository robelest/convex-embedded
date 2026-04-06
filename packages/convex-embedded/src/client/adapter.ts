import { Cv } from "@robelest/fx/convex";
import type { ConvexClient } from "convex/browser";

import {
  assertRemotePlanOnline,
  type MutationPlan,
  type ReadPlan,
} from "@/client/routing/plan";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { ConnectivityAdapter } from "@/runtime/platform";

function createNoopUnsubscribe(): any {
  const noop = (() => {}) as any;
  noop.unsubscribe = noop;
  noop.getCurrentValue = () => undefined;
  noop.getQueryLogs = () => undefined;
  return noop;
}

function isOffline(connectivity?: ConnectivityAdapter): boolean {
  if (connectivity) {
    return connectivity.isOnline() === false;
  }

  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function createRuntimeLocalOnUpdate(input: {
  runtime: EmbeddedRuntime;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
}) {
  return (
    ref: unknown,
    args: Record<string, unknown>,
    callback: (result: unknown, meta?: unknown) => unknown,
    onError?: (error: Error, meta?: unknown) => unknown,
  ) => {
    const watch = input.runtime.watchLocalQuery(
      input.getRefName(ref),
      args ?? {},
    );

    const notify = () => {
      try {
        callback(
          watch.localQueryResult(),
          "Second argument to onUpdate callback is reserved for later use",
        );
      } catch (error) {
        const normalized = input.asError(error);
        if (onError) {
          onError(
            normalized,
            "Second argument to onUpdate onError is reserved for later use",
          );
        } else {
          void Promise.reject(normalized);
        }
      }
    };

    const unsubscribe = watch.onUpdate(notify) as any;
    unsubscribe.unsubscribe = unsubscribe;
    unsubscribe.getCurrentValue = () => watch.localQueryResult();
    unsubscribe.getQueryLogs = () => watch.localQueryLogs();
    return unsubscribe;
  };
}

function createRuntimeLocalPaginatedOnUpdate(input: {
  runtime: EmbeddedRuntime;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
}) {
  return (
    ref: unknown,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
    callback: (result: unknown, meta?: unknown) => unknown,
    onError?: (error: Error, meta?: unknown) => unknown,
  ) => {
    const watch = input.runtime.watchLocalPaginatedQuery(
      input.getRefName(ref),
      args ?? {},
      options,
    );

    const notify = () => {
      try {
        callback(
          watch.localQueryResult(),
          "Second argument to onUpdate callback is reserved for later use",
        );
      } catch (error) {
        const normalized = input.asError(error);
        if (onError) {
          onError(
            normalized,
            "Second argument to onUpdate onError is reserved for later use",
          );
        } else {
          void Promise.reject(normalized);
        }
      }
    };

    const unsubscribe = watch.onUpdate(notify) as any;
    unsubscribe.unsubscribe = unsubscribe;
    unsubscribe.getCurrentValue = () => watch.localQueryResult();
    unsubscribe.getQueryLogs = () => watch.localQueryLogs();
    return unsubscribe;
  };
}

function patchBaseClientLocalQueryAccess(input: {
  client: ConvexClient;
  runtime: EmbeddedRuntime;
  resolveReadPlanByName: (refName: string) => ReadPlan;
}) {
  const baseClient = (input.client as any).client as any;
  if (!baseClient) {
    return;
  }

  const originalLocalQueryResult =
    baseClient.localQueryResult?.bind(baseClient);
  const originalLocalQueryLogs = baseClient.localQueryLogs?.bind(baseClient);

  if (typeof originalLocalQueryResult === "function") {
    baseClient.localQueryResult = (
      refName: string,
      args: Record<string, unknown>,
    ) => {
      if (input.resolveReadPlanByName(refName).kind !== "local") {
        return originalLocalQueryResult(refName, args);
      }

      return input.runtime
        .watchLocalQuery(refName, args ?? {})
        .localQueryResult();
    };
  }

  if (typeof originalLocalQueryLogs === "function") {
    baseClient.localQueryLogs = (
      refName: string,
      args: Record<string, unknown>,
    ) => {
      if (input.resolveReadPlanByName(refName).kind !== "local") {
        return originalLocalQueryLogs(refName, args);
      }

      return input.runtime
        .watchLocalQuery(refName, args ?? {})
        .localQueryLogs();
    };
  }
}

function deferSubscription(input: {
  factory: () => Promise<any>;
  asError: (error: unknown) => Error;
  onInitError?: (error: Error) => void;
}): any {
  let inner: any = null;
  let cancelled = false;

  const unsubscribe = (() => {
    cancelled = true;
    if (typeof inner === "function") {
      inner();
    } else if (inner && typeof inner.unsubscribe === "function") {
      inner.unsubscribe();
    }
  }) as any;

  unsubscribe.unsubscribe = unsubscribe;
  unsubscribe.getCurrentValue = () => {
    if (inner && typeof inner.getCurrentValue === "function") {
      return inner.getCurrentValue();
    }
    return undefined;
  };
  unsubscribe.getQueryLogs = () => {
    if (inner && typeof inner.getQueryLogs === "function") {
      return inner.getQueryLogs();
    }
    return undefined;
  };

  void input
    .factory()
    .then((actual) => {
      if (cancelled) {
        if (typeof actual === "function") {
          actual();
        } else if (actual && typeof actual.unsubscribe === "function") {
          actual.unsubscribe();
        }
        return;
      }
      inner = actual;
    })
    .catch((error) => {
      const normalized = input.asError(error);
      if (input.onInitError) {
        try {
          input.onInitError(normalized);
          return;
        } catch {
          /* listener error */
        }
      }
      console.error(
        "[convex-embedded] failed to initialize subscription",
        normalized,
      );
    });

  return unsubscribe;
}

type WaitUntilReady = <T>(run: () => Promise<T>) => Promise<T>;

export function patchRoutedConvexClient(input: {
  client: ConvexClient;
  runtime: EmbeddedRuntime;
  remoteClient?: ConvexClient | null;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  resolveMutationPlan: (ref: unknown) => MutationPlan;
  resolveReadPlan: (ref: unknown) => ReadPlan;
  resolveReadPlanByName: (refName: string) => ReadPlan;
  executeLocalMutation: (
    ref: unknown,
    args: Record<string, unknown>,
    enqueueForReplay: boolean,
  ) => Promise<unknown>;
  waitUntilReady?: WaitUntilReady;
  isReady?: () => boolean;
  connectivity?: ConnectivityAdapter;
}) {
  patchBaseClientLocalQueryAccess({
    client: input.client,
    runtime: input.runtime,
    resolveReadPlanByName: input.resolveReadPlanByName,
  });

  const localOnUpdate = createRuntimeLocalOnUpdate({
    runtime: input.runtime,
    getRefName: input.getRefName,
    asError: input.asError,
  });
  const localPaginatedOnUpdate = createRuntimeLocalPaginatedOnUpdate({
    runtime: input.runtime,
    getRefName: input.getRefName,
    asError: input.asError,
  });
  const remoteClient = input.remoteClient ?? null;
  const waitUntilReady = input.waitUntilReady ?? ((run) => run());
  const isReady = input.isReady ?? (() => true);

  const executeLocalRead = (
    ref: unknown,
    args: Record<string, unknown>,
    kind: "query" | "action",
  ) =>
    input.runtime.executeLocal({
      kind,
      path: input.getRefName(ref),
      args,
    });

  const createSubscriptionFactory = (
    localSubscribe: (...args: any[]) => any,
    remoteSubscribe: (...args: any[]) => any,
    errorArgIndex: number,
  ) => {
    const subscribeWithRoute = (...args: any[]): any => {
      const route = input.resolveReadPlan(args[0]);
      if (route.kind === "local") {
        return localSubscribe(...args);
      }
      if (route.kind === "error") {
        throw route.error;
      }

      if (isOffline(input.connectivity)) {
        let error: Error;
        try {
          assertRemotePlanOnline(route);
          error = new Error("unreachable");
        } catch (current) {
          error = input.asError(current);
        }
        const onError = args[errorArgIndex];
        if (typeof onError === "function") {
          onError(error);
          return createNoopUnsubscribe();
        }
        throw error;
      }

      return remoteSubscribe(...args);
    };

    return (...args: any[]): any => {
      if (isReady()) {
        return subscribeWithRoute(...args);
      }

      const onInitError = args[errorArgIndex];
      return deferSubscription({
        factory: () => waitUntilReady(async () => subscribeWithRoute(...args)),
        asError: input.asError,
        onInitError:
          typeof onInitError === "function" ? onInitError : undefined,
      });
    };
  };

  (input.client as any).mutation = async function patchedMutation(
    ...args: Parameters<typeof input.client.mutation>
  ): Promise<any> {
    return waitUntilReady(async () => {
      const route = input.resolveMutationPlan(args[0]);
      return route.kind === "error"
        ? Promise.reject(route.error)
        : route.kind === "local"
          ? input.executeLocalMutation(
              args[0],
              (args[1] ?? {}) as Record<string, unknown>,
              route.enqueueForReplay,
            )
          : (() => {
              assertRemotePlanOnline(route);
              if (!remoteClient) {
                throw Cv.error({
                  code: "REMOTE_CLIENT_UNAVAILABLE",
                  message:
                    "[convex-embedded] Remote mutation execution was requested, but no remote client is configured. " +
                    "Add ClientOptions.remote or remove remoteOnly().",
                  kind: "mutation",
                });
              }
              return (remoteClient as any).mutation(...args);
            })();
    });
  };

  (input.client as any).query = async function patchedQuery(
    ...args: Parameters<typeof input.client.query>
  ): Promise<any> {
    return waitUntilReady(async () => {
      const route = input.resolveReadPlan(args[0]);
      return route.kind === "error"
        ? Promise.reject(route.error)
        : route.kind === "local"
          ? executeLocalRead(
              args[0],
              (args[1] ?? {}) as Record<string, unknown>,
              "query",
            )
          : (() => {
              assertRemotePlanOnline(route);
              if (!remoteClient) {
                throw Cv.error({
                  code: "REMOTE_CLIENT_UNAVAILABLE",
                  message:
                    "[convex-embedded] Remote query execution was requested, but no remote client is configured. " +
                    "Add ClientOptions.remote or remove remoteOnly().",
                  kind: "query",
                });
              }
              return (remoteClient as any).query(...args);
            })();
    });
  };

  (input.client as any).action = async function patchedAction(
    ...args: Parameters<typeof input.client.action>
  ): Promise<any> {
    return waitUntilReady(async () => {
      const route = input.resolveReadPlan(args[0]);
      return route.kind === "error"
        ? Promise.reject(route.error)
        : route.kind === "local"
          ? executeLocalRead(
              args[0],
              (args[1] ?? {}) as Record<string, unknown>,
              "action",
            )
          : (() => {
              assertRemotePlanOnline(route);
              if (!remoteClient) {
                throw Cv.error({
                  code: "REMOTE_CLIENT_UNAVAILABLE",
                  message:
                    "[convex-embedded] Remote action execution was requested, but no remote client is configured. " +
                    "Add ClientOptions.remote or remove remoteOnly().",
                  kind: "action",
                });
              }
              return (remoteClient as any).action(...args);
            })();
    });
  };

  (input.client as any).onUpdate = createSubscriptionFactory(
    localOnUpdate,
    remoteClient
      ? (remoteClient as any).onUpdate.bind(remoteClient)
      : () => createNoopUnsubscribe(),
    3,
  );

  if (
    typeof (input.client as any).onPaginatedUpdate_experimental === "function"
  ) {
    (input.client as any).onPaginatedUpdate_experimental =
      createSubscriptionFactory(
        localPaginatedOnUpdate,
        remoteClient
          ? (remoteClient as any).onPaginatedUpdate_experimental.bind(
              remoteClient,
            )
          : () => createNoopUnsubscribe(),
        4,
      );
  }
}
