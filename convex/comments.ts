import { bindTable, typedTable } from "@robelest/convex-embedded/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { USER_ID, mapUser, requireGroup, requirePermission } from "./access";
import { prose } from "./prose";
import { comments } from "./schema";

export const bind = bindTable(comments, components.embedded);
const t = typedTable<DataModel>(comments);

export const forIssue = t.query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      throw new ConvexError("Issue not found");
    }
    requireGroup(issue.groupId);
    await requirePermission(ctx, "canReadProjects");
    const issueComments = await ctx.db
      .query("comments")
      .withIndex("by_issueId", (q) => q.eq("issueId", args.issueId))
      .take(100);

    return issueComments.map((comment) => ({
      _id: comment._id,
      authorName: mapUser(comment.authorUserId).name,
      authorUserId: comment.authorUserId,
      body: prose.text(comment.body),
      createdAt: comment._creationTime,
    }));
  },
});

export const create = t.mutation({
  args: {
    issueId: v.id("issues"),
    body: v.string(),
  },
  returns: v.id("comments"),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "canCreateComments");
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      throw new ConvexError("Issue not found");
    }
    requireGroup(issue.groupId);
    const body = args.body.trim();
    if (!body) {
      throw new ConvexError("Comment body is required.");
    }

    return await ctx.db.insert("comments", {
      issueId: issue._id,
      groupId: issue.groupId,
      authorUserId: USER_ID,
      body: prose.normalize(body),
    });
  },
});

export const remove = t.mutation({
  args: { commentId: v.id("comments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, "canDeleteComments");
    const comment = await ctx.db.get(args.commentId);
    if (!comment) {
      return null;
    }
    requireGroup(comment.groupId);
    await ctx.db.delete(args.commentId);
    return null;
  },
});
