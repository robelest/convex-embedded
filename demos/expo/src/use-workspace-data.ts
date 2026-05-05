import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import { useQuery } from "convex/react";

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

const WORKSPACE_GET_ARGS = {} as const;
const EMPTY_PROJECTS: WorkspaceProject[] = [];

export function useWorkspaceData() {
  const workspace = useQuery(api.workspace.get, WORKSPACE_GET_ARGS);
  const workspaceId = workspace?.selectedWorkspace?.groupId;
  const projects = useQuery(
    api.projects.list,
    workspaceId ? { workspaceId } : "skip",
  );

  return {
    workspace,
    workspaceId,
    projects: (projects ?? EMPTY_PROJECTS) as WorkspaceProject[],
  };
}
