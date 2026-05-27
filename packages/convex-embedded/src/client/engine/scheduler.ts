import type { CrdtDirtyState } from "@/client/engine/crdt";
import type { PendingQueue } from "@/client/pending/queue";
import { createLogger } from "@/shared/logger";
import type { EngineStatus } from "@/shared/types";
import { recordCounter } from "@/tracing/metrics";
import { runDetached } from "@/utils/detached";

const log = createLogger("resolve");

export interface SchedulerState {
  inFlight: Promise<void> | null;
  abort: AbortController | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  online: boolean;
  offlineTransitions: number;
  cameOnlineAfterOffline: boolean;
}

export interface SchedulerDeps {
  processUploadQueue: (signal: AbortSignal) => Promise<void>;
  processQueue: (signal: AbortSignal) => Promise<Set<string>>;
  rollbackDeadLetteredTables: (
    deadLettered: Set<string>,
    signal?: AbortSignal,
  ) => Promise<void>;
  mergeDirtyCrdtRows: (signal?: AbortSignal) => Promise<void>;
  pullAll: (signal?: AbortSignal) => Promise<void>;
  stopRemoteSubscriptions: () => void;
  startRemoteSubscriptions: () => void;
  clearBufferedSnapshots: () => void;
  emit: (status: EngineStatus) => void;
  pendingQueue: PendingQueue;
  crdt: CrdtDirtyState;
  isStarted: () => boolean;
  heartbeatMs: number;
  heartbeat: () => Promise<void>;
}

export function createSchedulerState(): SchedulerState {
  return {
    inFlight: null,
    abort: null,
    heartbeatTimer: null,
    online: false,
    offlineTransitions: 0,
    cameOnlineAfterOffline: false,
  };
}

export function currentSignal(state: SchedulerState): AbortSignal | undefined {
  return state.abort?.signal;
}

export function abortCurrent(state: SchedulerState): void {
  state.abort?.abort();
  state.abort = null;
}

export function isOnline(state: SchedulerState): boolean {
  return state.online;
}

export function offlineTransitionsSinceBoot(state: SchedulerState): number {
  return state.offlineTransitions;
}

export function markOnline(state: SchedulerState): boolean {
  const wasReconnect = state.cameOnlineAfterOffline;
  if (wasReconnect) {
    state.offlineTransitions += 1;
    state.cameOnlineAfterOffline = false;
  }
  state.online = true;
  return wasReconnect;
}

export function markOffline(state: SchedulerState): void {
  if (state.online) {
    state.cameOnlineAfterOffline = true;
  }
  state.online = false;
}

type Route =
  | { _tag: "Skip" }
  | { _tag: "DeferUntilQueueDrains" }
  | { _tag: "Pull" };

export type StartLifecycleRoute =
  | { _tag: "Offline" }
  | { _tag: "WaitForHydrationThenOnline" };

function getRoute(input: {
  aborted: boolean;
  forcePull: boolean;
  hasPending: boolean;
  isOnline: boolean;
  started: boolean;
  offlineTransitionsSinceBoot: number;
  hasDirtyCrdtRows: boolean;
}): Route {
  if (input.aborted) return { _tag: "Skip" };
  if (!input.forcePull && (!input.started || !input.isOnline)) {
    return { _tag: "Skip" };
  }
  if (input.hasPending) {
    return { _tag: "DeferUntilQueueDrains" };
  }
  if (
    !input.forcePull &&
    input.offlineTransitionsSinceBoot === 0 &&
    !input.hasDirtyCrdtRows
  ) {
    return { _tag: "Skip" };
  }
  return { _tag: "Pull" };
}

function shouldStartRemoteSubscriptions(input: {
  aborted: boolean;
  forcePull: boolean;
  hasPending: boolean;
  isOnline: boolean;
  started: boolean;
}): boolean {
  return (
    !input.aborted &&
    input.started &&
    input.isOnline &&
    !input.hasPending &&
    !input.forcePull
  );
}

