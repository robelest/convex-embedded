import { ConvexClient } from "convex/browser";
import type { ConvexClientOptions, MutationOptions } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { ConvexError } from "convex/values";

import {
  createCachePipeline,
  createCacheOnUpdate,
  createCachePaginatedOnUpdate,
  createNoopUnsubscribe,
  createRuntimeLocalOnUpdate,
  createRuntimeLocalPaginatedOnUpdate,
  deferSubscription,
  deleteActiveSubscriptionsAccessor,
  isPageResultShape,
  isPlainObject,
  isSystemRefName,
  registerActiveSubscriptionsAccessor,
  toClientResult,
} from "@/client/adapter";
import type {
  CachePipeline,
  ExplicitOptimisticCallback,
  RoutedClientInput,
} from "@/client/adapter";
import { effectToTransitions } from "@/client/optimistic/apply";
import { deriveOptimisticEffect } from "@/client/optimistic/derive";
import { assertRemotePlanOnline } from "@/client/routing/plan";
import type { LocalPaginatedQueryResult } from "@/runtime/embedded";
import { isConnectivityOffline } from "@/runtime/platform";
import { createLogger } from "@/shared/logger";
import type { WorkScheduler } from "@/shared/work";

const log = createLogger("embedded-client");

type RoutingConfig = Omit<RoutedClientInput, "client">;

type SubscribeFn = (...args: unknown[]) => unknown;

export interface SubscriptionHelpers {
  localOnUpdate: SubscribeFn;
  localPaginatedOnUpdate: SubscribeFn;
  remoteOnUpdate: SubscribeFn;
  remotePaginatedOnUpdate: SubscribeFn;
}

export class EmbeddedClient extends ConvexClient {
  /** @internal — set by patchRoutedConvexClient during installation. */
  _routing: RoutingConfig | null = null;
  /** @internal */
  _pipeline: CachePipeline | null = null;
  /** @internal */
  _explicitOptimistic: WeakMap<object, ExplicitOptimisticCallback> =
    new WeakMap();
  /** @internal */
  _subscriptions: SubscriptionHelpers | null = null;

  constructor(address: string, options?: ConvexClientOptions) {
    super(address, options);
    // Bind routed implementations as instance properties so they shadow
    // any own-properties set by the parent constructor (test mocks
    // initialize `mutation` etc. as instance fields).
    this.mutation = this._routedMutation.bind(this) as ConvexClient["mutation"];
    this.query = this._routedQuery.bind(this) as ConvexClient["query"];
    this.action = this._routedAction.bind(this) as ConvexClient["action"];
    this.onUpdate = this._routedOnUpdate.bind(this) as ConvexClient["onUpdate"];
    (
      this as unknown as Record<string, SubscribeFn>
    ).onPaginatedUpdate_experimental = this._routedOnPaginatedUpdate.bind(this);
  }

