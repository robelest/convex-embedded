import type { ConvexInput } from "@robelest/convex-embedded";

export const convex: ConvexInput = {
  modules: {
    access: () => import("../../../../convex/access"),
    assistant: () => import("../../../../convex/assistant"),
    comments: () => import("../../../../convex/comments"),
    convex_config: () => import("../../../../convex/convex.config"),
    issues: () => import("../../../../convex/issues"),
    projects: () => import("../../../../convex/projects"),
    prose: () => import("../../../../convex/prose"),
    schema: () => import("../../../../convex/schema"),
    validators: () => import("../../../../convex/validators"),
  },
  manifest: {
    remote: {
      routeModes: {
        "agent:summarizeIssue": "remote",
        "agent:summarizeProject": "remote",
        "agent:chatProject": "remote",
      },
      tables: {
        comments: {
          resolve: "comments:bind",
          schemaModule: "schema",
          schemaExport: "comments",
        },
        issues: {
          resolve: "issues:bind",
          schemaModule: "schema",
          schemaExport: "issues",
        },
        projects: {
          resolve: "projects:bind",
          schemaModule: "schema",
          schemaExport: "projects",
        },
      },
    },
  },
};
