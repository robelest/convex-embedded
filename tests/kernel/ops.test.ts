import { OpsContext, createOpsContext } from "@embedded/kernel/ops";
import { installInMemoryTracing } from "@embedded/tracing/memory";
import { withFakeTimers } from "@tests/helpers/time";
import { describe, expect, it, vi } from "@tests/testkit";

describe.concurrent("OpsContext.random", () => {
  it("produces the same sequence for the same seed", () => {
    const a = new OpsContext(42, 1000);
    const b = new OpsContext(42, 1000);

    const seqA = Array.from({ length: 10 }, () => a.random());
    const seqB = Array.from({ length: 10 }, () => b.random());

    expect(seqA).toEqual(seqB);
  });

  it("produces different sequences for different seeds", () => {
    const a = new OpsContext(42, 1000);
    const b = new OpsContext(99, 1000);

    const seqA = Array.from({ length: 10 }, () => a.random());
    const seqB = Array.from({ length: 10 }, () => b.random());

    expect(seqA).not.toEqual(seqB);
  });

  it("returns values in [0, 1)", () => {
    const ctx = new OpsContext(123, 1000);

    for (let i = 0; i < 1000; i += 1) {
      const value = ctx.random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe.concurrent("OpsContext.now", () => {
  it("always returns the timestamp passed to the constructor", () => {
    const ts = 1700000000000;
    const ctx = new OpsContext(1, ts);

    expect(ctx.now()).toBe(ts);
    expect(ctx.now()).toBe(ts);
    expect(ctx.now()).toBe(ts);
  });

  it("returns the timestamp it was constructed with", () => {
    const ctx1 = new OpsContext(1, 1000);
    const ctx2 = new OpsContext(1, 2000);

    expect(ctx1.now()).toBe(1000);
    expect(ctx2.now()).toBe(2000);
  });
});

describe.concurrent("OpsContext.randomUUID", () => {
  it("produces the same UUID for the same seed", () => {
    const a = new OpsContext(42, 1000);
    const b = new OpsContext(42, 1000);

    expect(a.randomUUID()).toBe(b.randomUUID());
  });

  it("matches the UUID v4 format", () => {
    const ctx = new OpsContext(77, 1000);

    for (let i = 0; i < 20; i += 1) {
      expect(ctx.randomUUID()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it("produces a unique UUID on each successive call", () => {
    const ctx = new OpsContext(42, 1000);

    const uuids = Array.from({ length: 50 }, () => ctx.randomUUID());

    expect(new Set(uuids).size).toBe(uuids.length);
  });
});

describe("OpsContext console capture", () => {
  it("emits console.* calls as OTel log records tagged source=udf", async () => {
    const handle = installInMemoryTracing();
    try {
      const ctx = new OpsContext(1, 5000);

      ctx.console.log("hello");
      ctx.console.warn("warning!");
      ctx.console.error("err", 42);
      ctx.console.info("info");
      ctx.console.debug("dbg", { a: 1 });

      const udfLogs = handle
        .getLogs()
        .filter((entry) => entry.attributes.source === "udf");

      expect(udfLogs.map((entry) => entry.severity)).toEqual([
        "log",
        "warn",
        "error",
        "info",
        "debug",
      ]);
      expect(udfLogs.map((entry) => entry.body)).toEqual([
        "hello",
        "warning!",
        "err 42",
        "info",
        'dbg {"a":1}',
      ]);
    } finally {
      await handle.close();
    }
  });
});

describe("createOpsContext", () => {
  it("uses Date.now() as the default timestamp", async () => {
    await withFakeTimers(() => {
      const fakeNow = 1700000000000;
      vi.setSystemTime(fakeNow);

      const ctx = createOpsContext();

      expect(ctx.now()).toBe(fakeNow);
    });
  });

  it("uses the provided seed instead of Date.now()", async () => {
    await withFakeTimers(() => {
      vi.setSystemTime(1000);

      const ctxA = createOpsContext(42);
      const ctxB = createOpsContext(42);

      const seqA = Array.from({ length: 5 }, () => ctxA.random());
      const seqB = Array.from({ length: 5 }, () => ctxB.random());

      expect(seqA).toEqual(seqB);
    });
  });

  it("returns an OpsContext instance", async () => {
    await withFakeTimers(() => {
      expect(createOpsContext(1)).toBeInstanceOf(OpsContext);
    });
  });
});