  /**
   * Install embedded routing on this client. Builds the cache pipeline (if
   * a cache is provided), the optimistic-update registry, the four
   * subscription helper closures (local/remote × update/paginated), and the
   * cache-aware localQueryResult/localQueryLogs overrides. Returns a
   * dispose handle that tears down the pipeline + accessor registration.
   */
  installRouting(input: RoutingConfig): { dispose: () => void } {
    const cache = input.cache ?? null;
    const getCacheStorage = input.getCacheStorage ?? (() => null);
    const remoteClient = input.remoteClient ?? null;

    const explicitOptimistic = new WeakMap<
      object,
      ExplicitOptimisticCallback
    >();

    const pipeline = cache
      ? createCachePipeline({
          cache,
          getCacheStorage,
          remoteClient,
          connectivity: input.connectivity,
          asError: input.asError,
          runtime: input.runtime,
          ensureReadReady: input.ensureReadReady,
          releaseRead: input.releaseRead,
          translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
        })
      : null;

    if (pipeline) {
      registerActiveSubscriptionsAccessor(this, {
        list: () => pipeline.listActiveSubscriptions(),
        onChange: (listener) => pipeline.onSubscriptionsChange(listener),
      });
    }

    const runtimeLocalOnUpdate = createRuntimeLocalOnUpdate({
      runtime: input.runtime,
      getRefName: input.getRefName,
      asError: input.asError,
      ensureReadReady: input.ensureReadReady,
      translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
      translateLocalResultToClient: input.translateLocalResultToClient,
    });
    const runtimeLocalPaginatedOnUpdate = createRuntimeLocalPaginatedOnUpdate({
      runtime: input.runtime,
      getRefName: input.getRefName,
      asError: input.asError,
      ensureReadReady: input.ensureReadReady,
      translateLocalArgsToRuntime: input.translateLocalArgsToRuntime,
      translateLocalResultToClient: input.translateLocalResultToClient,
    });
    const cacheOnUpdate = pipeline
      ? createCacheOnUpdate({
          pipeline,
          getRefName: input.getRefName,
          asError: input.asError,
          translateLocalResultToClient: input.translateLocalResultToClient,
        })
      : null;
    const cachePaginatedOnUpdate = pipeline
      ? createCachePaginatedOnUpdate({
          pipeline,
          getRefName: input.getRefName,
          asError: input.asError,
          translateLocalResultToClient: input.translateLocalResultToClient,
        })
      : null;

    const localOnUpdate: SubscribeFn = (...args) => {
      const [ref, queryArgs, callback, onError] = args as [
        unknown,
        Record<string, unknown>,
        (result: unknown, meta?: unknown) => unknown,
        ((error: Error, meta?: unknown) => unknown) | undefined,
      ];
      const refName = input.getRefName(ref);
      if (cacheOnUpdate && !isSystemRefName(refName)) {
        return cacheOnUpdate(ref, queryArgs, callback, onError);
      }
      return runtimeLocalOnUpdate(ref, queryArgs, callback, onError);
    };

    const localPaginatedOnUpdate: SubscribeFn = (...args) => {
      const [ref, queryArgs, options, callback, onError] = args as [
        unknown,
        Record<string, unknown>,
        { initialNumItems: number },
        (result: unknown, meta?: unknown) => unknown,
        ((error: Error, meta?: unknown) => unknown) | undefined,
      ];
      const refName = input.getRefName(ref);
      if (cachePaginatedOnUpdate && !isSystemRefName(refName)) {
        return cachePaginatedOnUpdate(
          ref,
          queryArgs,
          options,
          callback,
          onError,
        );
      }
      return runtimeLocalPaginatedOnUpdate(
        ref,
        queryArgs,
        options,
        callback,
        onError,
      );
    };

    const translateRemoteArgs = (args: unknown): unknown => {
      if (!isPlainObject(args)) return args;
      return input.translateClientArgsToRemote?.(args) ?? args;
    };

    const remoteOnUpdate: SubscribeFn = remoteClient
      ? (...args) => {
          const remoteArgs = [...args];
          remoteArgs[1] = translateRemoteArgs(remoteArgs[1] ?? {});
          return (
            remoteClient as unknown as {
              onUpdate(...args: unknown[]): unknown;
            }
          ).onUpdate(...remoteArgs);
        }
      : () => createNoopUnsubscribe();

    const remotePaginatedOnUpdate: SubscribeFn = remoteClient
      ? (...args) => {
          const remoteArgs = [...args];
          remoteArgs[1] = translateRemoteArgs(remoteArgs[1] ?? {});
          return (
            remoteClient as unknown as {
              onPaginatedUpdate_experimental?(...args: unknown[]): unknown;
            }
          ).onPaginatedUpdate_experimental?.(...remoteArgs);
        }
      : () => createNoopUnsubscribe();

    this._routing = input;
    this._pipeline = pipeline;
    this._explicitOptimistic = explicitOptimistic;
    this._subscriptions = {
      localOnUpdate,
      localPaginatedOnUpdate,
      remoteOnUpdate,
      remotePaginatedOnUpdate,
    };
    this._installLocalQueryAccess();

    return {
      dispose: () => {
        if (pipeline) {
          deleteActiveSubscriptionsAccessor(this);
          pipeline.dispose();
        }
      },
    };
  }

