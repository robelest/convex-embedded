/**
 * Route mode is the per-export annotation that tells the SDK whether a
 * Convex function should run in the embedded runtime, on the remote
 * deployment, or both. Set via {@link markRoute} (typically through the
 * `localOnly()` / `remoteOnly()` builders), read at dispatch time via
 * {@link getRouteMode} / {@link isRemoteOnly} / {@link isLocalOnly}.
 *
 * @packageDocumentation
 */

/** @internal — symbol key used to attach route metadata to a function value. */
export const ROUTE = Symbol.for("convex-embedded:route");

/**
 * How a Convex function dispatches in the embedded runtime.
 *
 * - `"auto"` (default) — function runs both locally and on the server,
 *   with mutations replaying through the pending queue (the "mirror"
 *   default).
 * - `"local"` — function runs only in the embedded runtime; the SDK
 *   skips the replay queue and the codegen `--strip` may exclude it
 *   from the server bundle on deploy (planned).
 * - `"remote"` — function runs only on the remote Convex deployment;
 *   the SDK forwards calls and the AST-based codegen excludes the
 *   module from the client bundle entirely.
 *
 * @public
 */
export type RouteMode = "auto" | "local" | "remote";

/**
 * Why the routing layer decided a function must execute remotely.
 * Surfaces in `MutationPlan` / `ReadPlan` for diagnostic logging.
 *
 * - `"component-routed"` — the call target sits inside a Convex
 *   component (componentPath is non-empty); component refs are
 *   remote-routed in alpha.
 * - `"remote-routed"` — the function was explicitly wrapped in
 *   `remoteOnly()`.
 *
 * @public
 */
export type RemoteRouteReason = "component-routed" | "remote-routed";

interface RouteMeta {
  readonly __brand: "convex-embedded:route";
  readonly mode: RouteMode;
}

const ROUTE_META = {
  auto: {
    __brand: "convex-embedded:route",
    mode: "auto",
  },
  local: {
    __brand: "convex-embedded:route",
    mode: "local",
  },
  remote: {
    __brand: "convex-embedded:route",
    mode: "remote",
  },
} satisfies Record<RouteMode, RouteMeta>;

function isTaggable(value: unknown): value is object {
  return (
    typeof value === "function" || (typeof value === "object" && value !== null)
  );
}

/**
 * Tag a Convex function export with a {@link RouteMode}. Almost always
 * called through the higher-level builders (`localOnly()`,
 * `remoteOnly()`) rather than directly. The mark is non-enumerable and
 * non-configurable so it survives normal property iteration without
 * appearing in `Object.keys` or being accidentally overwritten.
 *
 * @throws when `value` is not a taggable object/function (e.g. a
 *   primitive). This catches mistakes like
 *   `markRoute("string-not-a-function", "local")`.
 *
 * @public
 */
export function markRoute<T>(value: T, mode: RouteMode): T {
  if (!isTaggable(value)) {
    throw new Error(
      "route.*() expects a Convex function export (query/mutation/action)",
    );
  }

  Object.defineProperty(value, ROUTE, {
    value: ROUTE_META[mode],
    enumerable: false,
    configurable: false,
  });

  return value;
}

/**
 * Read the {@link RouteMode} attached to a value, or `null` when the
 * value carries no route annotation. Use this when you have the live
 * function reference; for refName-based lookups the runtime consults
 * the manifest's `routeModes` map instead.
 *
 * @public
 */
export function getRouteMode(value: unknown): RouteMode | null {
  if (!isTaggable(value)) return null;
  const meta = (value as any)[ROUTE] as RouteMeta | undefined;
  return meta?.__brand === "convex-embedded:route" ? meta.mode : null;
}

/**
 * Whether a value was wrapped in `remoteOnly()`. The httpAction
 * dispatcher and cron runner consult this to skip handlers that must
 * not execute locally.
 *
 * @public
 */
export function isRemoteOnly(value: unknown): boolean {
  return getRouteMode(value) === "remote";
}

/**
 * Whether a value was wrapped in `localOnly()`. Symmetric with
 * {@link isRemoteOnly}; useful for tools that want to introspect
 * function classification.
 *
 * @public
 */
export function isLocalOnly(value: unknown): boolean {
  return getRouteMode(value) === "local";
}

/**
 * Format a `componentPath`/`udfPath` pair as a human-readable label
 * suitable for error messages and trace attributes (e.g.
 * `"embedded/messages:send"` for component refs, `"messages:send"`
 * for direct calls).
 *
 * @internal
 */
export function componentRouteTargetLabel(path: {
  componentPath: string;
  udfPath: string;
}): string {
  return path.componentPath.length > 0
    ? `${path.componentPath}/${path.udfPath}`
    : path.udfPath;
}
