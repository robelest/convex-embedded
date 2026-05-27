import type { GenericDataModel, GenericQueryCtx } from "convex/server";

import type { ComponentBinding } from "@/server/schema";
import { parseErrorMetadata } from "@/shared/errors";
import { createLogger } from "@/shared/logger";

const log = createLogger("server-runtime");

export function isComponentUnavailableError(error: unknown): boolean {
  const { code, message } = parseErrorMetadata(error);
  if (code === "NESTED_COMPONENT_LOCAL_UNSUPPORTED") {
    return true;
  }
  return (
    message.includes("component unavailable") ||
    message.includes("local execution reached component function") ||
    message.includes("nested_component_local_unsupported") ||
    message.includes("function not found") ||
    message.includes("is not registered")
  );
}

/**
 * Per-table runtime detector. Probes the component once per `ctx` and
 * caches the result so subsequent hook invocations don't pay the network
 * round-trip again on the same request.
 */
export interface RuntimeDetector {
  detectRuntime(ctx: GenericQueryCtx<GenericDataModel>): Promise<boolean>;
}

export function createRuntimeDetector(
  tableName: string,
  component: ComponentBinding,
): RuntimeDetector {
  const runtimeCache = new WeakMap<object, boolean>();

  function cacheRuntimeValue(
    ctx: GenericQueryCtx<GenericDataModel>,
    isRemote: boolean,
  ): boolean {
    if (
      ctx !== null &&
      (typeof ctx === "object" || typeof ctx === "function")
    ) {
      runtimeCache.set(ctx, isRemote);
    }
    return isRemote;
  }

  return {
    async detectRuntime(ctx) {
      if (
        ctx !== null &&
        (typeof ctx === "object" || typeof ctx === "function")
      ) {
        const cached = runtimeCache.get(ctx);
        if (cached !== undefined) {
          return cached;
        }
      }
      try {
        await ctx.runQuery(component.public.getLiveStates, {
          collection: tableName,
          docIds: [],
        });
        log.debug(`detectRuntime(${tableName}): component resolved -> remote`);
        return cacheRuntimeValue(ctx, true);
      } catch (error) {
        if (!isComponentUnavailableError(error)) {
          throw error;
        }
        log.debug(
          `detectRuntime(${tableName}): component unavailable -> local`,
        );
        return cacheRuntimeValue(ctx, false);
      }
    },
  };
}
