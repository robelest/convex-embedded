import type {
  DefaultFunctionArgs,
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import type { GenericId } from "convex/values";

import type { ComponentBinding, EmbeddedMutationDef } from "@/server/schema";
import { createLogger } from "@/shared/logger";
import { type Definition, getCrdtType } from "@/shared/schema";
import { encodeDocumentState } from "@/shared/yjs";

import type { RuntimeDetector } from "./detect";

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
  const fields: Record<string, unknown> = {};
  for (const [name, fieldDef] of Object.entries(schemaDef.getShape())) {
    if (getCrdtType(fieldDef) !== null && name in doc) {
      fields[name] = doc[name];
    }
  }
  return fields;
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

async function recordRemoteChange(
  ctx: GenericMutationCtx<GenericDataModel>,
  tableName: string,
  schemaDef: Definition,
  component: ComponentBinding,
  docId: string,
): Promise<void> {
  try {
    if (!hasCrdtFields(schemaDef)) {
      const doc = await ctx.db.get(docId as GenericId<string>);
      if (!doc) {
        await ctx.runMutation(component.public.recordDelete, {
          collection: tableName,
          docId,
        });
      }
      return;
    }
    const [doc, current] = await Promise.all([
      ctx.db.get(docId as GenericId<string>),
      ctx.runQuery(component.public.getLiveState, {
        collection: tableName,
        docId,
      }) as Promise<{ seq: number } | null>,
    ]);
    if (!doc) {
      await ctx.runMutation(component.public.recordDelete, {
        collection: tableName,
        docId,
      });
      return;
    }
    const nextSeq = (current?.seq ?? -1) + 1;
    const crdtFields = pickCrdtFields(schemaDef, doc);
    const update = encodeDocumentState(schemaDef, crdtFields, nextSeq);
    await ctx.runMutation(component.public.recordUpdate, {
      collection: tableName,
      docId,
      update: toArrayBuffer(update),
      docCreationTime: Number(doc._creationTime),
    });
  } catch (error) {
    log.error(`recordRemoteChange: failed for ${tableName}/${docId}`, error);
  }
}

export async function runAfterMutation(
  ctx: GenericMutationCtx<GenericDataModel>,
  detector: RuntimeDetector,
  tableName: string,
  schemaDef: Definition,
  component: ComponentBinding,
  def: EmbeddedMutationDef,
  args: DefaultFunctionArgs,
  result: unknown,
): Promise<void> {
  const isRemote = await detector.detectRuntime(ctx);
  if (!isRemote) return;
  await (def.remote ? def.remote(ctx, args, result) : Promise.resolve());
  const docId = extractDocId(result, args, tableName);
  if (docId) {
    await recordRemoteChange(ctx, tableName, schemaDef, component, docId);
  }
}
