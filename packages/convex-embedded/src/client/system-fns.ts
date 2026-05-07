/**
 * Function-shape aliases shared by every local-system queue
 * (mutation pending queue, upload pending queue, IdMap). They all
 * call into runtime-first hydration helpers with the same `(path,
 * args) => Promise<unknown>` shape.
 *
 * @packageDocumentation
 */

/**
 * Optional local query executor. When provided, hydration reads use
 * this instead of `localClient.query()` to stay on the runtime-first
 * execution path. Used by {@link IdMap}, the mutation pending queue,
 * and the upload pending queue.
 *
 * @public
 */
export type LocalQueryExecutorFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Optional local mutation executor. Same shape and motivation as
 * {@link LocalQueryExecutorFn} but for write paths.
 *
 * @public
 */
export type LocalMutationExecutorFn = (
  path: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
