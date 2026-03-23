<script lang="ts">
	import { onDestroy, setContext } from "svelte";
	import { setConvexClientContext } from "convex-svelte";
	import { createConvexClient, subscribeRemoteState } from "@robelest/convex-embedded/browser";
	import type { RemoteState } from "@robelest/convex-embedded/browser";
	import schema from "../../../../convex/schema";

	let { children } = $props();

	const modules = import.meta.glob(["../../../../convex/tasks.ts"]);

	const convexUrl = import.meta.env.CONVEX_URL as string | undefined;

	const client = createConvexClient({
		modules,
		schema,
		name: "convex-embedded-svelte-demo",
		...(convexUrl ? { remote: { url: convexUrl } } : {}),
	});

	setConvexClientContext(client);

	// Reactive remote status shared via context
	let syncStatus: RemoteState = $state({ status: "idle" });
	setContext("syncStatus", () => syncStatus);

	const unsubResolve = subscribeRemoteState(client, (s: RemoteState) => {
		syncStatus = s;
	});

	// Cleanup on component destroy (navigation) and HMR replacement
	onDestroy(() => {
		unsubResolve();
		client.close();
	});

	if (import.meta.hot) {
		import.meta.hot.dispose(() => {
			unsubResolve();
			client.close();
		});
	}
</script>

<svelte:head>
	<title>convex-embedded</title>
	<link
		rel="stylesheet"
		href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
	/>
</svelte:head>

<div style="font-family: 'Inter', system-ui, sans-serif;">
	<header
		style="border-bottom: 1px solid #e5e7eb; background: #fff; position: sticky; top: 0; z-index: 10;"
	>
		<div style="max-width: 48rem; margin: 0 auto; padding: 0.75rem 1rem;">
			<h1 style="font-size: 1rem; font-weight: 600; margin: 0;">convex-embedded</h1>
			<p style="font-size: 0.75rem; color: #9ca3af; margin: 0;">
				Full Convex backend running in the browser
			</p>
		</div>
	</header>

	<main style="max-width: 48rem; margin: 0 auto; padding: 1.5rem 1rem;">
		{@render children()}
	</main>
</div>
