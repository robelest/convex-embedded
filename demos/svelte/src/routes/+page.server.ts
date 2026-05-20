import { prose } from "$convex/prose";

import type { PageServerLoad } from "./$types";

const teams = [
  {
    groupId: "team_product",
    name: "Product",
    children: [{ groupId: "team_mobile", name: "Mobile" }],
  },
  {
    groupId: "team_design",
    name: "Design",
    children: [],
  },
];

export const load: PageServerLoad = async ({ parent }) => {
  const { prefetch } = await parent();

  const allTeams = teams.flatMap((team) => [
    { groupId: team.groupId, name: team.name },
    ...team.children,
  ]);

  const projects = prefetch.projects.map((project: any) => ({
    _id: project._id,
    groupId: project.groupId,
    name: project.name,
    identifier: project.identifier,
    slug: project.slug,
    description: prose.text(project.description),
    status: project.status,
    teamGroupId: project.teamGroupId ?? null,
    teamName:
      allTeams.find((team) => team.groupId === project.teamGroupId)?.name ??
      null,
    issueCount: project.issueCounter,
    openIssueCount: project.openIssueCount,
  }));

  return { projects };
};
