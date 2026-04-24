import { ConvexError } from "convex/values";

import type { FunctionPath } from "@/kernel/modules";
import {
  isConnectivityOffline,
  type ConnectivityAdapter,
} from "@/runtime/platform";
import {
  componentRouteTargetLabel,
  type RemoteRouteReason,
  type RouteMode,
} from "@/shared/route";

export type MutationPlan =
  | { kind: "local"; enqueueForReplay: boolean }
  | { kind: "remote"; refName: string; cause: RemoteRouteReason }
  | { kind: "error"; error: Error };

export type ReadPlan =
  | { kind: "local" }
  | { kind: "remote"; refName: string; cause: RemoteRouteReason }
  | { kind: "error"; error: Error };

function getRemoteCause(
  routeMode: RouteMode | null,
  path: FunctionPath | null,
): RemoteRouteReason | null {
  if (path && path.componentPath.length > 0) {
    return "component-routed";
  }
  if (routeMode === "remote") {
    return "remote-routed";
  }
  return null;
}

function getTargetLabel(refName: string, refPath: FunctionPath | null): string {
  return refName.length > 0
    ? refName
    : refPath
      ? componentRouteTargetLabel(refPath)
      : refName;
}

export function planMutationExecution(input: {
  refName: string;
  refPath: FunctionPath | null;
  routeMode: RouteMode | null;
}): MutationPlan {
  const { refName, refPath, routeMode } = input;

  if (routeMode === "local" && refPath && refPath.componentPath.length > 0) {
    const target = componentRouteTargetLabel(refPath);
    return {
      kind: "error",
      error: new ConvexError({
        code: "ROUTE_LOCAL_UNSUPPORTED",
        message:
          `[convex-embedded] Function "${target}" is marked localOnly() but cannot run locally in alpha. ` +
          "Move the boundary remote or remove localOnly().",
        componentPath: refPath.componentPath,
        udfPath: refPath.udfPath,
        target,
      }),
    };
  }

  const cause = getRemoteCause(routeMode, refPath);
  if (cause !== null) {
    return {
      kind: "remote",
      refName: getTargetLabel(refName, refPath),
      cause,
    };
  }

  return {
    kind: "local",
    enqueueForReplay: routeMode !== "local",
  };
}

export function planReadExecution(input: {
  refName: string;
  refPath: FunctionPath | null;
  routeMode: RouteMode | null;
}): ReadPlan {
  const { refName, refPath, routeMode } = input;

  if (routeMode === "local" && refPath && refPath.componentPath.length > 0) {
    const target = componentRouteTargetLabel(refPath);
    return {
      kind: "error",
      error: new ConvexError({
        code: "ROUTE_LOCAL_UNSUPPORTED",
        message:
          `[convex-embedded] Function "${target}" is marked localOnly() but cannot run locally in alpha. ` +
          "Move the boundary remote or remove localOnly().",
        componentPath: refPath.componentPath,
        udfPath: refPath.udfPath,
        target,
      }),
    };
  }

  const cause = getRemoteCause(routeMode, refPath);
  if (cause !== null) {
    return {
      kind: "remote",
      refName: getTargetLabel(refName, refPath),
      cause,
    };
  }

  return { kind: "local" };
}

export function assertRemotePlanOnline(
  plan: {
    refName: string;
    cause: RemoteRouteReason;
  },
  connectivity?: ConnectivityAdapter,
): void {
  if (isConnectivityOffline(connectivity)) {
    const refName = plan.refName.length > 0 ? plan.refName : "<unknown>";
    throw new ConvexError({
      code: "ROUTE_REMOTE_OFFLINE",
      message: `[convex-embedded] ${plan.cause} function "${refName}" cannot run while offline.`,
      refName,
      reason: plan.cause,
    });
  }
}
