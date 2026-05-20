<script lang="ts">
	import { browser } from "$app/environment";
	import { useQuery, useConvexClient } from "convex-svelte";
	import { api } from "$convex/_generated/api.js";
	import { members, permissions, mapUser, GROUP_ID } from "$convex/access";
	import AppSidebar from "$lib/components/AppSidebar.svelte";
	import IssueListPanel from "$lib/components/IssueListPanel.svelte";
	import SettingsPanel from "$lib/components/SettingsPanel.svelte";
	import { onMount } from "svelte";

	const teams = [
		{
			groupId: "team_product",
			name: "Product",
			type: "team" as const,
			children: [{ groupId: "team_mobile", name: "Mobile", type: "team" as const }],
		},
		{
			groupId: "team_design",
			name: "Design",
			type: "team" as const,
			children: [] as Array<{ groupId: string; name: string; type: "team" }>,
		},
	];

	const user = mapUser("user_alice");

	type ProjectList = Array<Record<string, any>> | null;

	let { data }: { data: { projects: ProjectList } } = $props();

	const client = browser ? useConvexClient() : null;

	let hydrated = $state(false);

	onMount(() => {
		hydrated = true;
	});

	let activeTab = $state<"issues" | "settings">("issues");
	let selectedProjectSlug = $state<string | null>(null);

	const projectsQuery = browser
		? useQuery(api.projects.list, () => ({}))
		: null;

	const allTeams = teams.flatMap((team) => [
		{ groupId: team.groupId, name: team.name },
		...team.children,
	]);

	const projectsData = $derived(
		(browser ? projectsQuery?.data ?? data.projects ?? [] : data.projects ?? [])
			.map((project: any) => ({
				_id: project._id,
				name: project.name,
				identifier: project.identifier,
				slug: project.slug,
				description: project.description,
				status: project.status,
				teamGroupId: project.teamGroupId ?? null,
				teamName:
					allTeams.find((t) => t.groupId === project.teamGroupId)?.name ?? null,
				issueCount: project.issueCounter,
				openIssueCount: project.openIssueCount,
			})),
	);

	const dashboardLoading = $derived(
		browser
			? Boolean(projectsQuery?.isLoading && projectsData.length === 0)
			: data.projects === null,
	);

	const dashboardLogs = $derived(
		browser
			? ((client as typeof client & { localQueryLogs?: (ref: unknown, args: unknown) => string[] | undefined }).localQueryLogs?.(
					api.projects.list,
					{},
				) ?? [])
			: [],
	);

	const dashboardErrorMessage = $derived(
		browser && projectsQuery?.error instanceof Error
			? projectsQuery.error.message
			: browser && projectsQuery?.error
				? String(projectsQuery.error)
				: null,
	);

	const selectedProject = $derived.by(() => {
		if (selectedProjectSlug) {
			return projectsData.find((p: any) => p.slug === selectedProjectSlug) ?? projectsData[0] ?? null;
		}
		return projectsData[0] ?? null;
	});

	$effect(() => {
		if (selectedProject && !selectedProjectSlug) {
			selectedProjectSlug = selectedProject.slug;
		}
	});
</script>

{#if dashboardLoading || (!hydrated || !client)}
	<main class="p-5 px-6 overflow-y-auto max-md:p-4">
		<p class="muted">Loading...</p>
	</main>
	{:else if client}
		<AppSidebar
			projects={projectsData}
		{teams}
		{permissions}
		bind:activeTab
		bind:selectedProjectSlug
		{client}
		groupId={GROUP_ID}
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
						{permissions}
						members={members.map((m) => ({ userId: m.userId, name: m.name }))}
						currentUserId={user.userId}
						groupId={GROUP_ID}
						{client}
					/>
				{/key}
			{:else}
				<p class="muted">No projects yet{permissions.canCreateProjects ? " — click + New in the sidebar." : "."}</p>
			{/if}
		{:else}
			<SettingsPanel
				user={{ name: user.name, email: user.email }}
				userRoleLabel="Admin"
				{members}
				{teams}
				permissions={{
					canManageTeams: permissions.canManageTeams,
					canManageMembers: permissions.canManageMembers,
					canManageSso: permissions.canManageSso,
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
