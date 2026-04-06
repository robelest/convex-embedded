import type { Id } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { prose } from "./prose";
import {
  DEMO_WORKSPACE_ID,
  demoMembers,
  demoTeams,
  permissions,
  userSummary,
} from "./workspace";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const projects = (await ctx.db.query("projects").collect()).filter(
      (project) => project.groupId === DEMO_WORKSPACE_ID,
    );

    const projectSummaries = projects.map((project) => {
      const team = demoTeams.find(
        (entry) => entry.groupId === project.teamGroupId,
      );
      return {
        projectId: project._id as Id<"projects">,
        name: project.name,
        identifier: project.identifier,
        slug: project.slug,
        description: prose.text(project.description),
        status: project.status,
        teamGroupId: project.teamGroupId ?? null,
        teamName: team?.name ?? null,
        issueCount: project.issueCounter,
        openIssueCount: project.openIssueCount,
      };
    });

    return {
      user: userSummary("user_alice"),
      workspaces: [
        {
          groupId: DEMO_WORKSPACE_ID,
          name: "Acme",
          roleIds: ["orgAdmin"],
          grants: [],
        },
      ],
      selectedWorkspace: {
        groupId: DEMO_WORKSPACE_ID,
        name: "Acme",
        roleIds: ["orgAdmin"],
        grants: [],
        userRoleLabel: "Admin",
        projects: projectSummaries,
        teams: demoTeams.map((team) => ({
          groupId: team.groupId,
          name: team.name,
          type: team.type,
          children: team.children.map((child) => ({
            groupId: child.groupId,
            name: child.name,
            type: child.type,
          })),
        })),
        members: demoMembers.map((member) => ({
          memberId: member.memberId,
          userId: member.userId,
          name: member.name,
          email: member.email,
          roleIds: [...member.roleIds],
          status: member.status,
        })),
        permissions: { ...permissions },
      },
    };
  },
});
