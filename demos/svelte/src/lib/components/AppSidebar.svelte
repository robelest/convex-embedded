<script lang="ts">
  import type { ConvexClient } from "convex/browser";
  import { api } from "$convex/_generated/api.js";
  import { fly, fade } from "svelte/transition";
  import List from "phosphor-svelte/lib/List";
  import X from "phosphor-svelte/lib/X";

  let {
    projects,
    teams,
    permissions,
    activeTab = $bindable("issues"),
    selectedProjectSlug = $bindable(null),
    client,
    groupId,
  } = $props<{
		projects: Array<{
		  _id: string;
		  name: string;
      identifier: string;
      slug: string;
      teamGroupId: string | null;
      openIssueCount: number;
    }>;
    teams: Array<{
      groupId: string;
      name: string;
      children: Array<{ groupId: string; name: string }>;
    }>;
    permissions: {
      canManageTeams: boolean;
      canCreateProjects: boolean;
    };
    activeTab: "issues" | "settings";
    selectedProjectSlug: string | null;
    client: ConvexClient;
    groupId: string;
  }>();

  let mobileOpen = $state(false);

  let showNewProject = $state(false);
  let newProjectTeamId = $state<string | null>(null);
  let newProjectName = $state("");
  let newProjectIdentifier = $state("");
  let newProjectError = $state<string | null>(null);
  let createProjectRequests = $state(0);

	const allTeamGroups = $derived.by(() => {
		const result: Array<{ groupId: string; name: string; indent: boolean }> = [];
		for (const team of teams) {
      result.push({ groupId: team.groupId, name: team.name, indent: false });
      for (const child of team.children) {
        result.push({ groupId: child.groupId, name: child.name, indent: true });
      }
    }
    return result;
	});

	const hasTeams = $derived(allTeamGroups.length > 0);
	const ungroupedProjects = $derived(
		projects.filter((project: (typeof projects)[number]) => !project.teamGroupId),
	);

	const teamsWithProjects = $derived.by(() => {
		return teams
			.map((team: (typeof teams)[number]) => {
				const teamProjects = projects.filter(
					(project: (typeof projects)[number]) => project.teamGroupId === team.groupId,
				);
				const childrenWithProjects = team.children
					.map((child: (typeof team.children)[number]) => ({
						...child,
						projects: projects.filter(
							(project: (typeof projects)[number]) =>
								project.teamGroupId === child.groupId,
						),
					}))
					.filter((child: { projects: Array<unknown> }) => child.projects.length > 0);
				return { ...team, projects: teamProjects, children: childrenWithProjects };
			})
			.filter(
				(team: { projects: Array<unknown>; children: Array<unknown> }) =>
					team.projects.length > 0 || team.children.length > 0,
			);
	});

  function selectProject(slug: string) {
    selectedProjectSlug = slug;
    activeTab = "issues";
    mobileOpen = false;
  }

  function openNewProject() {
    showNewProject = true;
    newProjectTeamId = hasTeams ? allTeamGroups[0].groupId : null;
    newProjectName = "";
    newProjectIdentifier = "";
    newProjectError = null;
  }

  async function handleCreateProject() {
    const name = newProjectName.trim();
    const identifier = newProjectIdentifier.trim();
    if (!name || !identifier) return;
    createProjectRequests += 1;
    newProjectError = null;
    newProjectName = "";
    newProjectIdentifier = "";
    try {
		await client.mutation(api.projects.create, {
        ...(newProjectTeamId ? { teamGroupId: newProjectTeamId } : {}),
        name,
        identifier,
        description: "",
      });
      showNewProject = false;
    } catch (e: unknown) {
      newProjectError = e instanceof Error ? e.message : "Failed to create project";
      if (!newProjectName.trim()) {
        newProjectName = name;
      }
      if (!newProjectIdentifier.trim()) {
        newProjectIdentifier = identifier;
      }
    } finally {
      createProjectRequests -= 1;
    }
  }

  function goToSettings() {
    activeTab = "settings";
    mobileOpen = false;
  }
</script>

<!-- Mobile: hamburger bar -->
<header class="hidden max-md:flex items-center gap-3 px-4 py-2.5 border-b border-gray-300 bg-gray-50 shrink-0">
  <button
    class="bg-transparent border-0 p-0 cursor-pointer flex items-center text-gray-600"
    onclick={() => { mobileOpen = true; }}
    aria-label="Open menu"
  >
    <List size={20} />
  </button>
  <span class="font-label text-[0.75rem] font-semibold text-gray-700 truncate">convex-embedded</span>
</header>

