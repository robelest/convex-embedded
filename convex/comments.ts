import { bindTable } from "@robelest/convex-embedded/server";
import { ConvexError, v } from "convex/values";

import { components } from "./_generated/api";
import { prose } from "./prose";
import { comments } from "./schema";
import { DEFAULT_USER_ID, userSummary } from "./workspace";

export const bind = bindTable(comments, components.embedded);

export const list = comments.query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("comments").collect();
  },
});

export const forIssue = comments.query({
  args: { issueId: v.id("issues") },
  handler: async (ctx, args) => {
    const issueComments = (await ctx.db.query("comments").collect()).filter(
      (comment) => comment.issueId === args.issueId,
    );

    return issueComments.map((comment) => ({
      _id: comment._id,
      authorName: userSummary(comment.authorUserId).name,
      authorUserId: comment.authorUserId,
      body: prose.text(comment.body),
      createdAt: comment._creationTime,
    }));
  },
});

export const create = comments.mutation({
  args: {
    issueId: v.id("issues"),
    body: v.string(),
  },
  returns: v.id("comments"),
  handler: async (ctx, args) => {
    const issue = await ctx.db.get(args.issueId);
    if (!issue) {
      throw new ConvexError("Issue not found");
    }

    return await ctx.db.insert("comments", {
      issueId: issue._id,
      groupId: issue.groupId,
      authorUserId: DEFAULT_USER_ID,
      body: prose.normalize(args.body.trim()),
    });
  },
});

export const remove = comments.mutation({
  args: { commentId: v.id("comments") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.delete(args.commentId);
    return null;
  },
});
