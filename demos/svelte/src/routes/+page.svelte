<script lang="ts">
	import { useQuery, useConvexClient } from "convex-svelte";
	import { api } from "$convex/_generated/api";

	const tasks = useQuery(api.tasks.list, {});
	const client = useConvexClient();

	let title = $state("");
	let body = $state("");

	async function handleAdd() {
		const t = title.trim();
		if (!t) return;
		await client.mutation(api.tasks.create, { title: t, body: body.trim() });
		title = "";
		body = "";
	}

	async function handleRemove(id: string) {
		await client.mutation(api.tasks.remove, { id: id as any });
	}
</script>

<section>
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
