/**
 * Capability probes for {@link PersistenceAdapter} instances.
 *
 * The runtime needs synchronous yes/no answers about adapter capabilities at
 * dispatch time. Class instances expose `supportsAtomicCommit` and
 * `supportsPushdownReads` as readonly flags; these probes read them and
 * handle the `null` / `undefined` cases.
 *
 * @internal
 */

import type { PersistenceAdapter } from "@/persistence/adapter";

/** True when the adapter bypasses the materialized commit pipeline. */
export function hasAuthoritativeCommit(
  adapter: PersistenceAdapter | null | undefined,
): boolean {
  return adapter?.supportsAtomicCommit === true;
}

/** True when the adapter pushes any reads down (query/source/vectorSearch). */
export function hasPushdownReads(
  adapter: PersistenceAdapter | null | undefined,
): boolean {
  return adapter?.supportsPushdownReads === true;
}
