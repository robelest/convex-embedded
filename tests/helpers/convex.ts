import schema from "@convex/schema";
import type { ConvexModuleRegistry } from "@embedded/kernel/modules";
import { register as registerResolveComponent } from "@robelest/convex-embedded/test";
import { convexTest } from "convex-test";
import * as Y from "yjs";

export const appModules = {
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

export function createAppConvexTest() {
  const t = convexTest(schema, appModules);
  registerResolveComponent(t as any);
  return t;
}

export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return buffer;
}

export function emptyStateVector(): ArrayBuffer {
  const doc = new Y.Doc();
  return toArrayBuffer(Y.encodeStateVector(doc));
}

export function readRegister(fields: Y.Map<unknown>, key: string): unknown {
  const registerMap = fields.get(key) as Y.Map<unknown>;
  if (!(registerMap instanceof Y.Map)) {
    return undefined;
  }

  return Array.from(registerMap.values()).reduce<
    { value: unknown; timestamp: number } | undefined
  >(
    (winner, entry: any) =>
      !winner || (entry.timestamp && entry.timestamp > winner.timestamp)
        ? entry
        : winner,
    undefined,
  )?.value;
}
