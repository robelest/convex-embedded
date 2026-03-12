/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";

import schema from "@/component/schema";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the convex-resolve component with a convex-test instance.
 *
 * Usage in your test file:
 *   import resolveTest from "convex-resolve/test";
 *   const t = convexTest(schema, modules);
 *   resolveTest.register(t);
 *
 * @param t - The test convex instance from convexTest()
 * @param name - Component name as registered in convex.config.ts (default: "resolve")
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "resolve",
) {
  t.registerComponent(name, schema, modules);
}

export default { register, schema, modules };
