import type { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";

import {
  assertRemotePlanOnline,
  type MutationPlan,
  type ReadPlan,
} from "@/client/routing/plan";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import {
  isConnectivityOffline,
  type ConnectivityAdapter,
} from "@/runtime/platform";

function createNoopUnsubscribe(): any {
  const noop = (() => {}) as any;
  noop.unsubscribe = noop;
  noop.getCurrentValue = () => undefined;
  noop.getQueryLogs = () => undefined;
  return noop;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function getStringId(value: unknown): string | null {
  return isPlainObject(value) && typeof value._id === "string"
    ? value._id
    : null;
}

function dedupeTranslatedArray(
  rawValues: unknown[],
  translatedValues: unknown[],
): unknown[] {
  const groups = new Map<
    string,
    { indexes: number[]; rawIds: Set<string>; translatedIds: Set<string> }
  >();

  for (let index = 0; index < translatedValues.length; index += 1) {
    const translatedId = getStringId(translatedValues[index]);
    if (translatedId === null) {
      continue;
    }
    const rawId = getStringId(rawValues[index]);
    const group = groups.get(translatedId) ?? {
      indexes: [],
      rawIds: new Set<string>(),
      translatedIds: new Set<string>(),
    };
    group.indexes.push(index);
    group.translatedIds.add(translatedId);
    if (rawId !== null) {
      group.rawIds.add(rawId);
    }
    groups.set(translatedId, group);
  }

  const keep = new Set<number>(translatedValues.map((_, index) => index));
  let changed = false;

  for (const group of groups.values()) {
    if (group.indexes.length < 2) {
      continue;
    }

    // Only collapse duplicates introduced by translation. If the raw result
    // already exposed the same _id multiple times, preserve that behavior.
    if (group.rawIds.size <= 1 && group.translatedIds.size === 1) {
      continue;
    }

    changed = true;
    const lastIndex = group.indexes[group.indexes.length - 1]!;
    for (const index of group.indexes) {
      if (index !== lastIndex) {
        keep.delete(index);
      }
    }
  }

  return changed
    ? translatedValues.filter((_, index) => keep.has(index))
    : translatedValues;
}

function normalizeClientResult(
  rawValue: unknown,
  translatedValue: unknown,
): unknown {
  if (Array.isArray(translatedValue)) {
    const rawItems = Array.isArray(rawValue) ? rawValue : [];
    const normalizedItems = translatedValue.map((entryValue, index) =>
      normalizeClientResult(rawItems[index], entryValue),
    );
    return dedupeTranslatedArray(rawItems, normalizedItems);
  }

  if (!isPlainObject(translatedValue)) {
    return translatedValue;
  }

  const rawEntries = isPlainObject(rawValue) ? rawValue : {};

  return Object.fromEntries(
    Object.entries(translatedValue).map(([key, entryValue]) => [
      key,
      normalizeClientResult(rawEntries[key], entryValue),
    ]),
  );
}

function toClientResult<T>(value: T, translate?: <U>(value: U) => U): T {
  const translated = translate?.(value) ?? value;
  return normalizeClientResult(value, translated) as T;
}

function createRuntimeLocalOnUpdate(input: {
  runtime: EmbeddedRuntime;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  ensureReadReady?: (
    refName: string,
    readArgs?: Record<string, unknown>,
  ) => Promise<void>;
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
    const refName = input.getRefName(ref);
    void input.ensureReadReady?.(refName, args ?? {});
    const translatedArgs =
      input.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
    const watch = input.runtime.watchLocalQuery(refName, translatedArgs);

    const notify = () => {
      try {
        callback(
          toClientResult(
            watch.localQueryResult(),
            input.translateLocalResultToClient,
          ),
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
      toClientResult(
        watch.localQueryResult(),
        input.translateLocalResultToClient,
      );
    unsubscribe.getQueryLogs = () => watch.localQueryLogs();
    return unsubscribe;
  };
}

function createRuntimeLocalPaginatedOnUpdate(input: {
  runtime: EmbeddedRuntime;
  getRefName: (ref: unknown) => string;
  asError: (error: unknown) => Error;
  ensureReadReady?: (
    refName: string,
    readArgs?: Record<string, unknown>,
  ) => Promise<void>;
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
    const refName = input.getRefName(ref);
    void input.ensureReadReady?.(refName, args ?? {});
    const translatedArgs =
      input.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
    const watch = input.runtime.watchLocalPaginatedQuery(
      refName,
      translatedArgs,
      options,
    );

    const notify = () => {
      try {
        callback(
          toClientResult(
            watch.localQueryResult(),
            input.translateLocalResultToClient,
          ),
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
      toClientResult(
        watch.localQueryResult(),
        input.translateLocalResultToClient,
      );
    unsubscribe.getQueryLogs = () => watch.localQueryLogs();
    return unsubscribe;
  };
}

function patchBaseClientLocalQueryAccess(input: {
  client: ConvexClient;
  runtime: EmbeddedRuntime;
  resolveReadPlanByName: (refName: string) => ReadPlan;
  ensureReadReady?: (
    refName: string,
    readArgs?: Record<string, unknown>,
  ) => Promise<void>;
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
      void input.ensureReadReady?.(refName, args ?? {});
      const result = input.runtime
        .watchLocalQuery(refName, translatedArgs)
        .localQueryResult();
      return toClientResult(result, input.translateLocalResultToClient);
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
    .then(
      (actual) => {
        if (cancelled) {
          if (typeof actual === "function") {
            actual();
          } else if (actual && typeof actual.unsubscribe === "function") {
            actual.unsubscribe();
          }
          return;
        }
        inner = actual;
      },
      (error) => {
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
      },
    )
    .catch((error: unknown) => {
      console.error("[adapter] deferSubscription:", error);
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
  ensureReadReady?: (
    refName: string,
    readArgs?: Record<string, unknown>,
  ) => Promise<void>;
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
    ensureReadReady: input.ensureReadReady,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
  });

  const localOnUpdate = createRuntimeLocalOnUpdate({
    runtime: input.runtime,
    getRefName: input.getRefName,
    asError: input.asError,
    ensureReadReady: input.ensureReadReady,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
  });
  const localPaginatedOnUpdate = createRuntimeLocalPaginatedOnUpdate({
    runtime: input.runtime,
    getRefName: input.getRefName,
    asError: input.asError,
    ensureReadReady: input.ensureReadReady,
    translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
    translateLocalResultToClient: input.translateLocalResultToClient,
  });
  const remoteClient = input.remoteClient ?? null;
  const waitUntilReady = input.waitUntilReady ?? ((run) => run());
  const isReady = input.isReady ?? (() => true);

  const executeLocalRead = async (
    ref: unknown,
    args: Record<string, unknown>,
    kind: "query" | "action",
  ) => {
    const translatedArgs = input.translateLocalArgsToRuntime?.(args) ?? args;
    try {
      const result = await input.runtime.executeLocal({
        kind,
        path: input.getRefName(ref),
        args: translatedArgs,
      });
      return toClientResult(result, input.translateLocalResultToClient);
    } catch (error) {
      throw input.asError(error);
    }
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

      if (isConnectivityOffline(input.connectivity)) {
        let error: Error;
        try {
          assertRemotePlanOnline(route, input.connectivity);
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
    return waitUntilReady(async () => {
      const route = input.resolveMutationPlan(args[0]);
      if (route.kind === "error") {
        throw route.error;
      }
      if (route.kind === "local") {
        try {
          return await input.executeLocalMutation(
            args[0],
            (args[1] ?? {}) as Record<string, unknown>,
            route.enqueueForReplay,
          );
        } catch (error) {
          throw input.asError(error);
        }
      }

      try {
        assertRemotePlanOnline(route, input.connectivity);
        if (!remoteClient) {
          throw new ConvexError({
            code: "REMOTE_CLIENT_UNAVAILABLE",
            message:
              "[convex-embedded] Remote mutation execution was requested, but no remote client is configured. " +
              "Add ClientOptions.remote or remove remoteOnly().",
            kind: "mutation",
          });
        }
        return await (remoteClient as any).mutation(...args);
      } catch (error) {
        throw input.asError(error);
      }
    });
  };

  (input.client as any).query = function patchedQuery(
    ...args: Parameters<typeof input.client.query>
  ): Promise<any> {
    return waitUntilReady(async () => {
      const route = input.resolveReadPlan(args[0]);
      if (route.kind === "error") {
        throw route.error;
      }
      if (route.kind === "local") {
        try {
          await input.ensureReadReady?.(
            input.getRefName(args[0]),
            (args[1] ?? {}) as Record<string, unknown>,
          );
          return await executeLocalRead(
            args[0],
            (args[1] ?? {}) as Record<string, unknown>,
            "query",
          );
        } catch (error) {
          throw input.asError(error);
        }
      }

      try {
        assertRemotePlanOnline(route, input.connectivity);
        if (!remoteClient) {
          throw new ConvexError({
            code: "REMOTE_CLIENT_UNAVAILABLE",
            message:
              "[convex-embedded] Remote query execution was requested, but no remote client is configured. " +
              "Add ClientOptions.remote or remove remoteOnly().",
            kind: "query",
          });
        }
        return await (remoteClient as any).query(...args);
      } catch (error) {
        throw input.asError(error);
      }
    });
  };

  (input.client as any).action = function patchedAction(
    ...args: Parameters<typeof input.client.action>
  ): Promise<any> {
    return waitUntilReady(async () => {
      const route = input.resolveReadPlan(args[0]);
      if (route.kind === "error") {
        throw route.error;
      }
      if (route.kind === "local") {
        try {
          await input.ensureReadReady?.(
            input.getRefName(args[0]),
            (args[1] ?? {}) as Record<string, unknown>,
          );
          return await executeLocalRead(
            args[0],
            (args[1] ?? {}) as Record<string, unknown>,
            "action",
          );
        } catch (error) {
          throw input.asError(error);
        }
      }

      try {
        assertRemotePlanOnline(route, input.connectivity);
        if (!remoteClient) {
          throw new ConvexError({
            code: "REMOTE_CLIENT_UNAVAILABLE",
            message:
              "[convex-embedded] Remote action execution was requested, but no remote client is configured. " +
              "Add ClientOptions.remote or remove remoteOnly().",
            kind: "action",
          });
        }
        return await (remoteClient as any).action(...args);
      } catch (error) {
        throw input.asError(error);
      }
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
