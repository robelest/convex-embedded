import * as pull from "@/client/engine/pull";
import type { MergeState } from "@/client/engine/pull";
import type { PendingQueue } from "@/client/pending/queue";
import { createLogger } from "@/shared/logger";
import type { EngineStatus } from "@/shared/types";
import { recordCounter } from "@/tracing/metrics";
import { runDetached } from "@/utils/detached";

const log = createLogger("resolve");

export interface SchedulerRefs {
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
  mergeState: MergeState;
  isStarted: () => boolean;
  heartbeatMs: number;
  heartbeat: () => Promise<void>;
}

export interface Scheduler {
  run(options?: { forcePull?: boolean }): Promise<void>;
  currentSignal(): AbortSignal | undefined;
  abortCurrent(): void;
  isOnline(): boolean;
  markOffline(): void;
  handleOnline(): void;
  handleOffline(): void;
  startHeartbeat(): void;
  stopHeartbeat(): void;
}

export type StartLifecycleRoute =
  | { _tag: "Offline" }
  | { _tag: "WaitForHydrationThenOnline" };

export function getStartLifecycleRoute(input: {
  hasNavigator: boolean;
  navigatorOnline: boolean | undefined;
}): StartLifecycleRoute {
  return input.hasNavigator && input.navigatorOnline === false
    ? { _tag: "Offline" }
    : { _tag: "WaitForHydrationThenOnline" };
}

type Route =
  | { _tag: "Skip" }
  | { _tag: "DeferUntilQueueDrains" }
  | { _tag: "Pull" };

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

export function createScheduler(refs: SchedulerRefs): Scheduler {
  const {
    processUploadQueue,
    processQueue,
    rollbackDeadLetteredTables,
    mergeDirtyCrdtRows,
    pullAll,
    stopRemoteSubscriptions,
    startRemoteSubscriptions,
    clearBufferedSnapshots,
    emit,
    pendingQueue,
    mergeState,
    isStarted,
    heartbeatMs,
    heartbeat,
  } = refs;

  let inFlight: Promise<void> | null = null;
  let abort: AbortController | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let online = false;
  let offlineTransitions = 0;
  let cameOnlineAfterOffline = false;

  function currentSignal(): AbortSignal | undefined {
    return abort?.signal;
  }

  function abortCurrent(): void {
    abort?.abort();
    abort = null;
  }

  function isOnlineImpl(): boolean {
    return online;
  }

  function markOnline(): void {
    if (cameOnlineAfterOffline) {
      offlineTransitions += 1;
      cameOnlineAfterOffline = false;
    }
    online = true;
  }

  function markOffline(): void {
    if (online) {
      cameOnlineAfterOffline = true;
    }
    online = false;
  }

  function run(options?: { forcePull?: boolean }): Promise<void> {
    if (inFlight) {
      if (options?.forcePull) {
        return inFlight.then(() => run(options));
      }
      return inFlight;
    }

    abortCurrent();
    const controller = new AbortController();
    abort = controller;
    const signal = controller.signal;

    const next = (async () => {
      try {
        await processUploadQueue(signal);
        const deadLettered = await processQueue(signal);
        await rollbackDeadLetteredTables(deadLettered, signal);

        const route = getRoute({
          aborted: signal.aborted,
          forcePull: options?.forcePull ?? false,
          hasPending: !pendingQueue.isEmpty,
          isOnline: online,
          started: isStarted(),
          offlineTransitionsSinceBoot: offlineTransitions,
          hasDirtyCrdtRows: pull.hasDirty(mergeState),
        });

        if (route._tag === "Skip") {
          if (online && isStarted() && !signal.aborted) {
            emit({ status: "resolved" });
          }
        } else if (route._tag === "DeferUntilQueueDrains") {
          stopRemoteSubscriptions();
          log.warn(
            "sync: deferring pull and remote subscriptions until pending queue drains",
          );
        } else if (route._tag === "Pull") {
          if (
            !options?.forcePull &&
            pull.hasDirty(mergeState) &&
            offlineTransitions > 0
          ) {
            await mergeDirtyCrdtRows(signal);
          } else {
            await pullAll(signal);
            if (!signal.aborted) {
              pull.clearAllDirty(mergeState);
            }
          }
        }

        if (
          shouldStartRemoteSubscriptions({
            aborted: signal.aborted,
            forcePull: options?.forcePull ?? false,
            hasPending: !pendingQueue.isEmpty,
            isOnline: online,
            started: isStarted(),
          })
        ) {
          startRemoteSubscriptions();
        }
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          log.error("sync: replication pass failed", err);
        }
      }
    })().finally(() => {
      inFlight = null;
      if (abort?.signal === signal) {
        abort = null;
      }
    });

    inFlight = next;
    return next;
  }

  function handleOnline(): void {
    log.info("sync: online event — flushing queue, resolving, subscribing");
    markOnline();
    recordCounter("connectivity.transition", { state: "online" });
    runDetached(() => run(), "[sync] handleOnline:");
  }

  function handleOffline(): void {
    log.info("sync: offline event");
    markOffline();
    recordCounter("connectivity.transition", { state: "offline" });
    abortCurrent();
    stopRemoteSubscriptions();
    clearBufferedSnapshots();
    emit({ status: "offline" });
  }

  function startHeartbeat(): void {
    const safeBeat = async (): Promise<void> => {
      try {
        await heartbeat();
      } catch (err) {
        log.debug("sync: processor heartbeat failed", err);
      }
    };
    runDetached(safeBeat, "[sync] processor heartbeat:");
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
    }
    heartbeatTimer = setInterval(() => {
      runDetached(safeBeat, "[sync] processor heartbeat:");
    }, heartbeatMs);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  return {
    run,
    currentSignal,
    abortCurrent,
    isOnline: isOnlineImpl,
    markOffline,
    handleOnline,
    handleOffline,
    startHeartbeat,
    stopHeartbeat,
  };
}
