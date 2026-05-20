import { api } from "$convex/_generated/api";
import type { Id } from "$convex/_generated/dataModel";
import { useQuery } from "convex/react";

export interface Project {
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

const EMPTY: Project[] = [];

export function useProjects() {
  const projects = useQuery(api.projects.list, {});
  return (projects ?? EMPTY) as Project[];
}
