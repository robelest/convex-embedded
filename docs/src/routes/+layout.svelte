<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import '../app.css';
	import 'katex/dist/katex.min.css';
	import Header from '$lib/components/docs/Header.svelte';
	import Sidebar from '$lib/components/docs/Sidebar.svelte';
	import MobileNav from '$lib/components/docs/MobileNav.svelte';

	let { children } = $props();
	let mobileNavOpen = $state(false);

	const isLanding = $derived(page.url.pathname === '/');

	// Wrap markdown tables in scrollable containers
	function wrapTables(node: HTMLElement) {
		const tables = node.querySelectorAll('table');
		for (const table of tables) {
			if (table.parentElement?.classList.contains('table-scroll')) continue;
			const wrapper = document.createElement('div');
			wrapper.className = 'table-scroll';
			table.parentNode?.insertBefore(wrapper, table);
			wrapper.appendChild(table);
		}
	}

	// Render mermaid diagrams client-side
	$effect(() => {
		// Track page changes to re-render mermaid on navigation
		page.url.pathname;
		setTimeout(async () => {
			const els = document.querySelectorAll('pre.mermaid');
			if (els.length === 0) return;
			try {
				const mermaid = (await import('mermaid')).default;
				mermaid.initialize({
					startOnLoad: false,
					theme: 'neutral',
					fontFamily: 'inherit',
				});
				await mermaid.run({ nodes: els as any });
			} catch (e) {
				console.warn('Mermaid rendering failed:', e);
			}
		}, 0);
	});
</script>

<svelte:head>
	<title>convex-embedded</title>
</svelte:head>

<Header onMenuToggle={() => (mobileNavOpen = !mobileNavOpen)} />
<MobileNav bind:open={mobileNavOpen} />

{#if isLanding}
	<main class="landing" data-pagefind-body>
		{@render children()}
	</main>
{:else}
	<div class="docs-layout">
		<div class="sidebar-container">
			<Sidebar />
		</div>
		<main class="docs-main">
			<div class="doc-content" data-pagefind-body use:wrapTables>
				{@render children()}
			</div>
		</main>
	</div>
{/if}

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		width: 100%;
		overflow-x: hidden;
	}

	:global(body) {
		padding-top: 3.5rem;
	}

	.docs-layout {
		min-height: calc(100dvh - 3.5rem);
	}

	.sidebar-container {
		display: none;
	}

	.docs-main {
		max-width: 100ch;
		width: 100%;
		min-width: 0;
		margin: 0 auto;
		padding: 1rem 1rem 3rem;
	}

	@media (min-width: 768px) {
		.sidebar-container {
			display: block;
			position: fixed;
			top: 3.5rem;
			bottom: 0;
			left: 0;
			width: 15rem;
			border-right: 1px solid var(--color-gray-300);
			z-index: 10;
		}

		:global([data-theme='dark']) .sidebar-container {
			border-right-color: var(--color-gray-800);
		}

		.docs-main {
			margin-left: 15rem;
			padding: 1rem 1.5rem 3rem;
		}
	}

	.landing {
		max-width: 70ch;
		margin: 0 auto;
		padding: 4rem 1rem;
	}

	@media (min-width: 768px) {
		.landing {
			padding: 6rem 1.5rem;
		}
	}
</style>
