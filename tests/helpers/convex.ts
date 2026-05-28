import schema from "@convex/schema";
import type { ConvexModuleRegistry } from "@embedded/kernel/modules";
import { register as registerResolveComponent } from "@robelest/convex-embedded/test";
import type { TestConvex } from "convex-test";
import { convexTest } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
const appModules = {
  "_generated/api": () => import("../../convex/_generated/api.js"),
  "_generated/server": () => import("../../convex/_generated/server.js"),
  schema: () => import("../../convex/schema"),
  projects: () => import("../../convex/projects"),
  issues: () => import("../../convex/issues"),
  comments: () => import("../../convex/comments"),
} satisfies ConvexModuleRegistry;

export function createAppModules(): ConvexModuleRegistry {
  return appModules;
}

export type AppConvexTest = TestConvex<typeof schema>;

export function createAppConvexTest(): AppConvexTest {
  const t = convexTest(schema, appModules);
  registerResolveComponent(
    t as unknown as TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  );
  return t;
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}