  /**
   * Override the internal `client.localQueryResult` / `client.localQueryLogs`
   * accessors to consult the embedded runtime (and cache, if present) before
   * falling back to the original ConvexClient behavior.
   */
  private _installLocalQueryAccess(): void {
    const routing = this._routing;
    if (!routing) return;
    const baseClient = (
      this as unknown as {
        client?: {
          localQueryResult?: (
            refName: string,
            args: Record<string, unknown>,
          ) => unknown;
          localQueryLogs?: (
            refName: string,
            args: Record<string, unknown>,
          ) => string[] | undefined;
        };
      }
    ).client;
    if (!baseClient) return;

    const originalLocalQueryResult =
      baseClient.localQueryResult?.bind(baseClient);
    const originalLocalQueryLogs = baseClient.localQueryLogs?.bind(baseClient);

    if (typeof originalLocalQueryResult === "function") {
      baseClient.localQueryResult = (
        refName: string,
        args: Record<string, unknown>,
      ) => {
        if (routing.planReadByName(refName).kind !== "local") {
          return originalLocalQueryResult(refName, args);
        }
        if (
          routing.cache &&
          !refName.startsWith("_system:") &&
          this._pipeline
        ) {
          const cached = routing.cache.get(refName, args ?? {});
          if (cached !== undefined) {
            return toClientResult(
              cached.value,
              routing.translateLocalResultToClient,
            );
          }
        }
        const translatedArgs =
          routing.translateLocalArgsToRuntime?.(args ?? {}) ?? args ?? {};
        void routing.ensureReadReady?.(refName, args ?? {});
        const result = routing.runtime
          .watchLocalQuery(refName, translatedArgs)
          .localQueryResult();
        return toClientResult(result, routing.translateLocalResultToClient);
      };
    }

    if (typeof originalLocalQueryLogs === "function") {
      baseClient.localQueryLogs = (
        refName: string,
        args: Record<string, unknown>,
      ) => {
        if (routing.planReadByName(refName).kind !== "local") {
          return originalLocalQueryLogs(refName, args);
        }
        return routing.runtime
          .watchLocalQuery(refName, args ?? {})
          .localQueryLogs();
      };
    }
  }

  private async _routedMutation<M extends FunctionReference<"mutation">>(
    mutationRef: M,
    args: FunctionArgs<M>,
    options?: MutationOptions,
  ): Promise<Awaited<FunctionReturnType<M>>> {
    const routing = this._routing;
    if (!routing) {
      throw new Error(
        "[convex-embedded] EmbeddedClient.mutation called before routing was installed.",
      );
    }

    const argsObj = (args ?? {}) as Record<string, unknown>;
    if (this._pipeline) {
      try {
        const refName = routing.getRefName(mutationRef);
        const pipeline = this._pipeline;
        const explicit =
          typeof mutationRef === "object" && mutationRef !== null
            ? this._explicitOptimistic.get(mutationRef)
            : undefined;
        const updates = explicit
          ? explicit(
              { getQuery: pipeline.getCurrentValue.bind(pipeline) },
              argsObj,
            )
          : (() => {
              const effect = deriveOptimisticEffect({
                refName,
                args: argsObj,
                knownTables: routing.knownTables,
              });
              if (!effect || !routing.cache) return [];
              return effectToTransitions(effect, routing.cache);
            })();
        if (updates.length > 0) {
          pipeline.applyOptimisticTransition(updates);
        }
      } catch (error) {
        log.warn("optimistic apply failed:", error);
      }
    }

    const waitUntilReady = routing.waitUntilReady ?? ((run) => run());
    return waitUntilReady(async () => {
      const route = routing.planMutation(mutationRef);
      if (route.kind === "error") throw route.error;
      if (route.kind === "local") {
        try {
          return (await routing.executeLocalMutation(
            mutationRef,
            argsObj,
            route.enqueueForReplay,
          )) as Awaited<FunctionReturnType<M>>;
        } catch (error) {
          throw routing.asError(error);
        }
      }
      try {
        assertRemotePlanOnline(route, routing.connectivity);
        const remote = routing.remoteClient;
        if (!remote) {
          throw new ConvexError({
            code: "REMOTE_CLIENT_UNAVAILABLE",
            message:
              "[convex-embedded] Remote mutation execution was requested, but no remote client is configured. " +
              "Add ClientOptions.remote or remove remoteOnly().",
            kind: "mutation",
          });
        }
        const remoteArgs =
          routing.translateClientArgsToRemote?.(argsObj) ?? argsObj;
        const result =
          options === undefined
            ? await remote.mutation(mutationRef, remoteArgs as FunctionArgs<M>)
            : await remote.mutation(
                mutationRef,
                remoteArgs as FunctionArgs<M>,
                options,
              );
        return result as Awaited<FunctionReturnType<M>>;
      } catch (error) {
        throw routing.asError(error);
      }
    });
  }

