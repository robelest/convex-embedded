import { bindTable } from "@robelest/convex-embedded/server";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { prose } from "./prose";
import { issues } from "./schema";
import { issuePriority, issueStatus } from "./validators";
import { DEFAULT_USER_ID, isOpenIssue, userSummary } from "./workspace";

export const bind = bindTable(issues, components.embedded);

export const list = issues.query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("issues").collect();
  },
});

const STATUS_ORDINAL: Record<string, number> = {
  in_progress: 0,
  todo: 1,
  backlog: 2,
  done: 3,
  cancelled: 4,
};

export const forProject = issues.query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }

    const page = await ctx.db
      .query("issues")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .order("asc")
      .paginate(args.paginationOpts);

    const rows = page.page
      .map((issue) => ({
        _id: issue._id,
        identifier: `${project.identifier}-${issue.number}`,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        position: issue.position,
        assigneeName: issue.assigneeUserId
          ? userSummary(issue.assigneeUserId).name
          : null,
      }))
      .sort((a, b) => {
        const ord = (STATUS_ORDINAL[a.status] ?? 99) - (STATUS_ORDINAL[b.status] ?? 99);
        if (ord !== 0) return ord;
        return a.position - b.position;
      });

    return { ...page, page: rows };
  },
});

export const forProjectAll = issues.query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }

    const all = await ctx.db
      .query("issues")
      .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
      .collect();

    return all
      .map((issue) => ({
        _id: issue._id,
        _creationTime: issue._creationTime,
        projectId: issue.projectId,
        number: issue.number,
        identifier: `${project.identifier}-${issue.number}`,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        position: issue.position,
        assigneeUserId: issue.assigneeUserId ?? null,
        assigneeName: issue.assigneeUserId
          ? userSummary(issue.assigneeUserId).name
          : null,
      }))
      .sort((a, b) => {
        const ord =
          (STATUS_ORDINAL[a.status] ?? 99) -
          (STATUS_ORDINAL[b.status] ?? 99);
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

    return {
      _id: issue._id,
      identifier: `${project.identifier}-${issue.number}`,
      number: issue.number,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      labels: issue.labels,
      assigneeName: issue.assigneeUserId
        ? userSummary(issue.assigneeUserId).name
        : null,
      assigneeUserId: issue.assigneeUserId ?? null,
      createdByName: userSummary(issue.createdByUserId).name,
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
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }

    const number = project.issueCounter + 1;
    const issueId = await ctx.db.insert("issues", {
      projectId: project._id,
      groupId: project.groupId,
      scopeGroupId: project.teamGroupId ?? project.groupId,
      number,
      title: args.title.trim(),
      description: prose.empty(),
      status: "todo",
      priority: "medium",
      assigneeUserId: null,
      createdByUserId: DEFAULT_USER_ID,
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
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      throw new ConvexError("Issue not found");
    }

    const project = await ctx.db.get(issue.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }

    const updates: Record<string, unknown> = {};
    if (args.title !== undefined) {
      const next = args.title.trim();
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
      const wasOpen = isOpenIssue(issue.status);
      const isNowOpen = isOpenIssue(args.status);
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
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      return null;
    }

    const project = await ctx.db.get(issue.projectId);
    const comments = await ctx.db
      .query("comments")
      .withIndex("by_issueId", (q) => q.eq("issueId", issue._id))
      .collect();

    await Promise.all(comments.map((comment) => ctx.db.delete(comment._id)));
    await ctx.db.delete(issue._id);

    if (project) {
      await ctx.db.patch(project._id, {
        openIssueCount: Math.max(
          0,
          project.openIssueCount - (isOpenIssue(issue.status) ? 1 : 0),
        ),
      });
    }

    return null;
  },
});
