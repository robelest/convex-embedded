<script lang="ts">
	import "./layout.css";
	import { browser } from "$app/environment";
	import favicon from "$lib/assets/favicon.svg";
	import Toaster from "$lib/components/Toaster.svelte";
	import workerUrl from "$lib/embeddedWorkerUrl";
	import { onDestroy, onMount, setContext } from "svelte";
	import type { Snippet } from "svelte";
	import { setConvexClientContext } from "convex-svelte";
	import {
		createConvexClient,
		subscribeRemoteState,
		type RemoteState,
	} from "@robelest/convex-embedded/browser";
	import type { Replica } from "@robelest/convex-embedded/client";
	import { modules } from "../convex-modules";
	import schema from "$convex/schema";

	type LayoutDataShape = {
		replica: Replica | null;
		convexUrl: string | null;
	};

	let { children, data }: { children: Snippet; data: LayoutDataShape } =
		$props();

	function createSsrBootstrappedClient() {
		return createConvexClient({
			modules,
			schema,
			name: "convex-embedded-svelte-demo",
			workerUrl,
			replica: data.replica ?? undefined,
			...(data.convexUrl ? { remote: { url: data.convexUrl } } : {}),
		});
	}

	const client = browser
		? createSsrBootstrappedClient()
		: null;

	if (client) {
		setConvexClientContext(client);
	}

	let syncStatus: RemoteState = $state({ status: "idle" });
	setContext("syncStatus", () => syncStatus);

	const unsubscribe = client
		? subscribeRemoteState(client, (state) => {
				syncStatus = state;
			})
		: () => {};

	onMount(() => {
		async function registerServiceWorker() {
			const registration = await navigator.serviceWorker.register(
				"/service-worker.js",
				{ scope: "/" },
			);

			await navigator.serviceWorker.ready;

			try {
				await fetch(workerUrl, { cache: "reload" });
			} catch (error) {
				console.warn(
					"[convex-embedded] failed to warm dedicated worker cache",
					error,
				);
			}

			return registration;
		}

		if (!import.meta.env.PROD || !("serviceWorker" in navigator)) {
			return;
		}

		void registerServiceWorker()
			.catch((error) => {
				console.error(
					"[convex-embedded] service worker registration failed",
					error,
				);
			});
	});

	onDestroy(() => {
		unsubscribe();
		client?.close();
	});

	if (import.meta.hot) {
		import.meta.hot.dispose(() => {
			unsubscribe();
			client?.close();
		});
	}
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>convex-embedded demo</title>
</svelte:head>

	<Toaster />

	<div
		class="grid min-h-dvh grid-cols-[12rem_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[auto_1fr]"
		data-theme="light"
	>
		{@render children()}
	</div>
