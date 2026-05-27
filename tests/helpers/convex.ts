import schema from "@convex/schema";
import type { ConvexModuleRegistry } from "@embedded/kernel/modules";
import { register as registerResolveComponent } from "@robelest/convex-embedded/test";
import type { TestConvex } from "convex-test";
import { convexTest } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import * as Y from "yjs";

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

function emptyStateVector(): ArrayBuffer {
  const doc = new Y.Doc();
  return toArrayBuffer(Y.encodeStateVector(doc));
}

interface RegisterEntry {
  value: unknown;
  timestamp?: number;
}

function readRegister(fields: Y.Map<unknown>, key: string): unknown {
  const registerMap = fields.get(key);
  if (!(registerMap instanceof Y.Map)) {
    return undefined;
  }

  return Array.from(registerMap.values() as Iterable<RegisterEntry>).reduce<
    RegisterEntry | undefined
  >(
    (winner, entry) =>
      !winner ||
      (entry.timestamp !== undefined &&
        entry.timestamp > (winner.timestamp ?? -Infinity))
        ? entry
        : winner,
    undefined,
  )?.value;
}
