import { bindTable } from "@robelest/convex-embedded/server";
import type { PaginationOptions } from "convex/server";
import { ConvexError, v } from "convex/values";

import {
  GROUP_ID,
  USER_ID,
  mapUser,
  requireGroup,
  requirePermission,
} from "./access";
import { components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { prose } from "./prose";
import { issuePriority, issueStatus, issues } from "./schema";

export const bind = bindTable(issues, components.embedded);

const ISSUES_PER_PROJECT_LIMIT = 2_000;

function isOpen(status: string) {
  return status !== "done" && status !== "cancelled";
}

function mapRow(issue: Doc<"issues">, project: Doc<"projects">) {
  return {
    _id: issue._id,
    _creationTime: issue._creationTime,
    identifier: `${project.identifier}-${issue.number}`,
    number: issue.number,
    title: issue.title,
    description: prose.normalize(issue.description),
    status: issue.status,
    priority: issue.priority,
    labels: issue.labels ?? [],
    position: issue.position,
    assigneeUserId: issue.assigneeUserId ?? null,
    assigneeName: issue.assigneeUserId
      ? mapUser(issue.assigneeUserId).name
      : null,
    createdByName: mapUser(issue.createdByUserId).name,
    createdByUserId: issue.createdByUserId,
    projectId: issue.projectId,
    groupId: issue.groupId,
  };
}

const STATUS_ORDINAL: Record<string, number> = {
  in_progress: 0,
  todo: 1,
  backlog: 2,
  done: 3,
  cancelled: 4,
};

const paginationOptsValidator = v.object({
  numItems: v.number(),
  cursor: v.union(v.string(), v.null()),
  id: v.optional(v.number()),
  endCursor: v.optional(v.union(v.string(), v.null())),
  maximumRowsRead: v.optional(v.number()),
  maximumBytesRead: v.optional(v.number()),
});

export const forProject = issues.query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator as any,
  },
  handler: async (
    ctx,
    args: { projectId: Id<"projects">; paginationOpts: PaginationOptions },
  ) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }
    requireGroup(project.groupId);
    await requirePermission(ctx, "canReadProjects");

    const page = await ctx.db
      .query("issues")
      .withIndex("by_projectId_and_position", (q) =>
        q.eq("projectId", args.projectId),
      )
      .order("asc")
      .paginate(args.paginationOpts as PaginationOptions);

    return { ...page, page: page.page.map((issue) => mapRow(issue, project)) };
  },
});

export const allForProject = issues.query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }
    requireGroup(project.groupId);
    await requirePermission(ctx, "canReadProjects");

    const all = await ctx.db
      .query("issues")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .take(ISSUES_PER_PROJECT_LIMIT);

    return all
      .map((issue) => mapRow(issue, project))
      .sort((a, b) => {
        const ord =
          (STATUS_ORDINAL[a.status] ?? 99) - (STATUS_ORDINAL[b.status] ?? 99);
        if (ord !== 0) return ord;
        return a.position - b.position;
      });
  },
});

export const detail = issues.query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      throw new ConvexError("Issue not found");
    }

    const project = await ctx.db.get(issue.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }
    requireGroup(project.groupId);
    await requirePermission(ctx, "canReadProjects");

    return {
      _id: issue._id,
      identifier: `${project.identifier}-${issue.number}`,
      number: issue.number,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      labels: issue.labels ?? [],
      assigneeName: issue.assigneeUserId
        ? mapUser(issue.assigneeUserId).name
        : null,
      assigneeUserId: issue.assigneeUserId ?? null,
      createdByName: mapUser(issue.createdByUserId).name,
      createdByUserId: issue.createdByUserId,
      projectId: issue.projectId,
      groupId: issue.groupId,
    };
  },
});

export const create = issues.mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
  },
  returns: v.id("issues"),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "canCreateIssues");
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }
    requireGroup(project.groupId);
    const title = args.title.trim();
    if (!title) {
      throw new ConvexError("Issue title is required.");
    }

    const number = project.issueCounter + 1;
    const issueId = await ctx.db.insert("issues", {
      projectId: project._id,
      groupId: project.groupId,
      scopeGroupId: project.teamGroupId ?? project.groupId,
      number,
      title,
      description: prose.empty(),
      status: "todo",
      priority: "medium",
      assigneeUserId: null,
      createdByUserId: USER_ID,
      labels: [],
      position: Date.now(),
    });

    await ctx.db.patch(project._id, {
      issueCounter: number,
      openIssueCount: project.openIssueCount + 1,
    });

    return issueId;
  },
});

export const update = issues.mutation({
  args: {
    issueId: v.id("issues"),
    title: v.optional(v.string()),
    description: v.optional(v.any()),
    status: v.optional(issueStatus),
    priority: v.optional(issuePriority),
    assigneeUserId: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "canEditIssues");
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      throw new ConvexError("Issue not found");
    }

    const project = await ctx.db.get(issue.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }
    requireGroup(project.groupId);

    const updates: Record<string, unknown> = {};
    if (args.title !== undefined) {
      const next = args.title.trim();
      if (!next) {
        throw new ConvexError("Issue title is required.");
      }
      if (next !== issue.title) updates.title = next;
    }
    if (args.description !== undefined) {
      updates.description = prose.normalize(args.description);
    }
    if (args.status !== undefined && args.status !== issue.status) {
      updates.status = args.status;
    }
    if (args.priority !== undefined && args.priority !== issue.priority) {
      updates.priority = args.priority;
    }
    if (
      args.assigneeUserId !== undefined &&
      args.assigneeUserId !== issue.assigneeUserId
    ) {
      updates.assigneeUserId = args.assigneeUserId;
    }

    if (Object.keys(updates).length === 0) {
      return null;
    }

    await ctx.db.patch(issue._id, updates);

    if (args.status !== undefined && args.status !== issue.status) {
      const wasOpen = isOpen(issue.status);
      const isNowOpen = isOpen(args.status);
      if (wasOpen !== isNowOpen) {
        await ctx.db.patch(project._id, {
          openIssueCount: Math.max(
            0,
            project.openIssueCount + (isNowOpen ? 1 : -1),
          ),
        });
      }
    }

    return null;
  },
});

export const remove = issues.mutation({
  args: { issueId: v.id("issues") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "canDeleteIssues");
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      return null;
    }

    const project = await ctx.db.get(issue.projectId);
    if (project) {
      requireGroup(project.groupId);
    }
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_issueId", (q) => q.eq("issueId", issue._id))
      .take(100);
    if (comments.length === 100) {
      throw new ConvexError(
        "Issue has too many comments to delete in one request.",
      );
    }

    await Promise.all(comments.map((comment) => ctx.db.delete(comment._id)));
    await ctx.db.delete(issue._id);

    if (project) {
      await ctx.db.patch(project._id, {
        openIssueCount: Math.max(
          0,
          project.openIssueCount - (isOpen(issue.status) ? 1 : 0),
        ),
      });
    }

    return null;
  },
});
