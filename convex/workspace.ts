import { query } from "./_generated/server";

export const DEMO_WORKSPACE_ID = "workspace_demo";
export const DEFAULT_USER_ID = "user_alice";

export const demoMembers = [
  {
    memberId: "member_alice",
    userId: "user_alice",
    name: "Alice Chen",
    email: "alice@acme.dev",
    roleIds: ["orgAdmin"],
    status: "active",
  },
  {
    memberId: "member_marcus",
    userId: "user_marcus",
    name: "Marcus Hale",
    email: "marcus@acme.dev",
    roleIds: ["member"],
    status: "active",
  },
  {
    memberId: "member_priya",
    userId: "user_priya",
    name: "Priya Shah",
    email: "priya@acme.dev",
    roleIds: ["member"],
    status: "active",
  },
] as const;

export const demoTeams = [
  {
    groupId: "team_product",
    name: "Product",
    type: "team",
    children: [{ groupId: "team_mobile", name: "Mobile", type: "team" }],
  },
  {
    groupId: "team_design",
    name: "Design",
    type: "team",
    children: [],
  },
] as const;

export const permissions = {
  canReadProjects: true,
  canCreateProjects: true,
  canManageProjects: true,
  canCreateIssues: true,
  canEditIssues: true,
  canMoveIssues: true,
  canAssignIssues: true,
  canDeleteIssues: true,
  canCreateComments: true,
  canDeleteComments: true,
  canManageTeams: false,
  canManageMembers: false,
  canManageSso: false,
  canManageScim: false,
} as const;

export function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function isOpenIssue(status: string) {
  return status !== "done" && status !== "cancelled";
}

export function userSummary(userId: string) {
  const match = demoMembers.find((member) => member.userId === userId);
  if (match) {
    return {
      userId: match.userId,
      name: match.name,
      email: match.email,
    };
  }

  return {
    userId,
    name: userId,
    email: null,
  };
}

export const get = query({
  args: {},
  handler: async () => {
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
