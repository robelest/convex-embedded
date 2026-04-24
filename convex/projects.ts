import { bindTable } from "@robelest/convex-embedded/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { prose } from "./prose";
import { projects } from "./schema";
import { DEFAULT_USER_ID, DEMO_WORKSPACE_ID, toSlug } from "./workspace";

export const bind = bindTable(projects, components.embedded);

export const list = projects.query({
  args: { workspaceId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_groupId", (q) => q.eq("groupId", args.workspaceId))
      .collect();
  },
});

export const create = projects.mutation({
  args: {
    workspaceId: v.string(),
    teamGroupId: v.optional(v.string()),
    name: v.string(),
    identifier: v.string(),
    description: v.string(),
  },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    if (args.workspaceId !== DEMO_WORKSPACE_ID) {
      throw new ConvexError("Unknown workspace");
    }

    const slug = toSlug(args.name);
    if (!slug) {
      throw new ConvexError("Project name is required.");
    }

    const identifier = args.identifier.trim().toUpperCase();
    if (!identifier) {
      throw new ConvexError("Project identifier is required.");
    }

    const existingInGroup = await ctx.db
      .query("projects")
      .withIndex("by_groupId", (q) => q.eq("groupId", DEMO_WORKSPACE_ID))
      .collect();
    if (existingInGroup.some((project) => project.slug === slug)) {
      throw new ConvexError("A project with that name already exists.");
    }
    if (existingInGroup.some((project) => project.identifier === identifier)) {
      throw new ConvexError("That project identifier is already in use.");
    }

    return await ctx.db.insert("projects", {
      groupId: DEMO_WORKSPACE_ID,
      teamGroupId: args.teamGroupId,
      name: args.name.trim(),
      identifier,
      slug,
      description: prose.normalize(args.description),
      status: "active",
      createdByUserId: DEFAULT_USER_ID,
      issueCounter: 0,
      openIssueCount: 0,
    });
  },
});

export const update = projects.mutation({
  args: {
    projectId: v.id("projects"),
    description: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }

    const updates: Record<string, unknown> = {};
    if (args.description !== undefined) {
      updates.description = prose.normalize(args.description);
    }

    if (Object.keys(updates).length > 0) {
      await ctx.db.patch(project._id, updates);
    }

    return null;
  },
});

export const detail = projects.query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }

    return {
      _id: project._id,
      identifier: project.identifier,
      name: project.name,
      description: prose.normalize(project.description),
      status: project.status,
      openIssueCount: project.openIssueCount,
      issueCount: project.issueCounter,
    };
  },
});
