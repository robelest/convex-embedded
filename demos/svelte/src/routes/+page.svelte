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
	type ProjectList = Array<Record<string, any>> | null;

	let { data }: { data: { workspace: DashboardData; projects: ProjectList } } = $props();

	const client = browser ? useConvexClient() : null;
	const workspaceQuery = browser ? useQuery(api.workspace.get, () => ({})) : null;

	let hydrated = $state(false);

	onMount(() => {
		hydrated = true;
	});


	let activeTab = $state<"issues" | "settings">("issues");
	let selectedProjectSlug = $state<string | null>(null);

	const workspaceData = $derived(
		browser ? workspaceQuery?.data ?? data.workspace ?? null : data.workspace ?? null,
	);
	const ws = $derived(workspaceData?.selectedWorkspace ?? null);
	const user = $derived(workspaceData?.user ?? null);
	const projectsQuery = browser
		? useQuery(api.projects.list, () =>
				workspaceData?.selectedWorkspace
					? { workspaceId: workspaceData.selectedWorkspace.groupId }
					: "skip",
			)
		: null;
	const projectsData = $derived(
		(browser ? projectsQuery?.data ?? data.projects ?? [] : data.projects ?? [])
			.filter((project: any) => project.groupId === ws?.groupId)
			.map((project: any) => ({
				_id: project._id,
				name: project.name,
				identifier: project.identifier,
				slug: project.slug,
				description: project.description,
				status: project.status,
				teamGroupId: project.teamGroupId ?? null,
				teamName:
					ws?.teams
						.flatMap((team: any) => [
							{ groupId: team.groupId, name: team.name },
							...team.children,
						])
						.find((team: any) => team.groupId === project.teamGroupId)?.name ?? null,
				issueCount: project.issueCounter,
				openIssueCount: project.openIssueCount,
			})),
	);
	const dashboardLoading = $derived(
		browser
			? Boolean(
					(workspaceQuery?.isLoading && !workspaceData) ||
					(workspaceData?.selectedWorkspace && projectsQuery?.isLoading && !projectsData),
				)
			: workspaceData === null,
	);
	const dashboardLogs = $derived(
		browser
			? (
					((client as typeof client & { localQueryLogs?: (ref: unknown, args: unknown) => string[] | undefined }).localQueryLogs?.(
						api.workspace.get,
						{},
					) ?? [])
				).concat(
					workspaceData?.selectedWorkspace
						? ((client as typeof client & { localQueryLogs?: (ref: unknown, args: unknown) => string[] | undefined }).localQueryLogs?.(
								api.projects.list,
								{},
							) ?? [])
						: [],
				)
			: [],
	);
	const dashboardErrorMessage = $derived(
		browser && workspaceQuery?.error instanceof Error
			? workspaceQuery.error.message
			: browser && workspaceQuery?.error
				? String(workspaceQuery.error)
				: null,
	);

	// Auto-select first project when none selected
	const selectedProject = $derived.by(() => {
		if (!ws) return null;
		if (selectedProjectSlug) {
			return projectsData.find((p: any) => p.slug === selectedProjectSlug) ?? projectsData[0] ?? null;
		}
		return projectsData[0] ?? null;
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
				(workspaceData?.workspaces ?? []) as Array<{
					groupId: string;
					name: string;
				}>
			}
			selectedWorkspace={{ groupId: ws.groupId, name: ws.name }}
			projects={projectsData}
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
