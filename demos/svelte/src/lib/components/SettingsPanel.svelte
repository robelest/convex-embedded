<script lang="ts">
	import { getContext } from "svelte";
	import type { RemoteState } from "@robelest/convex-embedded/browser";

	const getSyncStatus = getContext<() => RemoteState>("syncStatus");

	let { user, userRoleLabel, members, teams, permissions } = $props<{
		user: { name: string; email: string | null };
		userRoleLabel: string;
		members: ReadonlyArray<{
      memberId: string;
      userId: string;
      name: string;
      email: string | null;
      roleIds: readonly string[];
    }>;
    teams: Array<{
      groupId: string;
      name: string;
      children: Array<{ name: string }>;
    }>;
		permissions: {
			canManageTeams: boolean;
			canManageMembers: boolean;
			canManageSso: boolean;
		};
	}>();

	let tab = $state<"members" | "teams" | "permissions">("members");

	const syncLabel = $derived.by(() => {
		switch (getSyncStatus().status) {
			case "idle":
				return { text: "Local only", tone: "chip chip--role" };
			case "offline":
				return { text: "Offline", tone: "chip chip--medium" };
			case "connecting":
				return { text: "Connecting", tone: "chip chip--grant" };
			case "resolving":
				return { text: "Resolving", tone: "chip chip--grant" };
			case "resolved":
				return { text: "Synced", tone: "chip chip--low" };
			case "error":
				return { text: "Sync error", tone: "chip chip--urgent" };
		}
	});

	const permissionMatrix = [
		{ label: "View projects & issues", admin: true, member: true, viewer: true },
		{ label: "Create issues", admin: true, member: true, viewer: false },
		{ label: "Edit issues", admin: true, member: true, viewer: false },
		{ label: "Move issue status", admin: true, member: true, viewer: false },
		{ label: "Assign issues to others", admin: true, member: false, viewer: false },
		{ label: "Delete issues", admin: true, member: false, viewer: false },
		{ label: "Create projects", admin: true, member: false, viewer: false },
		{ label: "View sync diagnostics", admin: true, member: true, viewer: true },
		{ label: "Manage teams", admin: true, member: false, viewer: false },
		{ label: "Manage members & roles", admin: true, member: false, viewer: false },
	];

	const tabs = [
		{ id: "members" as const, label: "Members" },
		{ id: "teams" as const, label: "Teams" },
		{ id: "permissions" as const, label: "Permissions" },
	];

	function getRoleLabel(roleIds: readonly string[]) {
		if (roleIds.includes("orgAdmin")) return "Admin";
		if (roleIds.includes("member")) return "Member";
		return "Viewer";
	}
</script>

<div class="flex flex-col gap-4">
	<!-- Account bar -->
	<div class="flex justify-between items-center gap-3 pb-3 border-b border-gray-300">
		<div class="flex flex-col gap-1">
			<div class="flex items-center gap-2">
				<span class="font-label text-[0.75rem] text-gray-700">{user.name}</span>
				<span class="chip chip--role">{userRoleLabel}</span>
				<span class={syncLabel.tone}>{syncLabel.text}</span>
			</div>
			<p class="muted">
				This demo keeps the product surface familiar while the runtime stays local-first.
			</p>
		</div>
	</div>

  <!-- Tabs -->
  <div class="flex gap-0 border-b border-gray-300">
		{#each tabs as t (t.id)}
      <button
        class="py-2 px-4 border-0 border-b-2 bg-transparent font-label text-[0.75rem] font-medium cursor-pointer {tab === t.id ? 'border-b-accent-500 text-accent-600 font-semibold' : 'border-b-transparent text-gray-500 hover:text-gray-700'}"
        onclick={() => { tab = t.id; }}
      >{t.label}</button>
    {/each}
  </div>

	<!-- Tab content -->
	{#if tab === "members"}
		<!-- Member list -->
		<div class="flex flex-col">
			{#each members as member (member.userId)}
				<div class="flex justify-between items-center gap-2 py-1.5 border-b border-gray-200">
					<div class="flex flex-col">
						<span class="text-sm text-gray-900">{member.name}</span>
						{#if member.email}
							<span class="font-label text-[0.6875rem] text-gray-400">{member.email}</span>
						{/if}
					</div>
					<span class="chip chip--role">{getRoleLabel(member.roleIds)}</span>
				</div>
			{:else}
				<p class="muted">No members.</p>
      {/each}
    </div>

  {:else if tab === "teams"}
			<div class="flex flex-col">
				{#each teams as team (team.groupId)}
					<div class="flex justify-between items-center gap-2 py-1.5 border-b border-gray-200">
						<span class="text-sm text-gray-900">{team.name}</span>
						{#if team.children.length > 0}
            <span class="font-label text-xs text-gray-500">{team.children.map((c: { name: string }) => c.name).join(", ")}</span>
          {/if}
        </div>
      {:else}
					<p class="muted">No teams.</p>
				{/each}
			</div>

		{:else if tab === "permissions"}
			<div class="overflow-x-auto">
      <table class="w-full font-label text-[0.75rem]">
        <thead>
          <tr class="border-b border-gray-300">
            <th class="text-left py-1.5 pr-4 text-gray-500 font-semibold">Action</th>
            <th class="text-center py-1.5 px-3 text-gray-500 font-semibold">Admin</th>
            <th class="text-center py-1.5 px-3 text-gray-500 font-semibold">Member</th>
            <th class="text-center py-1.5 px-3 text-gray-500 font-semibold">Viewer</th>
          </tr>
        </thead>
        <tbody>
			{#each permissionMatrix as row (row.label)}
            <tr class="border-b border-gray-200">
              <td class="py-1.5 pr-4 text-gray-700">{row.label}</td>
              <td class="text-center py-1.5 px-3 {row.admin ? 'text-green-600' : 'text-gray-300'}">{row.admin ? "yes" : "—"}</td>
              <td class="text-center py-1.5 px-3 {row.member ? 'text-green-600' : 'text-gray-300'}">{row.member ? "yes" : "—"}</td>
              <td class="text-center py-1.5 px-3 {row.viewer ? 'text-green-600' : 'text-gray-300'}">{row.viewer ? "yes" : "—"}</td>
            </tr>
          {/each}
        </tbody>
				</table>
			</div>
		{/if}
</div>
