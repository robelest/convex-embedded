import {
  createSchedulerExecutor,
  type SchedulerExecutorOptions,
} from "@embedded/scheduler/executor";
import { withFakeTimers } from "@tests/helpers/time";
import { describe, expect, it, vi } from "@tests/testkit";

type RunFunction = SchedulerExecutorOptions["runFunction"];

describe("SchedulerExecutor", () => {
  it("returns a deterministic first job ID", ({ db }) => {
    const runFunction = vi.fn<RunFunction>().mockResolvedValue(undefined);
    const scheduler = createSchedulerExecutor({ db, runFunction });

    const id = scheduler.schedule("tasks:run", {}, 1000);

    expect(id).toBe("job_1");
  });

  it("hands out unique sequential IDs across schedules", ({ db }) => {
    const runFunction = vi.fn<RunFunction>().mockResolvedValue(undefined);
    const scheduler = createSchedulerExecutor({ db, runFunction });

    const id1 = scheduler.schedule("a:run", {}, 100);
    const id2 = scheduler.schedule("b:run", {}, 200);
    const id3 = scheduler.schedule("c:run", {}, 300);

    expect([id1, id2, id3]).toEqual(["job_1", "job_2", "job_3"]);

    scheduler.shutdown();
  });

  it("runs the scheduled function once its delay elapses", async ({ db }) => {
    await withFakeTimers(async () => {
      const runFunction = vi.fn<RunFunction>().mockResolvedValue(undefined);
      const scheduler = createSchedulerExecutor({ db, runFunction });

      scheduler.schedule("messages:send", { body: "hi" }, 1000);
      expect(runFunction).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);

      expect(runFunction).toHaveBeenCalledWith("messages:send", { body: "hi" });
    });
  });

  it("runs a zero-delay function on the next tick", async ({ db }) => {
    await withFakeTimers(async () => {
      const runFunction = vi.fn<RunFunction>().mockResolvedValue(undefined);
      const scheduler = createSchedulerExecutor({ db, runFunction });

      scheduler.schedule("instant:run", { fast: true }, 0);
      await vi.advanceTimersByTimeAsync(0);

      expect(runFunction).toHaveBeenCalledWith("instant:run", { fast: true });
    });
  });

  it("does not run a job cancelled before its delay elapses", async ({
    db,
  }) => {
    await withFakeTimers(async () => {
      const runFunction = vi.fn<RunFunction>().mockResolvedValue(undefined);
      const scheduler = createSchedulerExecutor({ db, runFunction });

      const jobId = scheduler.schedule("tasks:cancel", {}, 5000);
      scheduler.cancelJob(jobId);

      await vi.advanceTimersByTimeAsync(10000);

      expect(runFunction).not.toHaveBeenCalled();
    });
  });

  it("ignores cancellation of an unknown job ID", ({ db }) => {
    const runFunction = vi.fn<RunFunction>().mockResolvedValue(undefined);
    const scheduler = createSchedulerExecutor({ db, runFunction });

    expect(() => scheduler.cancelJob("job_999")).not.toThrow();
  });

  it("clears all pending jobs on shutdown", async ({ db }) => {
    await withFakeTimers(async () => {
      const runFunction = vi.fn<RunFunction>().mockResolvedValue(undefined);
      const scheduler = createSchedulerExecutor({ db, runFunction });

      scheduler.schedule("a:run", {}, 1000);
      scheduler.schedule("b:run", {}, 2000);
      scheduler.schedule("c:run", {}, 3000);
      scheduler.shutdown();

      await vi.advanceTimersByTimeAsync(5000);

      expect(runFunction).not.toHaveBeenCalled();
    });
  });

  it("catches and logs an error thrown by the scheduled function", async ({
    db,
  }) => {
    await withFakeTimers(async () => {
      const error = new Error("boom");
      const runFunction = vi.fn<RunFunction>().mockRejectedValue(error);
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const scheduler = createSchedulerExecutor({ db, runFunction });

      scheduler.schedule("failing:task", { x: 1 }, 500);
      await vi.advanceTimersByTimeAsync(500);

      expect(consoleSpy).toHaveBeenCalledWith(
        '[convex-embedded:scheduler] Scheduled function "failing:task" failed:',
        error,
      );
    });
  });
});
