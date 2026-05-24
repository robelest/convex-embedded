import { ConvexError } from "convex/values";
import { v } from "convex/values";

import { internalQuery } from "./_generated/server";
import { mapUser, requireGroup } from "./access";
import { prose } from "./prose";

export const issueForAssistant = internalQuery({
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

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_issueId", (q) => q.eq("issueId", issue._id))
      .take(20);

    return {
      identifier: `${project.identifier}-${issue.number}`,
      title: issue.title,
      description: prose.text(issue.description),
      status: issue.status,
      priority: issue.priority,
      labels: issue.labels,
      assigneeName: issue.assigneeUserId
        ? mapUser(issue.assigneeUserId).name
        : null,
      comments: comments.map((comment) => ({
        authorName: mapUser(comment.authorUserId).name,
        body: prose.text(comment.body),
      })),
    };
  },
});

export const projectForAssistant = internalQuery({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    const project = await ctx.db.get(args.projectId);
    if (!project) {
      throw new ConvexError("Project not found");
    }
    requireGroup(project.groupId);

    const users = Object.fromEntries([
      ["user_alice", "Alice Chen"],
      ["user_marcus", "Marcus Hale"],
      ["user_priya", "Priya Shah"],
    ]);

    const issues = (
      await ctx.db
        .query("issues")
        .withIndex("by_projectId", (q) => q.eq("projectId", args.projectId))
        .take(20)
    ).sort((a, b) => a.position - b.position);

    return {
      identifier: project.identifier,
      name: project.name,
      description: prose.text(project.description),
      status: project.status,
      openIssueCount: project.openIssueCount,
      issueCount: project.issueCounter,
      issues: issues.map((issue) => ({
        identifier: `${project.identifier}-${issue.number}`,
        title: issue.title,
        status: issue.status,
        priority: issue.priority,
        assigneeName: issue.assigneeUserId
          ? (users[issue.assigneeUserId] ?? issue.assigneeUserId)
          : null,
        labels: issue.labels,
      })),
    };
  },
});
