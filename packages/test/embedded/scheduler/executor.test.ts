import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vite-plus/test";

import { SchedulerExecutor } from "#embedded/scheduler/executor";

describe("SchedulerExecutor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedule: returns a unique job ID", () => {
    const runFunction = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerExecutor({ db: {}, runFunction });

    const id = scheduler.schedule("tasks:run", {}, 1000);

    expect(id).toBe("job_1");
  });

  it("schedule executes after delay", async () => {
    const runFunction = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerExecutor({ db: {}, runFunction });

    scheduler.schedule("messages:send", { body: "hi" }, 1000);

    expect(runFunction).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    await vi.waitFor(() => {
      expect(runFunction).toHaveBeenCalledWith("messages:send", {
        body: "hi",
      });
    });
  });

  it("schedule with zero delay: executes on next tick", async () => {
    const runFunction = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerExecutor({ db: {}, runFunction });

    scheduler.schedule("instant:run", { fast: true }, 0);

    vi.advanceTimersByTime(0);

    await vi.waitFor(() => {
      expect(runFunction).toHaveBeenCalledWith("instant:run", { fast: true });
    });
  });

  it("cancelJob: prevents execution", async () => {
    const runFunction = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerExecutor({ db: {}, runFunction });

    const jobId = scheduler.schedule("tasks:cancel", {}, 5000);
    scheduler.cancelJob(jobId);

    vi.advanceTimersByTime(10000);
    // Give any pending promises a chance to resolve
    await vi.advanceTimersByTimeAsync(0);

    expect(runFunction).not.toHaveBeenCalled();
  });

  it("cancelJob non-existent: does not throw", () => {
    const runFunction = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerExecutor({ db: {}, runFunction });

    expect(() => scheduler.cancelJob("job_999")).not.toThrow();
  });

  it("shutdown: clears all pending jobs", async () => {
    const runFunction = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerExecutor({ db: {}, runFunction });

    scheduler.schedule("a:run", {}, 1000);
    scheduler.schedule("b:run", {}, 2000);
    scheduler.schedule("c:run", {}, 3000);

    scheduler.shutdown();

    vi.advanceTimersByTime(5000);
    await vi.advanceTimersByTimeAsync(0);

    expect(runFunction).not.toHaveBeenCalled();
  });

  it("schedule error handling: errors are caught and logged", async () => {
    const error = new Error("boom");
    const runFunction = vi.fn().mockRejectedValue(error);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new SchedulerExecutor({ db: {}, runFunction });

    scheduler.schedule("failing:task", { x: 1 }, 500);

    vi.advanceTimersByTime(500);

    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        '[SchedulerExecutor] Scheduled function "failing:task" failed:',
        error,
      );
    });

    consoleSpy.mockRestore();
  });

  it("multiple schedules: each gets unique IDs", () => {
    const runFunction = vi.fn().mockResolvedValue(undefined);
    const scheduler = new SchedulerExecutor({ db: {}, runFunction });

    const id1 = scheduler.schedule("a:run", {}, 100);
    const id2 = scheduler.schedule("b:run", {}, 200);
    const id3 = scheduler.schedule("c:run", {}, 300);

    expect(id1).toBe("job_1");
    expect(id2).toBe("job_2");
    expect(id3).toBe("job_3");
    expect(new Set([id1, id2, id3]).size).toBe(3);

    // cleanup
    scheduler.shutdown();
  });
});
