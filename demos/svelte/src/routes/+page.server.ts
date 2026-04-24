import { prose } from "$convex/prose";

import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ parent }) => {
  const { prefetch } = await parent();

  const workspace = prefetch.workspace;
  const allProjects = prefetch.projects;
  if (!workspace) {
    return { workspace: null, projects: null };
  }

  const teams = workspace.selectedWorkspace.teams.flatMap((team: any) => [
    { groupId: team.groupId, name: team.name },
    ...team.children,
  ]);
  const projects = allProjects
    .filter(
      (project: any) => project.groupId === workspace.selectedWorkspace.groupId,
    )
    .map((project: any) => ({
      _id: project._id,
      name: project.name,
      identifier: project.identifier,
      slug: project.slug,
      description: prose.text(project.description),
      status: project.status,
      teamGroupId: project.teamGroupId ?? null,
      teamName:
        teams.find((team: any) => team.groupId === project.teamGroupId)?.name ??
        null,
      issueCount: project.issueCounter,
      openIssueCount: project.openIssueCount,
    }));

  return {
    workspace,
    projects,
  };
};
