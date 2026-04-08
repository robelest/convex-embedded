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
      cleanupDoc: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          docId: string;
          keepCheckpointCount?: number;
          keepTailCount?: number;
          tailByteLimit?: number;
        },
        {
          checkpointDeleted: number;
          checkpointKept: number;
          tailDeleted: number;
          tailKept: number;
        },
        Name
      >;
      createCheckpoint: FunctionReference<
        "mutation",
        "internal",
        {
          actorId?: string;
          collection: string;
          docId: string;
          keepCheckpointCount?: number;
          label?: string;
          metadata?: any;
          pinned?: boolean;
          reason?: string;
          source?: string;
        },
        { checkpointId: string | string; seq: number },
        Name
      >;
      getCheckpoint: FunctionReference<
        "query",
        "internal",
        { checkpointId: string | string; collection: string; docId: string },
        {
          actorId?: string;
          byteLength: number;
          checkpointId: string | string;
          createdAt: number;
          label?: string;
          metadata?: any;
          pinned: boolean;
          reason?: string;
          seq: number;
          source?: string;
          update: ArrayBuffer;
        } | null,
        Name
      >;
      getLiveState: FunctionReference<
        "query",
        "internal",
        { collection: string; docId: string },
        { seq: number; update: ArrayBuffer } | null,
        Name
      >;
      getLiveStates: FunctionReference<
        "query",
        "internal",
        { collection: string; docIds: Array<string> },
        Array<{ docId: string; seq: number; update: ArrayBuffer } | null>,
        Name
      >;
      listCheckpoints: FunctionReference<
        "query",
        "internal",
        { collection: string; docId: string },
        Array<{
          actorId?: string;
          byteLength: number;
          checkpointId: string | string;
          createdAt: number;
          label?: string;
          metadata?: any;
          pinned: boolean;
          reason?: string;
          seq: number;
          source?: string;
        }>,
        Name
      >;
      recordUpdate: FunctionReference<
        "mutation",
        "internal",
        {
          collection: string;
          docId: string;
          keepTailCount?: number;
          tailByteLimit?: number;
          update: ArrayBuffer;
        },
        { seq: number; tailDeleted: number; tailKept: number },
        Name
      >;
    };
  };
