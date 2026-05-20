import { ModuleLoader } from "@embedded/kernel/modules";
import { discoverCronJobs } from "@embedded/scheduler/cron/discover";
import { remoteOnly } from "@embedded/server/markers";
import { describe, expect, it } from "@tests/testkit";

function makeLoader(modules: Record<string, () => Promise<unknown>>) {
  return new ModuleLoader(modules);
}

describe("scheduler/cron-discover", () => {
  it("returns [] when no crons module is registered", async () => {
    const loader = makeLoader({
      messages: () => Promise.resolve({}),
    });
    expect(await discoverCronJobs(loader)).toEqual([]);
  });

  it("returns [] when crons module has no Crons default export", async () => {
    const loader = makeLoader({
      crons: () => Promise.resolve({ default: { something: "else" } }),
    });
    expect(await discoverCronJobs(loader)).toEqual([]);
  });

  it("materializes interval/daily/cron jobs and resolves mutation/action types", async () => {
    const loader = makeLoader({
      crons: () =>
        Promise.resolve({
          default: {
            isCrons: true,
            crons: {
              tick: {
                name: "ticks:run",
                args: [{ source: "demo" }],
                schedule: { type: "interval", seconds: 30 },
              },
              "morning report": {
                name: "reports:fetch",
                args: [{}],
                schedule: { type: "daily", hourUTC: 9, minuteUTC: 0 },
              },
              "weekday email": {
                name: "emails:send",
                args: [{}],
                schedule: { type: "cron", cron: "0 9 * * 1-5" },
              },
            },
          },
        }),
      ticks: () => Promise.resolve({ run: { isMutation: true } }),
      reports: () => Promise.resolve({ fetch: { isAction: true } }),
      emails: () => Promise.resolve({ send: { isMutation: true } }),
    });

    const jobs = await discoverCronJobs(loader);
    const byName = new Map(jobs.map((j) => [j.name, j]));

    expect(byName.size).toBe(3);
    expect(byName.get("tick")?.type).toBe("mutation");
    expect(byName.get("tick")?.functionName).toBe("ticks:run");
    expect(byName.get("tick")?.args).toEqual({ source: "demo" });

    expect(byName.get("morning report")?.type).toBe("action");
    expect(byName.get("morning report")?.schedule).toEqual({
      type: "daily",
      hourUTC: 9,
      minuteUTC: 0,
    });

    expect(byName.get("weekday email")?.schedule).toEqual({
      type: "cron",
      cron: "0 9 * * 1-5",
    });
  });

  it("skips jobs whose target function is wrapped in remoteOnly()", async () => {
    const loader = makeLoader({
      crons: () =>
        Promise.resolve({
          default: {
            isCrons: true,
            crons: {
              "local cleanup": {
                name: "cleanup:run",
                args: [{}],
                schedule: { type: "interval", minutes: 5 },
              },
              "remote daily email": {
                name: "emails:sendDigest",
                args: [{}],
                schedule: { type: "daily", hourUTC: 9, minuteUTC: 0 },
              },
            },
          },
        }),
      cleanup: () => Promise.resolve({ run: { isMutation: true } }),
      emails: () =>
        Promise.resolve({
          sendDigest: remoteOnly({ isAction: true }),
        }),
    });

    const jobs = await discoverCronJobs(loader);
    expect(jobs.map((j) => j.name)).toEqual(["local cleanup"]);
  });

  it("skips jobs whose target function is missing or invalid type", async () => {
    const loader = makeLoader({
      crons: () =>
        Promise.resolve({
          default: {
            isCrons: true,
            crons: {
              good: {
                name: "ticks:run",
                args: [{}],
                schedule: { type: "interval", minutes: 1 },
              },
              "bad-target": {
                name: "missing:run",
                args: [{}],
                schedule: { type: "interval", minutes: 1 },
              },
              "is-query": {
                name: "queries:read",
                args: [{}],
                schedule: { type: "interval", minutes: 1 },
              },
            },
          },
        }),
      ticks: () => Promise.resolve({ run: { isMutation: true } }),
      queries: () => Promise.resolve({ read: { isQuery: true } }),
    });

    const jobs = await discoverCronJobs(loader);
    expect(jobs.map((j) => j.name)).toEqual(["good"]);
  });
});
