import { type WorkPriority, type WorkScheduler } from "@/shared/work";

export function createNodeWorkScheduler(): WorkScheduler {
  let lastYieldMs = nowMs();
  const FRAME_BUDGET_MS = 5;

  return {
    post(priority: WorkPriority, work: () => void) {
      switch (priority) {
        case "user-blocking":
          queueMicrotask(work);
          return;
        case "user-visible":
          setImmediate(work);
          return;
        case "background":
          setTimeout(work, 16);
          return;
      }
    },
    yield(): Promise<void> {
      lastYieldMs = nowMs();
      return new Promise((resolve) => setImmediate(resolve));
    },
    shouldYield(): boolean {
      return nowMs() - lastYieldMs >= FRAME_BUDGET_MS;
    },
  };
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
