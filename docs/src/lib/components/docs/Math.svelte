<script lang="ts">
	import katex from 'katex';

	let {
		expr,
		display = false,
		align = 'left',
	}: { expr: string; display?: boolean; align?: 'left' | 'center' | 'right' } = $props();

	const html = $derived(
		katex.renderToString(expr, {
			displayMode: display,
			throwOnError: false,
			strict: 'warn',
		}),
	);
</script>

<span class:display={display} class:left={align === 'left'} class:center={align === 'center'} class:right={align === 'right'}>{@html html}</span>

<style>
	.display {
		display: block;
		overflow-x: auto;
		margin: 1rem 0;
	}

	.display.left {
		text-align: left;
	}

	.display.center {
		text-align: center;
	}

	.display.right {
		text-align: right;
	}

	.display :global(.katex-display) {
		margin: 0;
	}
</style>