  private async _executeLocalRead(
    ref: unknown,
    args: Record<string, unknown>,
    kind: "query" | "action",
  ): Promise<unknown> {
    const routing = this._routing!;
    const translatedArgs = routing.translateLocalArgsToRuntime?.(args) ?? args;
    try {
      const result = await routing.runtime.executeLocal({
        kind,
        path: routing.getRefName(ref),
        args: translatedArgs,
      });
      return toClientResult(result, routing.translateLocalResultToClient);
    } catch (error) {
      throw routing.asError(error);
    }
  }

  private _routedQuery<Q extends FunctionReference<"query">>(
    queryRef: Q,
    args: Q["_args"],
  ): Promise<Awaited<Q["_returnType"]>> {
    return this._routedRead(queryRef, args, "query");
  }

  private _routedAction<A extends FunctionReference<"action">>(
    actionRef: A,
    args: FunctionArgs<A>,
  ): Promise<Awaited<FunctionReturnType<A>>> {
    return this._routedRead(actionRef, args, "action");
  }

  private async _routedRead<R extends FunctionReference<"query" | "action">>(
    ref: R,
    args: FunctionArgs<R>,
    kind: "query" | "action",
  ): Promise<Awaited<FunctionReturnType<R>>> {
    const routing = this._routing;
    if (!routing) {
      throw new Error(
        `[convex-embedded] EmbeddedClient.${kind} called before routing was installed.`,
      );
    }
    const argsObj = (args ?? {}) as Record<string, unknown>;
    const waitUntilReady = routing.waitUntilReady ?? ((run) => run());
    return waitUntilReady(async () => {
      const route = routing.planRead(ref);
      if (route.kind === "error") throw route.error;
      if (route.kind === "local") {
        try {
          await routing.ensureReadReady?.(routing.getRefName(ref), argsObj);
          return (await this._executeLocalRead(ref, argsObj, kind)) as Awaited<
            FunctionReturnType<R>
          >;
        } catch (error) {
          throw routing.asError(error);
        }
      }
      try {
        assertRemotePlanOnline(route, routing.connectivity);
        const remote = routing.remoteClient;
        if (!remote) {
          throw new ConvexError({
            code: "REMOTE_CLIENT_UNAVAILABLE",
            message:
              `[convex-embedded] Remote ${kind} execution was requested, but no remote client is configured. ` +
              "Add ClientOptions.remote or remove remoteOnly().",
            kind,
          });
        }
        const remoteArgs =
          routing.translateClientArgsToRemote?.(argsObj) ?? argsObj;
        if (kind === "query") {
          return (await remote.query(
            ref as FunctionReference<"query">,
            remoteArgs as FunctionArgs<FunctionReference<"query">>,
          )) as Awaited<FunctionReturnType<R>>;
        }
        return (await remote.action(
          ref as FunctionReference<"action">,
          remoteArgs as FunctionArgs<FunctionReference<"action">>,
        )) as Awaited<FunctionReturnType<R>>;
      } catch (error) {
        throw routing.asError(error);
      }
    });
  }

  peekCurrentValue(ref: unknown, args: unknown): unknown {
    const routing = this._routing;
    if (!routing || !this._pipeline) return undefined;
    const refName = routing.getRefName(ref);
    const raw = this._pipeline.getCurrentValue(refName, args ?? {});
    if (raw === undefined) return undefined;
    return toClientResult(raw, routing.translateLocalResultToClient);
  }

