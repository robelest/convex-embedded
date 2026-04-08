<script lang="ts">
	import { browser } from "$app/environment";
	import { useQuery, useConvexClient } from "convex-svelte";
	import { api } from "$convex/_generated/api.js";
	import AppSidebar from "$lib/components/AppSidebar.svelte";
	import IssueListPanel from "$lib/components/IssueListPanel.svelte";
	import SettingsPanel from "$lib/components/SettingsPanel.svelte";
	import { onMount } from "svelte";

	type DashboardData = {
		user: { userId: string; name: string; email: string } | null;
		workspaces: Array<Record<string, any>>;
		selectedWorkspace: Record<string, any> | null;
	} | null;

	let { data }: { data: { dashboard: DashboardData } } = $props();

	const client = browser ? useConvexClient() : null;
	const dashboard = browser ? useQuery(api.dashboard.get, () => ({})) : null;

	let hydrated = $state(false);

	onMount(() => {
		hydrated = true;
	});


	let activeTab = $state<"issues" | "settings">("issues");
	let selectedProjectSlug = $state<string | null>(null);

	const dashboardData = $derived(
		browser ? dashboard?.data ?? data.dashboard ?? null : data.dashboard ?? null,
	);
	const dashboardLoading = $derived(
		browser ? Boolean(dashboard?.isLoading && !dashboardData) : dashboardData === null,
	);
	const dashboardLogs = $derived(
		browser
			? ((client as typeof client & { localQueryLogs?: (ref: unknown, args: unknown) => string[] | undefined }).localQueryLogs?.(
					api.dashboard.get,
					{},
				) ?? [])
			: [],
	);
	const dashboardErrorMessage = $derived(
		browser && dashboard?.error instanceof Error
			? dashboard.error.message
			: browser && dashboard?.error
				? String(dashboard.error)
				: null,
	);

	const ws = $derived(dashboardData?.selectedWorkspace ?? null);
	const user = $derived(dashboardData?.user ?? null);

	// Auto-select first project when none selected
	const selectedProject = $derived.by(() => {
		if (!ws) return null;
		if (selectedProjectSlug) {
			return ws.projects.find((p: any) => p.slug === selectedProjectSlug) ?? ws.projects[0] ?? null;
		}
		return ws.projects[0] ?? null;
	});

	// Sync slug state when projects load
	$effect(() => {
		if (selectedProject && !selectedProjectSlug) {
			selectedProjectSlug = selectedProject.slug;
		}
	});
</script>

{#if dashboardLoading || (ws && user && (!hydrated || !client))}
	<main class="p-5 px-6 overflow-y-auto max-md:p-4">
		<p class="muted">Loading...</p>
	</main>
	{:else if ws && user && client}
	<AppSidebar
		workspaces={
			(dashboardData?.workspaces ?? []) as Array<{
				groupId: string;
				name: string;
			}>
		}
		selectedWorkspace={{ groupId: ws.groupId, name: ws.name }}
		projects={ws.projects}
		teams={ws.teams}
		permissions={{
			canManageTeams: ws.permissions.canManageTeams,
			canCreateProjects: ws.permissions.canCreateProjects,
		}}
		bind:activeTab
		bind:selectedProjectSlug
		{client}
		workspaceGroupId={ws.groupId}
	/>
	<main class="p-5 px-6 overflow-y-auto max-md:p-4">
		{#if activeTab === "issues"}
			{#if selectedProject}
			{#key selectedProject._id}
					<IssueListPanel
						project={{
							_id: selectedProject._id,
							name: selectedProject.name,
							identifier: selectedProject.identifier,
							slug: selectedProject.slug,
							teamGroupId: selectedProject.teamGroupId,
							teamName: selectedProject.teamName ?? "",
							description: selectedProject.description,
						}}
						permissions={{
							canCreateIssues: ws.permissions.canCreateIssues,
							canManageProjects: ws.permissions.canManageProjects,
							canMoveIssues: ws.permissions.canMoveIssues,
							canEditIssues: ws.permissions.canEditIssues,
							canAssignIssues: ws.permissions.canAssignIssues,
							canDeleteIssues: ws.permissions.canDeleteIssues,
							canCreateComments: ws.permissions.canCreateComments,
							canDeleteComments: ws.permissions.canDeleteComments,
						}}
						members={ws.members.map((m: any) => ({ userId: m.userId, name: m.name }))}
						currentUserId={user.userId}
						workspaceGroupId={ws.groupId}
						{client}
					/>
				{/key}
			{:else}
				<p class="muted">No projects yet{ws.permissions.canCreateProjects ? " — click + New in the sidebar." : "."}</p>
			{/if}
		{:else}
			<SettingsPanel
				user={{ name: user.name, email: user.email }}
				userRoleLabel={ws.userRoleLabel}
				members={ws.members}
				teams={ws.teams}
				permissions={{
					canManageTeams: ws.permissions.canManageTeams,
					canManageMembers: ws.permissions.canManageMembers,
					canManageSso: ws.permissions.canManageSso,
				}}
			/>
		{/if}
	</main>
{:else}
	<main class="col-span-full p-5 px-6 overflow-y-auto max-md:p-4">
		<p class="muted">Unable to load the embedded demo state.</p>
		{#if dashboardErrorMessage}
			<pre class="mt-3 overflow-x-auto rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700"
			>{dashboardErrorMessage}</pre>
		{/if}
		{#if dashboardLogs.length > 0}
			<pre class="mt-3 overflow-x-auto rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600"
			>{dashboardLogs.join("\n")}</pre>
		{/if}
	</main>
{/if}
