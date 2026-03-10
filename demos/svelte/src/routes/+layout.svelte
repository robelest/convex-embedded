<script lang="ts">
	import { setContext } from "svelte";
	import { setConvexClientContext } from "convex-svelte";
	import { getClient } from "@robelest/convex-embedded/browser";
	import { monitor } from "@robelest/convex-resolve/client";
	import type { MonitorStatus, MonitorInstance } from "@robelest/convex-resolve/client";
	import { ConvexClient } from "convex/browser";
	import { api } from "$convex/_generated/api";

	let { children } = $props();

	// ── Local embedded client (instant, offline-capable) ──────────────
	const modules = import.meta.glob(
		["$convex/**/*.{ts,tsx,js,jsx}", "!$convex/convex.config.ts"],
	);

	const localClient = getClient({
		modules,
		workerUrl: new URL("@robelest/convex-embedded/worker", import.meta.url),
	});

	// Queries use the embedded client directly via convex-svelte context
	setConvexClientContext(localClient);

	// ── Remote client + sync monitor ─────────────────────────────────
	const convexUrl = import.meta.env.CONVEX_URL as string | undefined;

	// Reactive sync status shared via context
	let syncStatus: MonitorStatus = $state({ status: "idle" });
	setContext("syncStatus", () => syncStatus);

	if (convexUrl) {
		const remoteClient = new ConvexClient(convexUrl);

		const m = monitor.create({
			localClient,
			remoteClient,
			tables: {
				tasks: { resolve: api.tasks.resolve },
			},
		});

		m.on("change", (s) => {
			syncStatus = s;
		});

		// Expose monitor via context so pages can call m.mutation()
		setContext("monitor", m);

		m.start();
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
