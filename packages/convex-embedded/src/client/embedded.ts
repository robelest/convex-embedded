import { ConvexClient } from "convex/browser";
import type { ConvexClientOptions, MutationOptions } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { ConvexError } from "convex/values";

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
}
