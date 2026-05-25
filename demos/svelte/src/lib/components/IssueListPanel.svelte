<script lang="ts">
	import type { ConvexClient } from "convex/browser";
	import { api } from "$convex/_generated/api.js";
	import type { ProseContent } from "@robelest/convex-embedded/crdt";
	import { usePaginatedQuery } from "$lib/usePaginatedQuery.svelte";
	import IssueDetailPanel from "./IssueDetailPanel.svelte";
	import ProjectWorkbenchPanel from "./ProjectWorkbenchPanel.svelte";

  let { project, permissions, members, currentUserId, groupId, client } = $props<{
		project: {
			_id: string;
			name: string;
			identifier: string;
			slug: string;
			teamGroupId: string | null;
			teamName: string;
			description: ProseContent | string;
		};
    permissions: {
      canCreateIssues: boolean;
      canManageProjects: boolean;
      canMoveIssues: boolean;
      canEditIssues: boolean;
      canAssignIssues: boolean;
      canDeleteIssues: boolean;
      canCreateComments: boolean;
      canDeleteComments: boolean;
    };
    members: Array<{ userId: string; name: string }>;
    currentUserId: string;
    groupId: string;
    client: ConvexClient;
  }>();

  type IssueRow = {
    _id: string;
    identifier: string;
    number: number;
    title: string;
    description: ProseContent;
    status: string;
    priority: string;
    labels: string[];
    assigneeName: string | null;
    assigneeUserId: string | null;
    createdByName: string;
    createdByUserId: string;
  };

  const PAGE_SIZE = 50;

  const paged = usePaginatedQuery<IssueRow>(
    () => client,
    api.issues.forProject,
    () => ({ projectId: project._id }),
    { initialNumItems: PAGE_SIZE },
  );

  const issues = $derived(paged.results);
  const status = $derived(paged.status);

  const statusColors: Record<string, string> = {
    backlog: "text-gray-400",
    todo: "text-gray-600",
    in_progress: "text-accent-500",
    done: "text-green-600",
    cancelled: "text-gray-300",
  };

  const priorityLabels: Record<string, string> = {
    urgent: "Urgent",
    high: "High",
    medium: "Med",
    low: "Low",
    none: "",
  };

  function issueLabels(issue: IssueRow): string[] {
    return Array.isArray(issue.labels) ? issue.labels : [];
  }

  function statusDotFill(value: string): string {
    if (value === "done") return "bg-green-600";
    if (value === "in_progress") return "bg-accent-500/50";
    if (value === "cancelled") return "bg-gray-300";
    return "bg-current";
  }

  let expandedIssueId = $state<string | null>(null);
  let createRequests = $state(0);
  let newTitle = $state("");
  let errorMessage = $state<string | null>(null);
  let sentinel = $state<HTMLDivElement | null>(null);

  $effect(() => {
    const node = sentinel;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && paged.status === "CanLoadMore") {
            paged.loadMore(PAGE_SIZE);
          }
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  });

  function toggleIssue(issueId: string) {
    expandedIssueId = expandedIssueId === issueId ? null : issueId;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      expandedIssueId = null;
    }
  }

  async function handleCreateIssue() {
    const title = newTitle.trim();
    if (title.length === 0) return;
    createRequests += 1;
    errorMessage = null;
    newTitle = "";
    try {
		await client.mutation(api.issues.create, {
        projectId: project._id,
        title,
      });
    } catch (e: unknown) {
      errorMessage = e instanceof Error ? e.message : "Failed to create issue";
      if (newTitle.trim().length === 0) {
        newTitle = title;
      }
    } finally {
      createRequests -= 1;
    }
  }

</script>

<svelte:window onkeydown={handleKeydown} />

<div class="flex flex-col gap-3">
  <!-- Header -->
  <div class="flex items-center justify-between gap-4 max-md:flex-col max-md:items-stretch flex-wrap">
    <div class="flex flex-col">
      <h2 class="section-header" style="border:0;margin:0;padding:0">
        <span class="text-gray-400">{project.identifier}</span>
        <span class="ml-1">{project.name}</span>
      </h2>
    </div>
    {#if permissions.canCreateIssues}
      <form class="flex gap-1.5 items-center" onsubmit={(e) => { e.preventDefault(); handleCreateIssue(); }}>
        <input
          bind:value={newTitle}
          class="input input--compact flex-1"
          maxlength="120"
          placeholder="New issue title"
          type="text"
        />
        <button
          class="button button--accent button--compact"
          disabled={newTitle.trim().length === 0}
          type="submit"
        >
          {createRequests > 0 ? "Adding..." : "Add"}
        </button>
      </form>
    {/if}
  </div>

	{#if errorMessage}
		<p class="error-banner">{errorMessage}</p>
	{/if}

	<ProjectWorkbenchPanel {project} {client} canEditProject={permissions.canManageProjects} />

	<!-- Issue list (paginated, infinite scroll) -->
  {#if status === "LoadingFirstPage"}
    <p class="muted">Loading issues...</p>
  {:else if issues.length === 0}
    <p class="muted">No issues yet.</p>
  {:else}
    <div class="flex flex-col border border-gray-300 bg-white">
      {#each issues as issue (issue._id)}
        <!-- Issue row -->
        <div
		class="flex items-center gap-3 px-3 py-2 border-b border-gray-200 bg-transparent cursor-pointer hover:bg-gray-50 text-left w-full transition-colors duration-75 {expandedIssueId === issue._id ? 'bg-gray-100' : ''}"
		onclick={() => toggleIssue(issue._id)}
		onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleIssue(issue._id); } }}
          role="button"
          tabindex="0"
        >
          <!-- Status dot -->
          <span class="inline-block w-2 h-2 rounded-full shrink-0 {statusColors[issue.status]} {statusDotFill(issue.status)}" title={issue.status}></span>

          <!-- Identifier -->
          <span class="font-label text-[0.6875rem] font-semibold text-gray-400 shrink-0 w-16">{issue.identifier}</span>

          <!-- Title -->
          <span class="font-sans text-[0.8125rem] font-medium text-gray-900 flex-1 truncate">{issue.title}</span>

          <!-- Priority -->
          {#if issue.priority !== "none"}
            <span class={`chip chip--${issue.priority === "urgent" ? "high" : issue.priority} shrink-0`}>{priorityLabels[issue.priority]}</span>
          {/if}

          <!-- Labels -->
		{#each issueLabels(issue).slice(0, 2) as label (label)}
            <span class="chip chip--grant shrink-0">{label}</span>
          {/each}

          <!-- Assignee -->
          <span class="font-label text-[0.6875rem] text-gray-500 shrink-0 w-20 text-right truncate">
            {issue.assigneeName ?? "—"}
          </span>
        </div>

        <!-- Inline expand -->
		{#if expandedIssueId === issue._id}
          <div class="border-b border-gray-300 bg-gray-50">
            <IssueDetailPanel
              {issue}
              {permissions}
              {members}
              {currentUserId}
              {groupId}
              {client}
              onclose={() => { expandedIssueId = null; }}
            />
          </div>
        {/if}
      {/each}

      <div bind:this={sentinel} class="h-px w-full"></div>

      {#if status === "LoadingMore"}
        <p class="muted px-3 py-2 text-center">Loading more...</p>
      {/if}
    </div>
  {/if}
</div>
