/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    public: {
      getCollectionChanges: FunctionReference<
        "query",
        "internal",
        { collection: string; sinceSeq: number | null },
        {
          changes: Array<{ docId: string; kind: "upsert" | "delete" }>;
          collectionSeq: number;
          isGapDetected: boolean;
          mode: "full" | "incremental";
        },
        Name
      >;
      getLiveState: FunctionReference<
        "query",
        "internal",
        { collection: string; docId: string },
        { docCreationTime?: number; seq: number; update: ArrayBuffer } | null,
        Name
      >;
      getLiveStates: FunctionReference<
        "query",
        "internal",
        { collection: string; docIds?: Array<string> },
        Array<{
          docCreationTime?: number;
          docId: string;
          seq: number;
          update: ArrayBuffer;
        } | null>,
        Name
      >;
      getLiveStatesPage: FunctionReference<
        "query",
        "internal",
        { collection: string; cursor?: string | null; limit?: number },
        {
          continueCursor: string | null;
          isDone: boolean;
          page: Array<{
            docCreationTime?: number;
            docId: string;
            seq: number;
            update: ArrayBuffer;
          }>;
        },
        Name
      >;
      live: {
        getCollectionChanges: FunctionReference<
          "query",
          "internal",
          { collection: string; sinceSeq: number | null },
          {
            changes: Array<{ docId: string; kind: "upsert" | "delete" }>;
            collectionSeq: number;
            isGapDetected: boolean;
            mode: "full" | "incremental";
          },
          Name
        >;
        getLiveState: FunctionReference<
          "query",
          "internal",
          { collection: string; docId: string },
          { docCreationTime?: number; seq: number; update: ArrayBuffer } | null,
          Name
        >;
        getLiveStates: FunctionReference<
          "query",
          "internal",
          { collection: string; docIds?: Array<string> },
          Array<{
            docCreationTime?: number;
            docId: string;
            seq: number;
            update: ArrayBuffer;
          } | null>,
          Name
        >;
        getLiveStatesPage: FunctionReference<
          "query",
          "internal",
          { collection: string; cursor?: string | null; limit?: number },
          {
            continueCursor: string | null;
            isDone: boolean;
            page: Array<{
              docCreationTime?: number;
              docId: string;
              seq: number;
              update: ArrayBuffer;
            }>;
          },
          Name
        >;
        recordDelete: FunctionReference<
          "mutation",
          "internal",
          {
            collection: string;
            docId: string;
            keepCollectionTailCount?: number;
          },
          {
            collectionSeq: number;
            collectionTailDeleted: number;
            deletedDeltaCount: number;
            deletedLiveState: boolean;
          },
          Name
        >;
        recordUpdate: FunctionReference<
          "mutation",
          "internal",
          {
            collection: string;
            docCreationTime: number;
            docId: string;
            keepCollectionTailCount?: number;
            keepTailCount?: number;
            tailByteLimit?: number;
            update: ArrayBuffer;
          },
          {
            collectionSeq: number;
            collectionTailDeleted: number;
            seq: number;
            tailDeleted: number;
            tailKept: number;
          },
          Name
        >;
      };
      recordDelete: FunctionReference<
        "mutation",
        "internal",
        { collection: string; docId: string; keepCollectionTailCount?: number },
        {
          collectionSeq: number;
          collectionTailDeleted: number;
          deletedDeltaCount: number;
          deletedLiveState: boolean;
        },
        Name
      >;
      recordUpdate: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          docCreationTime: number;
          docId: string;
          keepCollectionTailCount?: number;
          keepTailCount?: number;
          tailByteLimit?: number;
          update: ArrayBuffer;
        },
        {
          collectionSeq: number;
          collectionTailDeleted: number;
          seq: number;
          tailDeleted: number;
          tailKept: number;
        },
        Name
      >;
    };
  };
