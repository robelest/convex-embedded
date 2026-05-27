/**
 * Runtime binding for embedded tables.
 *
 * Sets hooks on table handles for component-dependent behavior (resolve
 * diffing, delta recording, runtime detection). These hooks are called
 * by the builders created in `schema.ts`.
 *
 * @internal
 */

import type { DefaultFunctionArgs, RegisteredQuery } from "convex/server";

import { runAfterMutation } from "@/server/hooks/afterMutation";
import { createRuntimeDetector } from "@/server/hooks/detect";
import { runPull, type PullSpec } from "@/server/hooks/pull";
import type {
  ComponentBinding,
  EmbeddedTableRuntimeHandle,
  RuntimeHooks,
} from "@/server/schema";
import { createLogger } from "@/shared/logger";
import { REMOTE_META } from "@/shared/symbols";
import type { RemoteMeta } from "@/shared/symbols";

const log = createLogger("server-runtime");

interface RuntimeHandleInternals {
  _hooks: RuntimeHooks;
  _declaredIndexes?: Map<string, readonly string[]>;
}

export function bindTableRuntime(
  handle: EmbeddedTableRuntimeHandle,
  component?: ComponentBinding,
): void {
  const tableDef = handle as EmbeddedTableRuntimeHandle &
    RuntimeHandleInternals;
  const hooks: RuntimeHooks = tableDef._hooks;
  const tableName = handle.table;
  const schemaDef = handle.schema;

  if (!component) {
    log.debug(`bindTableRuntime("${tableName}") — no component, local-only`);
    return;
  }

  const declaredIndexes: Map<string, readonly string[]> =
    tableDef._declaredIndexes ?? new Map();

  const spec: PullSpec = {
    tableName,
    schemaDef,
    component,
    declaredIndexes,
  };

  const detector = createRuntimeDetector(tableName, component);

  hooks.detectRuntime = (ctx) => detector.detectRuntime(ctx);

  hooks.afterMutation = (ctx, def, args, result) =>
    runAfterMutation(
      ctx,
      detector,
      tableName,
      schemaDef,
      component,
      def,
      args,
      result,
    );

  hooks.pullHandler = async (ctx, args) => {
    const isRemote = await detector.detectRuntime(ctx);
    if (!isRemote) {
      return {
        mode: "full" as const,
        collectionSeq: -1,
        documents: args.documents.map((doc) => ({
          docId: doc.docId,
          seq: doc.lastSeq,
        })),
      };
    }
    return runPull(ctx, spec, args);
  };

  log.debug(`bindTableRuntime("${tableName}") — version=${schemaDef.version}`);
}

/**
 * Bind runtime behavior to an embedded table's resolve query.
 *
 * This helper installs component-aware runtime hooks and tags the generated
 * resolve query with remote metadata so discovery can find it later.
 *
 * @param table - Embedded table runtime handle to bind.
 * @param component - Optional component binding that enables remote diffing.
 * @returns The table's generated resolve query tagged with remote metadata.
 */
export function bindTable(
  table: EmbeddedTableRuntimeHandle,
  component?: ComponentBinding,
): RegisteredQuery<"public", DefaultFunctionArgs, unknown> {
  bindTableRuntime(table, component);
  const planQuery = (
    table as EmbeddedTableRuntimeHandle & {
      _resolveRaw: RegisteredQuery<"public", DefaultFunctionArgs, unknown>;
    }
  )._resolveRaw;
  Object.defineProperty(planQuery, REMOTE_META, {
    value: {
      __brand: "convex-embedded:remoteMeta" as const,
      table: table.table,
      schema: table.schema,
      resolveExport: "bind",
    } satisfies RemoteMeta,
    enumerable: false,
    configurable: false,
  });
  return planQuery;
}
