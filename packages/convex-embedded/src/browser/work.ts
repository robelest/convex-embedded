import {
  createDefaultWorkScheduler,
  type WorkPriority,
  type WorkScheduler,
} from "@/shared/work";

interface SchedulerLike {
  postTask(
    callback: () => void,
    options?: { priority?: WorkPriority; signal?: AbortSignal },
  ): Promise<unknown>;
  yield?: () => Promise<void>;
}

interface InputPendingScheduling {
  isInputPending(opts?: { includeContinuous?: boolean }): boolean;
}

export function createBrowserWorkScheduler(): WorkScheduler {
  const win = globalThis as unknown as {
    scheduler?: SchedulerLike;
    navigator?: { scheduling?: InputPendingScheduling };
  };
  const native = win.scheduler;
  if (!native || typeof native.postTask !== "function") {
    return createDefaultWorkScheduler();
  }
  const inputPending = win.navigator?.scheduling;
  let lastYieldMs = performance.now();
  const FRAME_BUDGET_MS = 5;

  return {
    post(priority: WorkPriority, work: () => void) {
      void native.postTask(work, { priority }).catch(() => undefined);
    },
    yield(): Promise<void> {
      lastYieldMs = performance.now();
      if (typeof native.yield === "function") {
        return native.yield().catch(() => undefined);
      }
      return new Promise((resolve) =>
        native
          .postTask(resolve as () => void, { priority: "user-visible" })
          .catch(() => resolve()),
      );
    },
    shouldYield(): boolean {
      if (
        inputPending &&
        typeof inputPending.isInputPending === "function" &&
        inputPending.isInputPending({ includeContinuous: false })
      ) {
        return true;
      }
      return performance.now() - lastYieldMs >= FRAME_BUDGET_MS;
    },
  };
}
