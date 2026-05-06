import { InteractionManager } from "react-native";

import { type WorkPriority, type WorkScheduler } from "@/shared/work";

export function createExpoWorkScheduler(): WorkScheduler {
  let lastYieldMs = nowMs();
  const FRAME_BUDGET_MS = 5;

  const post = (priority: WorkPriority, work: () => void): void => {
    switch (priority) {
      case "user-blocking":
        queueMicrotask(work);
        return;
      case "user-visible":
        setTimeout(work, 0);
        return;
      case "background":
        InteractionManager.runAfterInteractions(work);
        return;
    }
  };

  return {
    post,
    yield(): Promise<void> {
      lastYieldMs = nowMs();
      return new Promise((resolve) => setTimeout(resolve, 0));
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
