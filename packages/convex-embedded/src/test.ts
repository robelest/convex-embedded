/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";

import schema from "@/component/schema";
const modules = import.meta.glob("./component/**/*.ts");

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
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "embedded",
) {
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
