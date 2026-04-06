/**
 * Test helpers for `@robelest/convex-embedded`.
 *
 * This entry point exposes the packaged embedded component schema and module
 * registry so integration tests can register the component with `convex-test`.
 *
 * @packageDocumentation
 */

/// <reference types="vite-plus/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";

import schema from "./component/schema";
import type { ConvexModule, ConvexModuleRegistry } from "./kernel/modules";

type ImportMetaWithGlob = ImportMeta & {
  glob: (pattern: string) => Record<string, () => Promise<ConvexModule>>;
};

const modules: ConvexModuleRegistry = (import.meta as ImportMetaWithGlob).glob(
  "./component/**/*.ts",
) as ConvexModuleRegistry;

/**
 * Register the embedded component with a convex-test instance.
 *
 * Usage in your test file:
 *   import { register } from "@robelest/convex-embedded/test";
 *   const t = convexTest(schema, modules);
 *   register(t);
 *
 * @param t - The test convex instance from convexTest()
 * @param name - Component name as registered in convex.config.ts (default: "embedded")
 * @returns Nothing. The helper mutates the passed test harness in place.
 *
 * @example
 * ```ts
 * import { convexTest } from "convex-test";
 * import { register } from "@robelest/convex-embedded/test";
 *
 * const t = convexTest(appSchema, modules);
 * register(t);
 * ```
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "embedded",
) {
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
