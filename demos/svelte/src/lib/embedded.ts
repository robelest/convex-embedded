/// <reference types="vite/client" />
/**
 * Embedded Convex runtime — runs a lightweight Convex backend in the browser.
 *
 * Creates an in-memory embedded runtime that loads the convex/ modules
 * from the monorepo root. The transport it produces can be used to create
 * a ConvexClient that talks to this local runtime instead of the cloud.
 */

// Allow Convex server functions (mutation/query/action) to be imported in the
// browser. The Convex SDK guards against this to prevent accidental secret
// leakage, but the embedded runtime intentionally runs functions in-browser.
(globalThis as any).__convexAllowFunctionsInBrowser = true;

import { createEmbeddedConvex } from '@robelest/convex-embedded';
import { ConvexClient } from 'convex/browser';

// Eagerly import all convex function modules (excluding generated & config).
// Two levels up from src/lib/ -> demos/svelte/ -> demos/ -> repo root.
const modules = import.meta.glob(
	['../../../../convex/**/*.{ts,tsx,js,jsx}', '!../../../../convex/convex.config.ts'],
	{ eager: false }
);

console.log(
	'[convex-embedded] glob matched',
	Object.keys(modules).length,
	'modules:',
	Object.keys(modules)
);

let _client: ConvexClient | null = null;

/**
 * Get a singleton ConvexClient backed by the embedded runtime.
 * Call this only in the browser (e.g. from onMount or a browser-only module).
 */
export function getClient(): ConvexClient {
	if (_client) return _client;

	console.log('[convex-embedded] creating runtime...');
	const runtime = createEmbeddedConvex({ modules });
	console.log('[convex-embedded] runtime created');

	const transport = runtime.createTransport();
	console.log('[convex-embedded] transport ready:', transport.url);

	_client = new ConvexClient(transport.url, {
		webSocketConstructor: transport.webSocketConstructor,
		unsavedChangesWarning: false
	});
	console.log('[convex-embedded] ConvexClient created');

	return _client;
}
