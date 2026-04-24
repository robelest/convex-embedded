import type { ConvexInput } from "@robelest/convex-embedded";

export const convex: ConvexInput = {
  modules: {
    agent: () => import("./agent"),
    assistant: () => import("./assistant"),
    comments: () => import("./comments"),
    convex_config: () => import("./convex.config"),
    issues: () => import("./issues"),
    projects: () => import("./projects"),
    prose: () => import("./prose"),
    schema: () => import("./schema"),
    validators: () => import("./validators"),
    workspace: () => import("./workspace"),
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
