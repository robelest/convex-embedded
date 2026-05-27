import { ConvexClient } from "convex/browser";
import type { ConvexClientOptions, MutationOptions } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { ConvexError } from "convex/values";

import { toClientResult } from "@/client/adapter";
import type {
  CachePipeline,
  ExplicitOptimisticCallback,
  RoutedClientInput,
} from "@/client/adapter";
import { effectToTransitions } from "@/client/optimistic/apply";
import { deriveOptimisticEffect } from "@/client/optimistic/derive";
import { assertRemotePlanOnline } from "@/client/routing/plan";
import { createLogger } from "@/shared/logger";

const log = createLogger("embedded-client");

type RoutingConfig = Omit<RoutedClientInput, "client">;

export class EmbeddedClient extends ConvexClient {
  /** @internal — set by patchRoutedConvexClient during installation. */
  _routing: RoutingConfig | null = null;
  /** @internal */
  _pipeline: CachePipeline | null = null;
  /** @internal */
  _explicitOptimistic: WeakMap<object, ExplicitOptimisticCallback> =
    new WeakMap();

  constructor(address: string, options?: ConvexClientOptions) {
    super(address, options);
    // Bind routed implementations as instance properties so they shadow
    // any own-properties set by the parent constructor (test mocks
    // initialize `mutation` etc. as instance fields).
    this.mutation = this._routedMutation.bind(this) as ConvexClient["mutation"];
    this.query = this._routedQuery.bind(this) as ConvexClient["query"];
    this.action = this._routedAction.bind(this) as ConvexClient["action"];
  }

  /** @internal */
  _installRouting(
    routing: RoutingConfig,
    pipeline: CachePipeline | null,
    explicitOptimistic: WeakMap<object, ExplicitOptimisticCallback>,
  ): void {
    this._routing = routing;
    this._pipeline = pipeline;
    this._explicitOptimistic = explicitOptimistic;
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
}