export function getStartLifecycleRoute(input: {
  hasNavigator: boolean;
  navigatorOnline: boolean | undefined;
}): StartLifecycleRoute {
  return input.hasNavigator && input.navigatorOnline === false
    ? { _tag: "Offline" }
    : { _tag: "WaitForHydrationThenOnline" };
}

export function run(
  state: SchedulerState,
  deps: SchedulerDeps,
  options?: { forcePull?: boolean },
): Promise<void> {
  if (state.inFlight) {
    if (options?.forcePull) {
      return state.inFlight.then(() => run(state, deps, options));
    }
    return state.inFlight;
  }

  abortCurrent(state);
  const controller = new AbortController();
  state.abort = controller;
  const signal = controller.signal;

  const inFlight = (async () => {
    try {
      await deps.processUploadQueue(signal);
      const deadLettered = await deps.processQueue(signal);
      await deps.rollbackDeadLetteredTables(deadLettered, signal);

      const route = getRoute({
        aborted: signal.aborted,
        forcePull: options?.forcePull ?? false,
        hasPending: !deps.pendingQueue.isEmpty,
        isOnline: state.online,
        started: deps.isStarted(),
        offlineTransitionsSinceBoot: state.offlineTransitions,
        hasDirtyCrdtRows: deps.crdt.hasDirty(),
      });

      if (route._tag === "Skip") {
        if (state.online && deps.isStarted() && !signal.aborted) {
          deps.emit({ status: "resolved" });
        }
      } else if (route._tag === "DeferUntilQueueDrains") {
        deps.stopRemoteSubscriptions();
        log.warn(
          "sync: deferring pull and remote subscriptions until pending queue drains",
        );
      } else if (route._tag === "Pull") {
        if (
          !options?.forcePull &&
          deps.crdt.hasDirty() &&
          state.offlineTransitions > 0
        ) {
          await deps.mergeDirtyCrdtRows(signal);
        } else {
          await deps.pullAll(signal);
          if (!signal.aborted) {
            deps.crdt.clearAll();
          }
        }
      }

      if (
        shouldStartRemoteSubscriptions({
          aborted: signal.aborted,
          forcePull: options?.forcePull ?? false,
          hasPending: !deps.pendingQueue.isEmpty,
          isOnline: state.online,
          started: deps.isStarted(),
        })
      ) {
        deps.startRemoteSubscriptions();
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        log.error("sync: replication pass failed", err);
      }
    }
  })().finally(() => {
    state.inFlight = null;
    if (state.abort?.signal === signal) {
      state.abort = null;
    }
  });

  state.inFlight = inFlight;
  return inFlight;
}

export function handleOnline(state: SchedulerState, deps: SchedulerDeps): void {
  log.info("sync: online event — flushing queue, resolving, subscribing");
  markOnline(state);
  recordCounter("connectivity.transition", { state: "online" });
  runDetached(() => run(state, deps), "[sync] handleOnline:");
}

export function handleOffline(
  state: SchedulerState,
  deps: SchedulerDeps,
): void {
  log.info("sync: offline event");
  markOffline(state);
  recordCounter("connectivity.transition", { state: "offline" });
  abortCurrent(state);
  deps.stopRemoteSubscriptions();
  deps.clearBufferedSnapshots();
  deps.emit({ status: "offline" });
}

export function startHeartbeat(
  state: SchedulerState,
  deps: SchedulerDeps,
): void {
  const safeBeat = async (): Promise<void> => {
    try {
      await deps.heartbeat();
    } catch (err) {
      log.debug("sync: processor heartbeat failed", err);
    }
  };
  runDetached(safeBeat, "[sync] processor heartbeat:");
  if (state.heartbeatTimer !== null) {
    clearInterval(state.heartbeatTimer);
  }
  state.heartbeatTimer = setInterval(() => {
    runDetached(safeBeat, "[sync] processor heartbeat:");
  }, deps.heartbeatMs);
}

export function stopHeartbeat(state: SchedulerState): void {
  if (state.heartbeatTimer !== null) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}
