export const ROUTE = Symbol.for("convex-embedded:route");

export type RouteMode = "auto" | "local" | "remote";
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

export function getRouteMode(value: unknown): RouteMode | null {
  if (!isTaggable(value)) return null;
  const meta = (value as any)[ROUTE] as RouteMeta | undefined;
  return meta?.__brand === "convex-embedded:route" ? meta.mode : null;
}

export function isRemoteOnly(value: unknown): boolean {
  return getRouteMode(value) === "remote";
}

export function componentRouteTargetLabel(path: {
  componentPath: string;
  udfPath: string;
}): string {
  return path.componentPath.length > 0
    ? `${path.componentPath}/${path.udfPath}`
    : path.udfPath;
}
