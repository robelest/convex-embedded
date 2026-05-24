<script lang="ts">
	import { getContext, onMount, type Snippet } from 'svelte';

	let { label, children }: { label: string; children: Snippet } = $props();

	const ctx = getContext<{
		activeTab: number;
		registerTab: (label: string) => number;
		setActive: (idx: number) => void;
	}>('tabs');

	let idx = $state(-1);

	onMount(() => {
		idx = ctx.registerTab(label);
	});
</script>

{#if idx >= 0 && ctx.activeTab === idx}
	<div role="tabpanel">
		{@render children()}
	</div>
{/if}
