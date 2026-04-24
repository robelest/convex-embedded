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

import type { UserIdentity } from "./auth";
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

/**
 * Create a stable test identity for embedded auth scenarios.
 *
 * @param attrs - Partial identity overrides.
 * @returns A complete embedded user identity suitable for tests.
 *
 * @example
 * ```ts
 * const identity = createTestIdentity({ subject: "user-42" });
 * await t.setIdentity(identity);
 * ```
 */
export function createTestIdentity(
  attrs: Record<string, any> = {},
): UserIdentity {
  const subject = (attrs.subject as string) ?? "test-user-1";
  const issuer = (attrs.issuer as string) ?? "https://embedded.local";
  const tokenIdentifier =
    (attrs.tokenIdentifier as string) ?? `${issuer}|${subject}`;

  return {
    subject,
    issuer,
    tokenIdentifier,
    name: "Test User",
    email: "test@embedded.local",
    ...attrs,
  };
}

/**
 * Default test helpers bundle for integration setups.
 */
export default { register, schema, modules, createTestIdentity };
