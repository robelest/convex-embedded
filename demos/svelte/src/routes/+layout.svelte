<script lang="ts">
	import "./layout.css";
	import { browser } from "$app/environment";
	import favicon from "$lib/assets/favicon.svg";
	import Toaster from "$lib/components/Toaster.svelte";
	import { onDestroy, onMount, setContext } from "svelte";
	import type { Snippet } from "svelte";
	import { setConvexClientContext } from "convex-svelte";
	import {
		createConvexClient,
		subscribeRemoteState,
		type RemoteState,
	} from "@robelest/convex-embedded/browser";
	import type { UserIdentity } from "@robelest/convex-embedded/auth";
	import type { LayoutData } from "./$types";
	import { convex } from "$convex/_generated/embedded";
	import * as schemaModule from "$convex/schema";

	let { children, data }: { children: Snippet; data: LayoutData } =
		$props();

	function getBrowserIdentity(): UserIdentity | null {
		const identityKey = data.auth.identityKey;
		return identityKey
			? {
				subject: identityKey,
				issuer: "embedded-svelte-demo",
				tokenIdentifier: identityKey,
			}
			: null;
	}

	function createSsrBootstrappedClient() {
		return createConvexClient({
			convex,
			schema: schemaModule,
			name: "convex-embedded-svelte-demo",
			prefetch: data.embedded,
			auth: {
				fetchToken: async () => data.auth.token,
				getUserIdentity: async () => getBrowserIdentity(),
				getIdentityKey: (identity) => identity?.tokenIdentifier ?? null,
			},
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

	let devtools: { unmount: () => void } | null = null;

	onMount(() => {
		if (import.meta.env.DEV && client) {
			void import("@robelest/convex-embedded/devtools").then(
				({ mountEmbeddedDevtools }) => {
					devtools = mountEmbeddedDevtools(client);
				},
			);
		}

		async function registerServiceWorker() {
			const registration = await navigator.serviceWorker.register(
				"/service-worker.js",
				{ scope: "/" },
			);

			await navigator.serviceWorker.ready;

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
		devtools?.unmount();
		unsubscribe();
		client?.close();
	});

	if (import.meta.hot) {
		import.meta.hot.dispose(() => {
			devtools?.unmount();
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
