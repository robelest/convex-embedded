/**
 * Svelte 5 reactive helpers for Convex queries and mutations.
 *
 * Uses $state runes for fine-grained reactivity. The ConvexClient's
 * `onUpdate` callback pushes new values which Svelte picks up
 * automatically through the reactive $state.
 */

import { getClient } from './embedded.js';
import type { FunctionReference, FunctionArgs, FunctionReturnType } from 'convex/server';

// ---------------------------------------------------------------------------
// useQuery — reactive subscription to a Convex query
// ---------------------------------------------------------------------------

/**
 * Subscribe to a Convex query. Returns a reactive object with
 * `.data`, `.error`, and `.isLoading` properties.
 *
 * Must be called in a component initialization context (or $effect.root).
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useQuery } from '$lib/convex.svelte';
 *   import { api } from '@convex/_generated/api';
 *   const tasks = useQuery(api.tasks.list, {});
 * </script>
 * {#if tasks.isLoading}Loading...{/if}
 * {#each tasks.data ?? [] as task}{task.title}{/each}
 * ```
 */
export function useQuery<Q extends FunctionReference<'query'>>(
	query: Q,
	args: FunctionArgs<Q>
): { data: FunctionReturnType<Q> | undefined; error: Error | null; isLoading: boolean } {
	let data = $state<FunctionReturnType<Q> | undefined>(undefined);
	let error = $state<Error | null>(null);
	let isLoading = $state(true);

	const client = getClient();

	const unsub = client.onUpdate(
		query,
		args,
		(result: FunctionReturnType<Q>) => {
			data = result;
			error = null;
			isLoading = false;
		},
		(err: Error) => {
			error = err;
			isLoading = false;
		}
	);

	// Clean up on destroy
	$effect(() => {
		return () => {
			unsub();
		};
	});

	return {
		get data() {
			return data;
		},
		get error() {
			return error;
		},
		get isLoading() {
			return isLoading;
		}
	};
}

// ---------------------------------------------------------------------------
// useMutation — call a Convex mutation
// ---------------------------------------------------------------------------

/**
 * Returns a function that calls a Convex mutation.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { useMutation } from '$lib/convex.svelte';
 *   import { api } from '@convex/_generated/api';
 *   const createTask = useMutation(api.tasks.create);
 * </script>
 * <button onclick={() => createTask({ title: 'New', body: '' })}>Add</button>
 * ```
 */
export function useMutation<M extends FunctionReference<'mutation'>>(
	mutation: M
): (args: FunctionArgs<M>) => Promise<FunctionReturnType<M>> {
	const client = getClient();
	return (args: FunctionArgs<M>) => client.mutation(mutation, args);
}
