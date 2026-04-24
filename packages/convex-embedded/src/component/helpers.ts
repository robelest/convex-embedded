/**
 * Shared constants, validators, and helper routines for the public component
 * API defined in `public.ts`.
 *
 * @internal
 */

import type { MutationCtx, QueryCtx } from "./_generated/server.js";

export const DEFAULT_KEEP_TAIL_COUNT = 64;
export const DEFAULT_TAIL_BYTE_LIMIT = 256 * 1024;
export const DEFAULT_KEEP_COLLECTION_TAIL_COUNT = 256;
const EMPTY_YJS_V2_UPDATE = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

export function isEmptyUpdate(update: Uint8Array): boolean {
  return (
    update.byteLength === 0 ||
    (update.byteLength === EMPTY_YJS_V2_UPDATE.length &&
      update.every((value, index) => EMPTY_YJS_V2_UPDATE[index] === value))
  );
}

type ReaderCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

async function iterateOrderedQuery<T>(query: {
  [Symbol.asyncIterator]?: () => AsyncIterator<T>;
  collect?: () => Promise<T[]>;
}): Promise<T[]> {
  if (typeof query[Symbol.asyncIterator] === "function") {
    const results: T[] = [];
    for await (const entry of query as AsyncIterable<T>) {
      results.push(entry);
    }
    return results;
  }
  if (typeof query.collect === "function") {
    return query.collect();
  }
  throw new Error(
    "[convex-embedded] expected query to support iteration or collect().",
  );
}

export async function getLatestLiveState(
  ctx: ReaderCtx,
  collection: string,
  docId: string,
) {
  return await ctx.db
    .query("liveStates")
    .withIndex("by_collection_doc", (q) =>
      q.eq("collection", collection).eq("docId", docId),
    )
    .unique();
}

export async function getCollectionHead(ctx: ReaderCtx, collection: string) {
  return await ctx.db
    .query("collectionHeads")
    .withIndex("by_collection", (q) => q.eq("collection", collection))
    .unique();
}

export async function bumpCollectionSeq(
  ctx: Pick<MutationCtx, "db">,
  collection: string,
  input: { docId: string; kind: "upsert" | "delete"; now: number },
) {
  const current = await getCollectionHead(ctx, collection);
  const seq = current ? Number(current.seq) + 1 : 0;

  if (current) {
    await ctx.db.patch(current._id, {
      seq,
      updatedAt: input.now,
    });
  } else {
    await ctx.db.insert("collectionHeads", {
      collection,
      seq,
      updatedAt: input.now,
    });
  }

  await ctx.db.insert("collectionTail", {
    collection,
    seq,
    docId: input.docId,
    kind: input.kind,
    createdAt: input.now,
  });

  return seq;
}

export async function listCollectionTail(
  ctx: ReaderCtx,
  collection: string,
  sinceSeq: number,
) {
  return await ctx.db
    .query("collectionTail")
    .withIndex("by_collection_seq", (q) =>
      q.eq("collection", collection).gt("seq", sinceSeq),
    )
    .collect();
}

export async function trimCollectionTail(
  ctx: Pick<MutationCtx, "db">,
  collection: string,
  keepCollectionTailCount: number,
) {
  const entries = await iterateOrderedQuery(
    ctx.db
      .query("collectionTail")
      .withIndex("by_collection_seq", (q) => q.eq("collection", collection))
      .order("desc"),
  );
  let kept = 0;
  let deleted = 0;
  for (const [index, entry] of entries.entries()) {
    if (index < Math.max(keepCollectionTailCount, 0)) {
      kept += 1;
      continue;
    }
    await ctx.db.delete(entry._id);
    deleted += 1;
  }
  return {
    kept,
    deleted,
  };
}

export async function trimDeltaTail(
  ctx: Pick<MutationCtx, "db">,
  collection: string,
  docId: string,
  keepTailCount: number,
  tailByteLimit: number,
) {
  const entries = await iterateOrderedQuery(
    ctx.db
      .query("deltaTail")
      .withIndex("by_collection_doc_seq", (q) =>
        q.eq("collection", collection).eq("docId", docId),
      )
      .order("desc"),
  );
  let retainedBytes = 0;
  let kept = 0;
  let deleted = 0;
  for (const [index, entry] of entries.entries()) {
    const nextBytes = retainedBytes + Number(entry.byteLength ?? 0);
    const withinCount = index < keepTailCount;
    const withinBytes = nextBytes <= tailByteLimit;

    if (withinCount && withinBytes) {
      retainedBytes = nextBytes;
      kept += 1;
      continue;
    }
    await ctx.db.delete(entry._id);
    deleted += 1;
  }

  return {
    kept,
    deleted,
    retainedBytes,
  };
}
