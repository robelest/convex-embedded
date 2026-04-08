import { Fx } from "@robelest/fx";
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
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  translateLocalResultToClient?: <T>(value: T) => T;
}) {
  return (
    ref: unknown,
    args: Record<string, unknown>,
    callback: (result: unknown, meta?: unknown) => unknown,
    onError?: (error: Error, meta?: unknown) => unknown,
  ) => {
    const translatedArgs =
      input.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
    const watch = input.runtime.watchLocalQuery(
      input.getRefName(ref),
      translatedArgs,
    );

    const notify = () => {
      try {
        callback(
          input.translateLocalResultToClient?.(watch.localQueryResult()) ??
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
    unsubscribe.getCurrentValue = () =>
      input.translateLocalResultToClient?.(watch.localQueryResult()) ??
      watch.localQueryResult();
    unsubscribe.getQueryLogs = () => watch.localQueryLogs();
    return unsubscribe;
  };
}

function createRuntimeLocalPaginatedOnUpdate(input: {
  runtime: EmbeddedRuntime;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  translateLocalResultToClient?: <T>(value: T) => T;
}) {
  return (
    ref: unknown,
    args: Record<string, unknown>,
    options: { initialNumItems: number },
    callback: (result: unknown, meta?: unknown) => unknown,
    onError?: (error: Error, meta?: unknown) => unknown,
  ) => {
    const translatedArgs =
      input.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
    const watch = input.runtime.watchLocalPaginatedQuery(
      input.getRefName(ref),
      translatedArgs,
      options,
    );

    const notify = () => {
      try {
        callback(
          input.translateLocalResultToClient?.(watch.localQueryResult()) ??
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
    unsubscribe.getCurrentValue = () =>
      input.translateLocalResultToClient?.(watch.localQueryResult()) ??
      watch.localQueryResult();
    unsubscribe.getQueryLogs = () => watch.localQueryLogs();
    return unsubscribe;
  };
}

function patchBaseClientLocalQueryAccess(input: {
  client: ConvexClient;
  runtime: EmbeddedRuntime;
  resolveReadPlanByName: (refName: string) => ReadPlan;
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  translateLocalResultToClient?: <T>(value: T) => T;
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

      const translatedArgs =
        input.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
      const result = input.runtime
        .watchLocalQuery(refName, translatedArgs)
        .localQueryResult();
      return input.translateLocalResultToClient?.(result) ?? result;
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

  Fx.detach(
    () =>
      Fx.run(
        Fx.from({
          ok: () => input.factory(),
          err: (error) => input.asError(error),
        }).pipe(
          Fx.tap((actual) =>
            Fx.sync(() => {
              if (cancelled) {
                if (typeof actual === "function") {
                  actual();
                } else if (actual && typeof actual.unsubscribe === "function") {
                  actual.unsubscribe();
                }
                return;
              }
              inner = actual;
            }),
          ),
          Fx.recover((error) =>
            Fx.sync(() => {
              if (input.onInitError) {
                try {
                  input.onInitError(error);
                  return;
                } catch {
                  /* listener error */
                }
              }
              console.error(
                "[convex-embedded] failed to initialize subscription",
                error,
              );
            }),
          ),
        ),
      ),
    "[adapter] deferSubscription:",
  );

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
  translateLocalArgsToRuntime?: (
    args: Record<string, unknown>,
  ) => Record<string, unknown>;
  translateLocalResultToClient?: <T>(value: T) => T;
  waitUntilReady?: WaitUntilReady;
  isReady?: () => boolean;
  connectivity?: ConnectivityAdapter;
}) {
  patchBaseClientLocalQueryAccess({
    client: input.client,
    runtime: input.runtime,
    resolveReadPlanByName: input.resolveReadPlanByName,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
  });

  const localOnUpdate = createRuntimeLocalOnUpdate({
    runtime: input.runtime,
    getRefName: input.getRefName,
    asError: input.asError,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
  });
  const localPaginatedOnUpdate = createRuntimeLocalPaginatedOnUpdate({
    runtime: input.runtime,
    getRefName: input.getRefName,
    asError: input.asError,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
  });
  const remoteClient = input.remoteClient ?? null;
  const waitUntilReady = input.waitUntilReady ?? ((run) => run());
  const isReady = input.isReady ?? (() => true);

  const executeLocalRead = (
    ref: unknown,
    args: Record<string, unknown>,
    kind: "query" | "action",
  ) => {
    const translatedArgs = input.translateLocalArgsToRuntime?.(args) ?? args;
    return Fx.run(
      Fx.from({
        ok: () =>
          input.runtime.executeLocal({
            kind,
            path: input.getRefName(ref),
            args: translatedArgs,
          }),
        err: (error) => input.asError(error),
      }).pipe(
        Fx.map(
          (result) => input.translateLocalResultToClient?.(result) ?? result,
        ),
      ),
    );
  };

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

  (input.client as any).mutation = function patchedMutation(
    ...args: Parameters<typeof input.client.mutation>
  ): Promise<any> {
    return waitUntilReady(() => {
      const route = input.resolveMutationPlan(args[0]);
      return Fx.run(
        Fx.defer(() => {
          if (route.kind === "error") {
            return Fx.fail(route.error);
          }
          if (route.kind === "local") {
            return Fx.from({
              ok: () =>
                input.executeLocalMutation(
                  args[0],
                  (args[1] ?? {}) as Record<string, unknown>,
                  route.enqueueForReplay,
                ),
              err: (error) => input.asError(error),
            });
          }

          return Fx.from({
            ok: () => {
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
            },
            err: (error) => input.asError(error),
          });
        }),
      );
    });
  };

  (input.client as any).query = function patchedQuery(
    ...args: Parameters<typeof input.client.query>
  ): Promise<any> {
    return waitUntilReady(() => {
      const route = input.resolveReadPlan(args[0]);
      return Fx.run(
        Fx.defer(() => {
          if (route.kind === "error") {
            return Fx.fail(route.error);
          }
          if (route.kind === "local") {
            return Fx.from({
              ok: () =>
                executeLocalRead(
                  args[0],
                  (args[1] ?? {}) as Record<string, unknown>,
                  "query",
                ),
              err: (error) => input.asError(error),
            });
          }

          return Fx.from({
            ok: () => {
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
            },
            err: (error) => input.asError(error),
          });
        }),
      );
    });
  };

  (input.client as any).action = function patchedAction(
    ...args: Parameters<typeof input.client.action>
  ): Promise<any> {
    return waitUntilReady(() => {
      const route = input.resolveReadPlan(args[0]);
      return Fx.run(
        Fx.defer(() => {
          if (route.kind === "error") {
            return Fx.fail(route.error);
          }
          if (route.kind === "local") {
            return Fx.from({
              ok: () =>
                executeLocalRead(
                  args[0],
                  (args[1] ?? {}) as Record<string, unknown>,
                  "action",
                ),
              err: (error) => input.asError(error),
            });
          }

          return Fx.from({
            ok: () => {
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
            },
            err: (error) => input.asError(error),
          });
        }),
      );
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
