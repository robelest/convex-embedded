import type { ConvexModuleRegistry } from "@robelest/convex-embedded/expo";

export const modules = {
  dashboard: () => import("$convex/dashboard"),
  projects: () => import("$convex/projects"),
  issues: () => import("$convex/issues"),
  comments: () => import("$convex/comments"),
} satisfies ConvexModuleRegistry;
