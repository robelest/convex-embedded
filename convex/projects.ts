import { bindTable, typedTable } from "@robelest/convex-embedded/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { GROUP_ID, USER_ID, requireGroup, requirePermission } from "./access";
import { prose } from "./prose";
import { projects } from "./schema";

export const bind = bindTable(projects, components.embedded);
const t = typedTable<DataModel>(projects);

const PROJECT_LIST_LIMIT = 1_000;

function toSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export const list = t.query({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, "canReadProjects");
    return await ctx.db
      .query("projects")
      .withIndex("by_groupId", (q) => q.eq("groupId", GROUP_ID))
      .take(PROJECT_LIST_LIMIT);
  },
});

export const create = t.mutation({
  args: {
    name: v.string(),
    identifier: v.string(),
    description: v.string(),
    teamGroupId: v.optional(v.string()),
  },
  returns: v.id("projects"),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "canCreateProjects");

    const slug = toSlug(args.name);
    if (!slug) {
      throw new ConvexError("Project name is required.");
    }

    const identifier = args.identifier.trim().toUpperCase();
    if (!identifier) {
      throw new ConvexError("Project identifier is required.");
    }

    const existingSlug = await ctx.db
      .query("projects")
      .withIndex("by_groupId_and_slug", (q) =>
        q.eq("groupId", GROUP_ID).eq("slug", slug),
      )
      .unique();
    if (existingSlug) {
      throw new ConvexError("A project with that name already exists.");
    }
    const existingIdentifier = await ctx.db
      .query("projects")
      .withIndex("by_groupId_and_identifier", (q) =>
        q.eq("groupId", GROUP_ID).eq("identifier", identifier),
      )
      .unique();
    if (existingIdentifier) {
      throw new ConvexError("That project identifier is already in use.");
    }

    return await ctx.db.insert("projects", {
      groupId: GROUP_ID,
      teamGroupId: args.teamGroupId,
      name: args.name.trim(),
      identifier,
      slug,
      description: prose.normalize(args.description),
      status: "active",
      createdByUserId: USER_ID,
      issueCounter: 0,
      openIssueCount: 0,
    });
  },
});

export const update = t.mutation({
  args: {
    projectId: v.id("projects"),
    description: v.optional(v.any()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "canManageProjects");
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }
    requireGroup(project.groupId);

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

export const detail = t.query({
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
