<script lang="ts">
	import { getContext } from "svelte";
	import { useQuery, useConvexClient } from "convex-svelte";
	import { api } from "../../../../convex/_generated/api.js";
	import type { Id } from "../../../../convex/_generated/dataModel.js";
	import type { RemoteState } from "@robelest/convex-embedded/browser";

	const client = useConvexClient();
	const tasks = useQuery(api.tasks.list, {});

	const getSyncStatus = getContext<() => RemoteState>("syncStatus");

	let title = $state("");
	let body = $state("");

	const statusLabel = $derived.by(() => {
		const s = getSyncStatus();
		switch (s.status) {
			case "idle":
				return { text: "Local only", color: "#9ca3af", bg: "#f3f4f6" };
			case "offline":
				return { text: "Offline", color: "#f59e0b", bg: "#fffbeb" };
			case "connecting":
				return { text: "Connecting\u2026", color: "#3b82f6", bg: "#eff6ff" };
			case "syncing":
				return { text: "Syncing\u2026", color: "#3b82f6", bg: "#eff6ff" };
			case "synced":
				return { text: "Synced", color: "#10b981", bg: "#ecfdf5" };
			case "error":
				return { text: "Sync error", color: "#ef4444", bg: "#fef2f2" };
		}
	});

	async function handleAdd() {
		const t = title.trim();
		if (!t) return;
		await client.mutation(api.tasks.create, { title: t, body: body.trim() });
		title = "";
		body = "";
	}

	async function handleRemove(id: Id<"tasks">) {
		await client.mutation(api.tasks.remove, { id });
	}
</script>

<section>
	<!-- Sync status indicator -->
	<div
		style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; padding: 0.375rem 0.75rem; border-radius: 9999px; width: fit-content; font-size: 0.75rem; font-weight: 500; background: {statusLabel.bg}; color: {statusLabel.color};"
	>
		<span
			style="width: 0.5rem; height: 0.5rem; border-radius: 9999px; background: {statusLabel.color};"
		></span>
		{statusLabel.text}
	</div>

	<form
		onsubmit={(e) => {
			e.preventDefault();
			handleAdd();
		}}
		style="display: flex; gap: 0.5rem; margin-bottom: 1.5rem;"
	>
		<input
			bind:value={title}
			placeholder="Task title"
			style="flex: 1; padding: 0.5rem 0.75rem; border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.875rem;"
		/>
		<input
			bind:value={body}
			placeholder="Description (optional)"
			style="flex: 1; padding: 0.5rem 0.75rem; border: 1px solid #d1d5db; border-radius: 0.375rem; font-size: 0.875rem;"
		/>
		<button
			type="submit"
			style="padding: 0.5rem 1rem; background: #2563eb; color: white; border: none; border-radius: 0.375rem; font-size: 0.875rem; cursor: pointer; font-weight: 500;"
		>
			Add
		</button>
	</form>

	{#if tasks.isLoading}
		<p style="color: #9ca3af; font-size: 0.875rem; text-align: center; padding: 2rem 0;">
			Loading...
		</p>
	{:else if tasks.error}
		<p style="color: #ef4444; font-size: 0.875rem; text-align: center; padding: 2rem 0;">
			Error: {tasks.error.message}
		</p>
	{:else if tasks.data && tasks.data.length === 0}
		<p style="color: #9ca3af; font-size: 0.875rem; text-align: center; padding: 2rem 0;">
			No tasks yet. Add one above.
		</p>
	{:else}
		<ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem;">
			{#each tasks.data ?? [] as task (task._id)}
				<li
					style="display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1rem; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 0.375rem;"
				>
					<div>
						<div style="font-size: 0.875rem; font-weight: 500;">{task.title}</div>
						{#if task.body}
							<div style="font-size: 0.75rem; color: #6b7280; margin-top: 0.125rem;">
								{task.body}
							</div>
						{/if}
					</div>
					<button
						onclick={() => handleRemove(task._id)}
						style="padding: 0.25rem 0.5rem; background: none; border: 1px solid #d1d5db; border-radius: 0.25rem; font-size: 0.75rem; color: #6b7280; cursor: pointer;"
					>
						Remove
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>
