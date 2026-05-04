import { createLogger } from "@/shared/logger";

const detachedLog = createLogger("detached");

export function runDetached(task: () => Promise<unknown>, label: string): void {
  void task().catch((error) => {
    detachedLog.error(label, error);
  });
}
