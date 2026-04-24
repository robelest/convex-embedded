"use node";

import { createOpenAI } from "@ai-sdk/openai";
import { Agent, createThread } from "@convex-dev/agent";
import { remoteOnly } from "@robelest/convex-embedded/server";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { action } from "./_generated/server";

// ---------------------------------------------------------------------------
// Agent setup
// ---------------------------------------------------------------------------

function createIssueAgent() {
  const globalWithProcess = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  const apiKey =
    typeof globalThis === "object"
      ? globalWithProcess.process?.env?.OPENROUTER_API_KEY
      : undefined;

  if (!apiKey) {
    throw new Error(
      "Missing OPENROUTER_API_KEY. Set it in your Convex environment before using the issue assistant.",
    );
  }

  const openrouter = createOpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });

  return new Agent(components.agent, {
    name: "Issue Assistant",
    languageModel: openrouter.chat("minimax/minimax-m2.7"),
    instructions:
      "You help triage software issues. Be concise, concrete, and product-minded. Summaries should capture the problem, recommended next step, and any obvious delivery risk.",
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const summarizeIssueAction = action({
  args: { issueId: v.id("issues") },
  returns: v.object({ summary: v.string() }),
  handler: async (ctx, args): Promise<{ summary: string }> => {
    const issue = await ctx.runQuery(internal.assistant.issueForAssistant, {
      issueId: args.issueId,
    });

    const threadId = await createThread(ctx, components.agent, {
      title: `Issue ${issue.identifier} summary`,
    });
    const issueAgent = createIssueAgent();

    const prompt: string = [
      "Summarize this engineering issue for a product and engineering audience.",
      "Use exactly three headings: Problem, Recommendation, Risk.",
      "Keep the result under 140 words.",
      `Identifier: ${issue.identifier}`,
      `Title: ${issue.title}`,
      `Status: ${issue.status}`,
      `Priority: ${issue.priority}`,
      `Assignee: ${issue.assigneeName ?? "Unassigned"}`,
      `Labels: ${issue.labels.length > 0 ? issue.labels.join(", ") : "None"}`,
      `Description: ${issue.description || "No description provided."}`,
      issue.comments.length > 0
        ? `Comments:\n${issue.comments
            .map(
              (comment: { authorName: string; body: string }) =>
                `- ${comment.authorName}: ${comment.body}`,
            )
            .join("\n")}`
        : "Comments: None",
    ].join("\n\n");

    const result: { text: string } = await issueAgent.generateText(
      ctx,
      { threadId },
      { prompt, maxOutputTokens: 220 },
    );
    return { summary: result.text.trim() };
  },
});

export const summarizeIssue = remoteOnly(summarizeIssueAction);

const summarizeProjectAction = action({
  args: { projectId: v.id("projects") },
  returns: v.object({ summary: v.string() }),
  handler: async (ctx, args): Promise<{ summary: string }> => {
    const project = await ctx.runQuery(internal.assistant.projectForAssistant, {
      projectId: args.projectId,
    });

    const threadId = await createThread(ctx, components.agent, {
      title: `Project ${project.identifier} summary`,
    });
    const issueAgent = createIssueAgent();

    const prompt = [
      "Summarize this software project for an engineering lead.",
      "Use exactly three headings: Status, Priorities, Risk.",
      "Keep the result under 180 words.",
      `Project: ${project.identifier} ${project.name}`,
      `Status: ${project.status}`,
      `Description: ${project.description || "No description provided."}`,
      `Open issues: ${project.openIssueCount}`,
      `Total issues: ${project.issueCount}`,
      project.issues.length > 0
        ? `Visible issues:\n${project.issues
            .map(
              (issue: {
                identifier: string;
                title: string;
                status: string;
                priority: string;
                assigneeName?: string | null;
                labels: string[];
              }) =>
                `- ${issue.identifier}: ${issue.title} [${issue.status}, ${issue.priority}] assignee=${issue.assigneeName ?? "unassigned"} labels=${issue.labels.join(", ") || "none"}`,
            )
            .join("\n")}`
        : "Visible issues: None",
    ].join("\n\n");

    const result: { text: string } = await issueAgent.generateText(
      ctx,
      { threadId },
      { prompt, maxOutputTokens: 260 },
    );
    return { summary: result.text.trim() };
  },
});

export const summarizeProject = remoteOnly(summarizeProjectAction);

const chatProjectAction = action({
  args: {
    projectId: v.id("projects"),
    history: v.array(
      v.object({
        role: v.union(v.literal("user"), v.literal("assistant")),
        content: v.string(),
      }),
    ),
    message: v.string(),
  },
  returns: v.object({ reply: v.string() }),
  handler: async (ctx, args): Promise<{ reply: string }> => {
    const project = await ctx.runQuery(internal.assistant.projectForAssistant, {
      projectId: args.projectId,
    });

    const threadId = await createThread(ctx, components.agent, {
      title: `Project ${project.identifier} chat`,
    });
    const issueAgent = createIssueAgent();

    const context = [
      `Project: ${project.identifier} ${project.name}`,
      `Status: ${project.status}`,
      `Description: ${project.description || "No description provided."}`,
      `Open issues: ${project.openIssueCount}`,
      `Total issues: ${project.issueCount}`,
      project.issues.length > 0
        ? `Visible issues:\n${project.issues
            .map(
              (issue: {
                identifier: string;
                title: string;
                status: string;
                priority: string;
                assigneeName?: string | null;
                labels: string[];
              }) =>
                `- ${issue.identifier}: ${issue.title} [${issue.status}, ${issue.priority}] assignee=${issue.assigneeName ?? "unassigned"} labels=${issue.labels.join(", ") || "none"}`,
            )
            .join("\n")}`
        : "Visible issues: None",
    ].join("\n\n");

    const messages = [
      {
        role: "user" as const,
        content: `Project context for the conversation. Use this as the source of truth.\n\n${context}`,
      },
      ...args.history,
      { role: "user" as const, content: args.message },
    ];

    const result: { text: string } = await issueAgent.generateText(
      ctx,
      { threadId },
      { messages, maxOutputTokens: 260 },
    );
    return { reply: result.text.trim() };
  },
});

export const chatProject = remoteOnly(chatProjectAction);
