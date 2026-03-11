/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as sync from "../sync.js";
import type * as tasks from "../tasks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  sync: typeof sync;
  tasks: typeof tasks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  resolve: {
    public: {
      cleanup: FunctionReference<
        "mutation",
        "internal",
        { collection: string; docId: string; keepLatest?: number },
        { deleted: number; kept: number }
      >;
      getLatestDelta: FunctionReference<
        "query",
        "internal",
        { collection: string; docId: string },
        { seq: number; update: ArrayBuffer } | null
      >;
      getLatestDeltas: FunctionReference<
        "query",
        "internal",
        { collection: string; docIds: Array<string> },
        Array<{ docId: string; seq: number; update: ArrayBuffer } | null>
      >;
      insertDelta: FunctionReference<
        "mutation",
        "internal",
        { collection: string; docId: string; update: ArrayBuffer },
        null
      >;
    };
  };
};
