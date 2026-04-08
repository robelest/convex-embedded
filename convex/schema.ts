import { embeddedTable, schema } from "@robelest/convex-embedded/server/schema";
import { defineSchema } from "convex/server";
import { v } from "convex/values";

export const projectStatus = v.union(
  v.literal("active"),
  v.literal("archived"),
);

export const issueStatus = v.union(
  v.literal("backlog"),
  v.literal("todo"),
  v.literal("in_progress"),
  v.literal("done"),
  v.literal("cancelled"),
);

export const issuePriority = v.union(
  v.literal("urgent"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
  v.literal("none"),
);

export const projects = embeddedTable("projects", {
  groupId: v.string(),
  teamGroupId: v.optional(v.string()),
  name: v.string(),
  identifier: v.string(),
  slug: v.string(),
  description: schema.prose(),
  status: schema.register(projectStatus),
  createdByUserId: v.string(),
  issueCounter: schema.counter(),
  openIssueCount: schema.counter(),
});

projects.index("by_groupId", ["groupId"]);
projects.index("by_teamGroupId", ["teamGroupId"]);
projects.index("by_groupId_and_slug", ["groupId", "slug"]);
projects.index("by_groupId_and_identifier", ["groupId", "identifier"]);

export const issues = embeddedTable("issues", {
  projectId: v.id("projects"),
  groupId: v.string(),
  scopeGroupId: v.string(),
  number: v.number(),
  title: schema.register(v.string()),
  description: schema.prose(),
  status: schema.register(issueStatus),
  priority: schema.register(issuePriority),
  assigneeUserId: schema.register(v.union(v.string(), v.null())),
  createdByUserId: v.string(),
  labels: schema.set(v.string()),
  position: v.number(),
});

issues.index("by_projectId", ["projectId"]);
issues.index("by_projectId_and_status", ["projectId", "status"]);
issues.index("by_groupId", ["groupId"]);
issues.index("by_assigneeUserId", ["assigneeUserId"]);

export const comments = embeddedTable("comments", {
  issueId: v.id("issues"),
  groupId: v.string(),
  authorUserId: v.string(),
  body: schema.prose(),
});

comments.index("by_issueId", ["issueId"]);

export default defineSchema({
  projects,
  issues,
  comments,
});