  peekPaginatedCurrentValue(
    ref: unknown,
    args: unknown,
    options: { initialNumItems: number },
  ): unknown {
    const routing = this._routing;
    if (!routing || !this._pipeline) return undefined;
    const refName = routing.getRefName(ref);
    const argRecord = (args ?? {}) as Record<string, unknown>;
    const existingPaginationOpts = isPlainObject(argRecord.paginationOpts)
      ? (argRecord.paginationOpts as Record<string, unknown>)
      : {};
    const { paginationOpts: _ignored, ...restArgs } = argRecord;
    void _ignored;
    const firstPageArgs: Record<string, unknown> = {
      ...restArgs,
      paginationOpts: {
        ...existingPaginationOpts,
        cursor: null,
        endCursor: null,
        numItems: options.initialNumItems,
      },
    };
    const raw = this._pipeline.getCurrentValue(refName, firstPageArgs);
    if (raw === undefined || !isPageResultShape(raw)) return undefined;
    const snapshot: LocalPaginatedQueryResult = {
      results: raw.page,
      status: raw.isDone ? "Exhausted" : "CanLoadMore",
      loadMore: () => false,
    };
    return toClientResult(snapshot, routing.translateLocalResultToClient);
  }

  applyOptimisticTransition(
    updates: Array<{ refName: string; args: unknown; value: unknown }>,
  ): void {
    this._pipeline?.applyOptimisticTransition(updates);
  }

  registerOptimisticUpdate(
    ref: unknown,
    callback: ExplicitOptimisticCallback,
  ): void {
    if (typeof ref !== "object" || ref === null) return;
    this._explicitOptimistic.set(ref, callback);
  }

  setWorkScheduler(scheduler: WorkScheduler | null): void {
    this._pipeline?.setWorkScheduler(scheduler);
  }

  getWorkScheduler(): WorkScheduler | undefined {
    return this._pipeline?.getWorkScheduler();
  }

  dispatchHttpRequest(request: Request): Promise<Response> {
    const routing = this._routing;
    if (!routing) {
      return Promise.reject(
        new Error(
          "[convex-embedded] EmbeddedClient.dispatchHttpRequest called before routing was installed.",
        ),
      );
    }
    return routing.runtime.dispatchHttpRequest(request);
  }

  private _routedOnUpdate(...args: unknown[]): unknown {
    return this._routedSubscribe(args, "update");
  }

  private _routedOnPaginatedUpdate(...args: unknown[]): unknown {
    return this._routedSubscribe(args, "paginated");
  }

  private _routedSubscribe(
    args: unknown[],
    kind: "update" | "paginated",
  ): unknown {
    const routing = this._routing;
    const subs = this._subscriptions;
    if (!routing || !subs) {
      throw new Error(
        "[convex-embedded] EmbeddedClient subscription called before routing was installed.",
      );
    }
    const localSubscribe =
      kind === "update" ? subs.localOnUpdate : subs.localPaginatedOnUpdate;
    const remoteSubscribe =
      kind === "update" ? subs.remoteOnUpdate : subs.remotePaginatedOnUpdate;
    const errorArgIndex = kind === "update" ? 3 : 4;

    const subscribeWithRoute = (): unknown => {
      const route = routing.planRead(args[0]);
      if (route.kind === "local") return localSubscribe(...args);
      if (route.kind === "error") throw route.error;
      if (isConnectivityOffline(routing.connectivity)) {
        let error: Error;
        try {
          assertRemotePlanOnline(route, routing.connectivity);
          error = new Error("unreachable");
        } catch (current) {
          error = routing.asError(current);
        }
        const onError = args[errorArgIndex];
        if (typeof onError === "function") {
          (onError as (err: Error) => void)(error);
          return createNoopUnsubscribe();
        }
        throw error;
      }
      return remoteSubscribe(...args);
    };

    const isReady = routing.isReady ?? (() => true);
    if (isReady()) return subscribeWithRoute();

    const onInitError = args[errorArgIndex];
    const waitUntilReady = routing.waitUntilReady ?? ((run) => run());
    return deferSubscription({
      factory: () => waitUntilReady(async () => subscribeWithRoute()),
      asError: routing.asError,
      onInitError:
        typeof onInitError === "function"
          ? (onInitError as (error: Error) => void)
          : undefined,
    });
  }
}
