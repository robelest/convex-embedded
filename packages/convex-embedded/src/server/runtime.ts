/**
 * Runtime binding for embedded tables.
 *
 * Sets hooks on table handles for component-dependent behavior (resolve
 * diffing, delta recording, runtime detection). These hooks are called
 * by the builders created in `schema.ts`.
 *
 * @internal
 */

import type {
  DefaultFunctionArgs,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredQuery,
} from "convex/server";
import type { GenericId } from "convex/values";

import { runPull, type PullSpec } from "@/server/hooks/pull";
import type {
  ComponentBinding,
  EmbeddedTableRuntimeHandle,
  RuntimeHooks,
} from "@/server/schema";
import { parseErrorMetadata } from "@/shared/errors";
import { createLogger } from "@/shared/logger";
import type { Definition } from "@/shared/schema";
import { getCrdtType } from "@/shared/schema";
import { REMOTE_META } from "@/shared/symbols";
import type { RemoteMeta } from "@/shared/symbols";
import { encodeDocumentState } from "@/shared/yjs";

const log = createLogger("server-runtime");

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength,
  ) as ArrayBuffer;
}

function pickCrdtFields(
  schemaDef: Definition,
  doc: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, fieldDef] of Object.entries(schemaDef.getShape())) {
    if (getCrdtType(fieldDef) === null) continue;
    if (key in doc) {
      result[key] = doc[key];
    }
  }
  return result;
}

function hasCrdtFields(schemaDef: Definition): boolean {
  for (const fieldDef of Object.values(schemaDef.getShape())) {
    if (getCrdtType(fieldDef) !== null) return true;
  }
  return false;
}

function extractDocId(
  result: unknown,
  args: Record<string, unknown> | null | undefined,
  tableName?: string,
): string | null {
  if (typeof result === "string") return result;
  if (args?.id && typeof args.id === "string") return args.id;
  if (args?._id && typeof args._id === "string") return args._id;
  if (args?.docId && typeof args.docId === "string") return args.docId;
  if (tableName && args && typeof args === "object") {
    const singular = tableName.replace(/s$/, "");
    const tableIdKey = `${singular}Id`;
    if (typeof args[tableIdKey] === "string") return args[tableIdKey];
  }
  return null;
}

function isComponentUnavailableError(error: unknown): boolean {
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

  async function detectRuntime(
    ctx: GenericQueryCtx<GenericDataModel>,
  ): Promise<boolean> {
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
      await ctx.runQuery(component!.public.getLiveStates, {
        collection: tableName,
        docIds: [],
      });
      log.debug(`detectRuntime(${tableName}): component resolved -> remote`);
      return cacheRuntimeValue(ctx, true);
    } catch (error) {
      if (!isComponentUnavailableError(error)) {
        throw error;
      }
      log.debug(`detectRuntime(${tableName}): component unavailable -> local`);
      return cacheRuntimeValue(ctx, false);
    }
  }

  async function recordRemoteChange(
    ctx: GenericMutationCtx<GenericDataModel>,
    docId: string,
  ): Promise<void> {
    try {
      if (!hasCrdtFields(schemaDef)) {
        const doc = await ctx.db.get(docId as GenericId<string>);
        if (!doc) {
          await ctx.runMutation(component!.public.recordDelete, {
            collection: tableName,
            docId,
          });
        }
        return;
      }
      const [doc, current] = await Promise.all([
        ctx.db.get(docId as GenericId<string>),
        ctx.runQuery(component!.public.getLiveState, {
          collection: tableName,
          docId,
        }) as Promise<{ seq: number } | null>,
      ]);
      if (!doc) {
        await ctx.runMutation(component!.public.recordDelete, {
          collection: tableName,
          docId,
        });
        return;
      }
      const nextSeq = (current?.seq ?? -1) + 1;
      const crdtFields = pickCrdtFields(schemaDef, doc);
      const update = encodeDocumentState(schemaDef, crdtFields, nextSeq);
      await ctx.runMutation(component!.public.recordUpdate, {
        collection: tableName,
        docId,
        update: toArrayBuffer(update),
        docCreationTime: Number(doc._creationTime),
      });
    } catch (error) {
      log.error(`recordRemoteChange: failed for ${tableName}/${docId}`, error);
    }
  }

  hooks.detectRuntime = detectRuntime;

  hooks.afterMutation = async (ctx, def, args, result) => {
    const isRemote = await detectRuntime(ctx);
    if (!isRemote) {
      return;
    }
    await (def.remote ? def.remote(ctx, args, result) : Promise.resolve());
    const docId = extractDocId(result, args, tableName);
    if (docId) {
      await recordRemoteChange(ctx, docId);
    }
  };

  hooks.pullHandler = async (ctx, args) => {
    const isRemote = await detectRuntime(ctx);
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
