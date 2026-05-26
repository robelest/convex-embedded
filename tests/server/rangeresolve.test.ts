import { bindTableRuntime } from "@resolve/server/runtime";
import {
  embeddedTable,
  type ComponentBinding,
  type RuntimeHooks,
} from "@resolve/server/schema";
import type { QueryPageRange } from "@resolve/shared/types";
import { describe, expect, it } from "@tests/testkit";
import type { GenericDataModel, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";

type Doc = Record<string, unknown> & { _id: string; position: number };

const PROJECT = "project-1";

function makeDocs(): Doc[] {
  const docs: Doc[] = [];
  for (let position = 0; position < 8; position += 1) {
    docs.push({
      _id: `${PROJECT}-doc-${position}`,
      _creationTime: position + 1,
      projectId: PROJECT,
      position,
      title: `title-${position}`,
    });
  }
  // A second project to verify the equality prefix scopes the range.
  docs.push({
    _id: "project-2-doc-0",
    _creationTime: 99,
    projectId: "project-2",
    position: 0,
    title: "other",
  });
  return docs;
}

interface EqChain {
  eq(field: string, value: unknown): EqChain;
}

function createTable() {
  const table = embeddedTable("issues", {
    projectId: v.id("projects"),
    position: v.number(),
    title: v.string(),
  });
  table.index("by_projectId_and_position", ["projectId", "position"]);
  return table;
}

function createComponent() {
  const tag = (name: string) => ({ __mock: name }) as unknown;
  return {
    public: {
      recordDelete: tag("recordDelete"),
      recordUpdate: tag("recordUpdate"),
      getCollectionChanges: tag("getCollectionChanges"),
      getLiveState: tag("getLiveState"),
      getLiveStates: tag("getLiveStates"),
      getLiveStatesPage: tag("getLiveStatesPage"),
    },
  } as unknown as ComponentBinding;
}

function createCtx(
  docs: Doc[],
  component: ComponentBinding,
): GenericQueryCtx<GenericDataModel> {
  const publicApi = (
    component as unknown as { public: Record<string, unknown> }
  ).public;
  const byId = new Map(docs.map((doc) => [doc._id, doc]));

  const buildChain = (rows: Doc[]) => {
    const eqs: Array<{ field: string; value: unknown }> = [];
    let direction: "asc" | "desc" = "asc";
    const chain = {
      withIndex(_name: string, builder: (q: EqChain) => EqChain) {
        const recorder: EqChain = {
          eq(field, value) {
            eqs.push({ field, value });
            return recorder;
          },
        };
        builder(recorder);
        return chain;
      },
      order(dir: "asc" | "desc") {
        direction = dir;
        return chain;
      },
      paginate(opts: { cursor: string | null; numItems: number }) {
        const filtered = rows.filter((row) =>
          eqs.every((e) => row[e.field] === e.value),
        );
        filtered.sort((a, b) =>
          direction === "asc"
            ? a.position - b.position
            : b.position - a.position,
        );
        const start =
          typeof opts.cursor === "string" && opts.cursor.length > 0
            ? Number(opts.cursor)
            : 0;
        const slice = filtered.slice(start, start + opts.numItems);
        const nextStart = start + slice.length;
        const isDone = nextStart >= filtered.length;
        return Promise.resolve({
          page: slice,
          isDone,
          continueCursor: isDone ? "" : String(nextStart),
        });
      },
    };
    return chain;
  };

  const ctx = {
    db: {
      query: (_table: string) => buildChain(docs),
      get: (id: string) => Promise.resolve(byId.get(id) ?? null),
    },
    runQuery: (fn: unknown, args: Record<string, unknown>) => {
      if (fn === publicApi.getLiveStates) {
        const ids = (args.docIds as string[] | undefined) ?? [];
        // Return live states in REVERSED order to prove the handler re-orders
        // hydrated docs to match the index-range order.
        const states = ids
          .filter((id) => byId.has(id))
          .map((id) => ({
            docId: id,
            update: new ArrayBuffer(0),
            seq: 1,
            docCreationTime: byId.get(id)?._creationTime as number,
          }))
          .reverse();
        return Promise.resolve(states);
      }
      if (fn === publicApi.getCollectionChanges) {
        return Promise.resolve({
          mode: "full" as const,
          collectionSeq: 7,
          changes: [],
        });
      }
      return Promise.resolve(null);
    },
  };
  return ctx as unknown as GenericQueryCtx<GenericDataModel>;
}

function resolveHandlerOf(
  table: ReturnType<typeof createTable>,
): NonNullable<RuntimeHooks["pullHandler"]> {
  const hooks = (table as unknown as { _hooks: RuntimeHooks })._hooks;
  const handler = hooks.pullHandler;
  if (!handler) {
    throw new Error("pullHandler not bound");
  }
  return handler;
}

function rangeArgs(
  range: QueryPageRange,
): Parameters<NonNullable<RuntimeHooks["pullHandler"]>>[1] {
  return {
    collectionSeq: null,
    documents: [],
    scopeArgs: { projectId: PROJECT },
    queryPageRange: range,
  };
}

describe("server range-bounded resolve", () => {
  it("returns the first ascending page in index order with a continue cursor", async () => {
    const table = createTable();
    const component = createComponent();
    bindTableRuntime(table, component);
    const handler = resolveHandlerOf(table);
    const ctx = createCtx(makeDocs(), component);

    const result = await handler(
      ctx,
      rangeArgs({
        indexName: "by_projectId_and_position",
        order: "asc",
        numItems: 3,
        eq: [{ field: "projectId", value: PROJECT }],
      }),
    );

    expect(result.mode).toBe("full");
    expect(result.isDone).toBe(false);
    expect(result.documents.map((d) => d.docId)).toEqual([
      `${PROJECT}-doc-0`,
      `${PROJECT}-doc-1`,
      `${PROJECT}-doc-2`,
    ]);
    expect(result.continueCursor).toBe("3");
  });

  it("returns the first descending page from the high end", async () => {
    const table = createTable();
    const component = createComponent();
    bindTableRuntime(table, component);
    const handler = resolveHandlerOf(table);
    const ctx = createCtx(makeDocs(), component);

    const result = await handler(
      ctx,
      rangeArgs({
        indexName: "by_projectId_and_position",
        order: "desc",
        numItems: 3,
        eq: [{ field: "projectId", value: PROJECT }],
      }),
    );

    expect(result.documents.map((d) => d.docId)).toEqual([
      `${PROJECT}-doc-7`,
      `${PROJECT}-doc-6`,
      `${PROJECT}-doc-5`,
    ]);
    expect(result.isDone).toBe(false);
  });

  it("resumes from the cursor and reports isDone on the last page", async () => {
    const table = createTable();
    const component = createComponent();
    bindTableRuntime(table, component);
    const handler = resolveHandlerOf(table);
    const ctx = createCtx(makeDocs(), component);

    const result = await handler(
      ctx,
      rangeArgs({
        indexName: "by_projectId_and_position",
        order: "asc",
        numItems: 5,
        eq: [{ field: "projectId", value: PROJECT }],
        cursor: "5",
      }),
    );

    expect(result.documents.map((d) => d.docId)).toEqual([
      `${PROJECT}-doc-5`,
      `${PROJECT}-doc-6`,
      `${PROJECT}-doc-7`,
    ]);
    expect(result.isDone).toBe(true);
    expect(result.continueCursor).toBeNull();
  });

  it("falls back to whole-scope resolve when the index is unknown", async () => {
    const table = createTable();
    const component = createComponent();
    bindTableRuntime(table, component);
    const handler = resolveHandlerOf(table);
    const ctx = createCtx(makeDocs(), component);

    const result = await handler(
      ctx,
      rangeArgs({
        indexName: "by_nonexistent",
        order: "asc",
        numItems: 3,
        eq: [{ field: "projectId", value: PROJECT }],
      }),
    );

    // Unknown index → range path returns null → whole-scope path runs and
    // returns every in-scope doc (8) rather than a 3-doc window.
    expect(result.documents.length).toBe(8);
  });
});
