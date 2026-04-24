import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import { useQuery } from "convex/react";
import React from "react";

export interface WorkspaceProject {
  _id: Id<"projects">;
  groupId: string;
  teamGroupId: string | null;
  name: string;
  identifier: string;
  slug: string;
  description: unknown;
  status: string;
  openIssueCount: number;
  issueCounter: number;
}

export function useWorkspaceData() {
  const workspace = useQuery(api.workspace.get, {});
  const workspaceId = workspace?.selectedWorkspace?.groupId;
  const projects = useQuery(
    api.projects.list,
    workspaceId ? { workspaceId } : "skip",
  );

  const workspaceProjects = React.useMemo(() => {
    if (!projects) {
      return [] as WorkspaceProject[];
    }
    return projects as WorkspaceProject[];
  }, [projects]);

  return {
    workspace,
    workspaceId,
    projects: workspaceProjects,
  };
}
