import { patchRoutedConvexClient } from "@resolve/client/adapter";
import type { EmbeddedRuntime } from "@resolve/index";
import { describe, expect, it, vi } from "@tests/testkit";
import type { ConvexClient } from "convex/browser";

interface RoutedQueryClient {
  query(refName: string, args: Record<string, unknown>): Promise<unknown>;
}

interface IssueRow {
  _id: string;
  identifier: string;
  title: string;
  status: string;
  priority: string;
}

interface IssuesResult {
  issues: IssueRow[];
}

function translateLocalIssueIds<T>(value: T): T {
  const translate = (current: unknown): unknown => {
    if (Array.isArray(current)) {
      return current.map(translate);
    }

    if (current === null || typeof current !== "object") {
      return current;
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== null && prototype !== Object.prototype) {
      return current;
    }

    return Object.fromEntries(
      Object.entries(current).map(([key, entryValue]) => [
        key,
        key === "_id" && entryValue === "local-issue-1"
          ? "remote-issue-1"
          : translate(entryValue),
      ]),
    );
  };

  return translate(value) as T;
}

function createPatchedClient(result: IssuesResult) {
  const watch = {
    onUpdate: vi.fn((callback: () => void) => {
      callback();
      return () => {};
    }),
    localQueryResult: vi.fn(() => result),
    localQueryLogs: vi.fn(() => []),
  };

  const runtime = {
    executeLocal: vi.fn(async () => result),
    watchLocalQuery: vi.fn(() => watch),
    watchLocalPaginatedQuery: vi.fn(() => watch),
  } as unknown as EmbeddedRuntime;

  const client = {
    query: vi.fn(),
    mutation: vi.fn(),
    action: vi.fn(),
    onUpdate: vi.fn(),
    onPaginatedUpdate_experimental: vi.fn(),
    client: {
      localQueryResult: vi.fn(),
      localQueryLogs: vi.fn(() => []),
    },
  } as unknown as ConvexClient;

  patchRoutedConvexClient({
    client,
    runtime,
    getRefName: (ref) => String(ref),
    asError: (error) =>
      error instanceof Error ? error : new Error(String(error)),
    resolveMutationPlan: () => ({ kind: "local", enqueueForReplay: false }),
    resolveReadPlan: () => ({ kind: "local" }),
    resolveReadPlanByName: () => ({ kind: "local" }),
    executeLocalMutation: vi.fn(async () => null),
    translateLocalResultToClient: translateLocalIssueIds,
  });

  return {
    client: client as unknown as RoutedQueryClient,
    runtime,
    watch,
  };
}

function createExistingDuplicateIssuesResult(): IssuesResult {
  return {
    issues: [
      {
        _id: "remote-issue-1",
        identifier: "PROJ-1",
        title: "First remote issue row",
        status: "todo",
        priority: "medium",
      },
      {
        _id: "remote-issue-1",
        identifier: "PROJ-1",
        title: "Second remote issue row",
        status: "todo",
        priority: "medium",
      },
    ],
  };
}

describe("patchRoutedConvexClient", () => {
  it("preserves duplicates that already existed before translation", async () => {
    const { client } = createPatchedClient(
      createExistingDuplicateIssuesResult(),
    );

    const result = await client.query("issues:forProject", {
      projectId: "project-1",
    });

    expect(result).toEqual({
      issues: [
        expect.objectContaining({ title: "First remote issue row" }),
        expect.objectContaining({ title: "Second remote issue row" }),
      ],
    });
  });
});
