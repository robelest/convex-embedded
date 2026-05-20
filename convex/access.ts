import { ConvexError } from "convex/values";

type AuthContext = {
  auth: {
    getUserIdentity: () => Promise<{
      tokenIdentifier?: string;
      subject?: string;
    } | null>;
  };
};

export const GROUP_ID = "workspace_demo";
export const USER_ID = "user_alice";

export const members = [
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

export function mapUser(userId: string) {
  const match = members.find((m) => m.userId === userId);
  if (match) {
    return { userId: match.userId, name: match.name, email: match.email };
  }
  return { userId, name: userId, email: null };
}

export async function requirePermission(
  ctx: AuthContext,
  permission: keyof typeof permissions,
) {
  const identity = await ctx.auth.getUserIdentity();
  const key = identity?.tokenIdentifier ?? identity?.subject ?? USER_ID;
  if (key !== USER_ID) {
    throw new ConvexError("Not authorized.");
  }
  if (!permissions[permission]) {
    throw new ConvexError("Permission denied.");
  }
  return USER_ID;
}

export function requireGroup(groupId: string) {
  if (groupId !== GROUP_ID) {
    throw new ConvexError("Not authorized for this group.");
  }
}