<!-- Mobile: slide-out sheet -->
{#if mobileOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 bg-black/30 z-40 md:hidden"
    transition:fade={{ duration: 100 }}
    onclick={() => { mobileOpen = false; }}
  ></div>

	<aside
		class="fixed inset-y-0 left-0 w-64 z-50 py-4 bg-gray-50 flex flex-col overflow-y-auto shadow-lg md:hidden"
		transition:fly={{ x: -300, duration: 200 }}
	>
		<div class="px-3 flex items-center justify-between h-6">
			<span class="font-label text-[0.6875rem] font-semibold uppercase tracking-[0.1em] text-gray-500 leading-none">convex-embedded</span>
      <button
        class="bg-transparent border-0 p-0 cursor-pointer flex items-center text-gray-400 hover:text-gray-600 leading-none"
        onclick={() => { mobileOpen = false; }}
        aria-label="Close menu"
      >
        <X size={16} />
      </button>
    </div>

    {@render sidebarContent()}
  </aside>
{/if}

<!-- Desktop: static sidebar -->
<aside class="sticky top-0 h-dvh py-4 border-r border-gray-300 bg-gray-50 flex flex-col overflow-y-auto max-md:hidden">
	<div class="px-3 flex flex-col gap-1.5">
		<p class="label">convex-embedded</p>
	</div>

  {@render sidebarContent()}
</aside>

{#snippet sidebarContent()}
  <nav class="mt-3 pt-3 border-t border-gray-300 flex flex-col gap-0.5 flex-1 overflow-y-auto">
    <div class="flex items-center justify-between px-3 mb-1">
      <p class="font-label text-[0.6rem] font-semibold uppercase tracking-[0.1em] text-gray-400 m-0">Projects</p>
      {#if permissions.canCreateProjects}
        <button
          class="font-label text-[0.65rem] font-semibold text-accent-500 hover:text-accent-600 bg-transparent border-0 cursor-pointer p-0"
          onclick={openNewProject}
        >+ New</button>
      {/if}
    </div>

    {#if showNewProject}
      <form class="px-3 pb-2 flex flex-col gap-1.5 border-b border-gray-200 mb-1" onsubmit={(e) => { e.preventDefault(); handleCreateProject(); }}>
        {#if hasTeams}
          <select class="select select--compact w-full" bind:value={newProjectTeamId}>
            <option value={null}>No team</option>
			{#each allTeamGroups as tg (tg.groupId)}
              <option value={tg.groupId}>{tg.indent ? "  " : ""}{tg.name}</option>
            {/each}
          </select>
        {/if}
        <input class="input input--compact w-full" bind:value={newProjectName} placeholder="Project name" maxlength="50" type="text" />
        <input class="input input--compact w-full" bind:value={newProjectIdentifier} placeholder="ID (e.g. AUTH)" maxlength="6" type="text" style="text-transform: uppercase" />
        <div class="flex gap-1">
          <button class="button button--accent button--compact flex-1" type="submit" disabled={!newProjectName.trim() || !newProjectIdentifier.trim()}>
            {createProjectRequests > 0 ? "..." : "Create"}
          </button>
          <button class="button button--secondary button--compact" type="button" onclick={() => { showNewProject = false; }}>Cancel</button>
        </div>
        {#if newProjectError}
          <p class="error-banner">{newProjectError}</p>
        {/if}
      </form>
    {/if}

		{#each ungroupedProjects as project (project._id)}
      <button
        class="block w-full py-[0.3rem] px-3 border-0 border-l-2 border-l-transparent bg-transparent font-label text-[0.75rem] font-medium text-left text-gray-700 cursor-pointer hover:text-accent-600 hover:bg-gray-100 {selectedProjectSlug === project.slug && activeTab === 'issues' ? 'border-l-accent-500 !text-accent-600 font-semibold bg-gray-100' : ''}"
        onclick={() => selectProject(project.slug)}
      >
        <span class="font-semibold text-gray-400">{project.identifier}</span>
        <span class="ml-1">{project.name}</span>
        {#if project.openIssueCount > 0}
          <span class="ml-1 text-[0.625rem] text-gray-400">{project.openIssueCount}</span>
        {/if}
      </button>
    {/each}

		{#each teamsWithProjects as team (team.groupId)}
			<span class="px-3 py-1 mt-1 font-label text-[0.6875rem] font-semibold text-gray-500">{team.name}</span>
			{#each team.projects as project (project._id)}
        <button
          class="block w-full py-[0.3rem] px-3 pl-5 border-0 border-l-2 border-l-transparent bg-transparent font-label text-[0.75rem] font-medium text-left text-gray-700 cursor-pointer hover:text-accent-600 hover:bg-gray-100 {selectedProjectSlug === project.slug && activeTab === 'issues' ? 'border-l-accent-500 !text-accent-600 font-semibold bg-gray-100' : ''}"
          onclick={() => selectProject(project.slug)}
        >
          <span class="font-semibold text-gray-400">{project.identifier}</span>
          <span class="ml-1">{project.name}</span>
          {#if project.openIssueCount > 0}
            <span class="ml-1 text-[0.625rem] text-gray-400">{project.openIssueCount}</span>
          {/if}
        </button>
      {/each}
			{#each team.children as child (child.groupId)}
				<span class="px-3 pl-5 py-0.5 font-label text-[0.625rem] text-gray-400">{child.name}</span>
				{#each child.projects as project (project._id)}
          <button
            class="block w-full py-[0.3rem] px-3 pl-7 border-0 border-l-2 border-l-transparent bg-transparent font-label text-[0.75rem] font-medium text-left text-gray-700 cursor-pointer hover:text-accent-600 hover:bg-gray-100 {selectedProjectSlug === project.slug && activeTab === 'issues' ? 'border-l-accent-500 !text-accent-600 font-semibold bg-gray-100' : ''}"
            onclick={() => selectProject(project.slug)}
          >
            <span class="font-semibold text-gray-400">{project.identifier}</span>
            <span class="ml-1">{project.name}</span>
            {#if project.openIssueCount > 0}
              <span class="ml-1 text-[0.625rem] text-gray-400">{project.openIssueCount}</span>
            {/if}
          </button>
        {/each}
      {/each}
    {/each}
  </nav>

  <div class="mt-auto pt-3 px-3 border-t border-gray-300">
    <button
      class="block w-full py-[0.3rem] px-3 border-0 border-l-2 border-l-transparent bg-transparent font-label text-[0.75rem] font-medium text-left text-gray-700 cursor-pointer hover:text-accent-600 {activeTab === 'settings' ? 'border-l-accent-500 !text-accent-600 font-semibold' : ''}"
      onclick={goToSettings}
    >Settings</button>
  </div>
{/snippet}
