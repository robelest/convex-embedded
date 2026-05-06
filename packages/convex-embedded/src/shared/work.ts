export type WorkPriority = "user-blocking" | "user-visible" | "background";

export interface WorkScheduler {
  post(priority: WorkPriority, work: () => void): void;
  yield(): Promise<void>;
  shouldYield(): boolean;
}

const microtask = (work: () => void): void => {
  queueMicrotask(work);
};

const macrotask: (work: () => void) => void =
  typeof globalThis !== "undefined" && typeof MessageChannel === "function"
    ? (() => {
        const channel = new MessageChannel();
        const queue: Array<() => void> = [];
        channel.port1.onmessage = () => {
          const next = queue.shift();
          if (next) next();
        };
        return (work: () => void) => {
          queue.push(work);
          channel.port2.postMessage(null);
        };
      })()
    : (work: () => void) => {
        setTimeout(work, 0);
      };

const idle: (work: () => void) => void =
  typeof globalThis !== "undefined" &&
  typeof (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback ===
    "function"
    ? (work) => {
        (
          globalThis as {
            requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void;
          }
        ).requestIdleCallback(work, { timeout: 100 });
      }
    : macrotask;

export function createDefaultWorkScheduler(): WorkScheduler {
  let lastYieldMs =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const FRAME_BUDGET_MS = 5;
  return {
    post(priority, work) {
      switch (priority) {
        case "user-blocking":
          microtask(work);
          return;
        case "user-visible":
          macrotask(work);
          return;
        case "background":
          idle(work);
          return;
      }
    },
    yield(): Promise<void> {
      lastYieldMs =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      return new Promise((resolve) => macrotask(resolve));
    },
    shouldYield(): boolean {
      const now =
        typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now();
      if (now - lastYieldMs >= FRAME_BUDGET_MS) {
        return true;
      }
      return false;
    },
  };
}

let active: WorkScheduler = createDefaultWorkScheduler();

export function getWorkScheduler(): WorkScheduler {
  return active;
}

export function setWorkScheduler(scheduler: WorkScheduler | null): void {
  active = scheduler ?? createDefaultWorkScheduler();
}
