import {
  CronRunner,
  type CronJobDefinition,
} from "@embedded/scheduler/cron-runner";
import { afterEach, beforeEach, describe, expect, it } from "@tests/testkit";
import { vi } from "vitest";

describe("CronRunner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires an interval cron repeatedly at the configured period", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const job: CronJobDefinition = {
      name: "tick",
      functionName: "ticks:run",
      type: "mutation",
      args: { source: "test" },
      schedule: { type: "interval", seconds: 30 },
    };
    const runner = new CronRunner({
      jobs: [job],
      runFunction: async (_type, name, args) => {
        calls.push({ name, args });
      },
    });

    runner.start();

    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(3);

    expect(calls[0]?.name).toBe("ticks:run");
    expect(calls[0]?.args).toEqual({ source: "test" });

    runner.shutdown();
  });

  it("dispatches actions vs mutations based on declared type", async () => {
    const types: string[] = [];
    const runner = new CronRunner({
      jobs: [
        {
          name: "m",
          functionName: "tasks:write",
          type: "mutation",
          args: {},
          schedule: { type: "interval", seconds: 60 },
        },
        {
          name: "a",
          functionName: "tasks:fetch",
          type: "action",
          args: {},
          schedule: { type: "interval", seconds: 60 },
        },
      ],
      runFunction: async (type) => {
        types.push(type);
      },
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(types.sort()).toEqual(["action", "mutation"]);
    runner.shutdown();
  });

  it("continues firing after a handler throws", async () => {
    let callCount = 0;
    const runner = new CronRunner({
      jobs: [
        {
          name: "flaky",
          functionName: "flaky:run",
          type: "mutation",
          args: {},
          schedule: { type: "interval", seconds: 10 },
        },
      ],
      runFunction: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("boom");
      },
    });

    runner.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(callCount).toBe(2);
    runner.shutdown();
  });

  it("shutdown cancels pending timers", async () => {
    let callCount = 0;
    const runner = new CronRunner({
      jobs: [
        {
          name: "noop",
          functionName: "noop:run",
          type: "mutation",
          args: {},
          schedule: { type: "interval", seconds: 5 },
        },
      ],
      runFunction: async () => {
        callCount += 1;
      },
    });

    runner.start();
    runner.shutdown();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callCount).toBe(0);
  });

  it("schedules absolute-time crons against the supplied clock", async () => {
    let mockNow = Date.parse("2026-05-06T08:00:00Z");
    const runner = new CronRunner({
      jobs: [
        {
          name: "daily",
          functionName: "noon:run",
          type: "mutation",
          args: {},
          schedule: { type: "daily", hourUTC: 12, minuteUTC: 0 },
        },
      ],
      runFunction: async () => {},
      now: () => mockNow,
    });

    runner.start();
    expect(runner.getNextFireMs("daily")).toBe(
      Date.parse("2026-05-06T12:00:00Z"),
    );

    runner.shutdown();
    mockNow = Date.parse("2026-05-06T13:00:00Z");
    runner.start();
    expect(runner.getNextFireMs("daily")).toBe(
      Date.parse("2026-05-07T12:00:00Z"),
    );
    runner.shutdown();
  });
});
