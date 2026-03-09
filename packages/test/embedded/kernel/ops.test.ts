import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpsContext, createOpsContext } from "#embedded/kernel/ops";

describe("OpsContext", () => {
  // ---------------------------------------------------------------------------
  // Deterministic random
  // ---------------------------------------------------------------------------

  describe("random()", () => {
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

      for (let i = 0; i < 1000; i++) {
        const val = ctx.random();
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThan(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Pinned timestamp
  // ---------------------------------------------------------------------------

  describe("now()", () => {
    it("always returns the timestamp passed to the constructor", () => {
      const ts = 1700000000000;
      const ctx = new OpsContext(1, ts);

      expect(ctx.now()).toBe(ts);
      expect(ctx.now()).toBe(ts);
      expect(ctx.now()).toBe(ts);
    });

    it("returns a different value when constructed with a different timestamp", () => {
      const ctx1 = new OpsContext(1, 1000);
      const ctx2 = new OpsContext(1, 2000);

      expect(ctx1.now()).toBe(1000);
      expect(ctx2.now()).toBe(2000);
    });
  });

  // ---------------------------------------------------------------------------
  // Deterministic UUID
  // ---------------------------------------------------------------------------

  describe("randomUUID()", () => {
    it("produces the same UUID for the same seed", () => {
      const a = new OpsContext(42, 1000);
      const b = new OpsContext(42, 1000);

      expect(a.randomUUID()).toBe(b.randomUUID());
    });

    it("matches the UUID v4 format xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx", () => {
      const ctx = new OpsContext(77, 1000);

      for (let i = 0; i < 20; i++) {
        const uuid = ctx.randomUUID();
        // Full UUID v4 regex: version nibble is 4, variant nibble is [89ab]
        expect(uuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
    });

    it("produces different UUIDs on successive calls (same context)", () => {
      const ctx = new OpsContext(42, 1000);

      const uuids = Array.from({ length: 50 }, () => ctx.randomUUID());
      const unique = new Set(uuids);

      expect(unique.size).toBe(uuids.length);
    });
  });

  // ---------------------------------------------------------------------------
  // Console capture
  // ---------------------------------------------------------------------------

  describe("console / logs", () => {
    it("starts with an empty logs array", () => {
      const ctx = new OpsContext(1, 1000);
      expect(ctx.logs).toEqual([]);
    });

    it("captures log/warn/error/info/debug to .logs", () => {
      const ctx = new OpsContext(1, 5000);

      ctx.console.log("hello");
      ctx.console.warn("warning!");
      ctx.console.error("err", 42);
      ctx.console.info("info");
      ctx.console.debug("dbg", { a: 1 });

      expect(ctx.logs).toHaveLength(5);

      expect(ctx.logs[0]).toEqual({ level: "log", args: ["hello"], timestamp: 5000 });
      expect(ctx.logs[1]).toEqual({ level: "warn", args: ["warning!"], timestamp: 5000 });
      expect(ctx.logs[2]).toEqual({ level: "error", args: ["err", 42], timestamp: 5000 });
      expect(ctx.logs[3]).toEqual({ level: "info", args: ["info"], timestamp: 5000 });
      expect(ctx.logs[4]).toEqual({
        level: "debug",
        args: ["dbg", { a: 1 }],
        timestamp: 5000,
      });
    });

    it("records each entry with the correct level", () => {
      const ctx = new OpsContext(1, 1000);
      const levels = ["log", "warn", "error", "info", "debug"] as const;

      for (const level of levels) {
        ctx.console[level]("test");
      }

      for (let i = 0; i < levels.length; i++) {
        expect(ctx.logs[i]!.level).toBe(levels[i]);
      }
    });

    it("uses the pinned timestamp for all log entries", () => {
      const ts = 9999;
      const ctx = new OpsContext(1, ts);

      ctx.console.log("a");
      ctx.console.warn("b");
      ctx.console.error("c");

      for (const entry of ctx.logs) {
        expect(entry.timestamp).toBe(ts);
      }
    });

    it("captures multiple arguments per call", () => {
      const ctx = new OpsContext(1, 1000);
      ctx.console.log("one", 2, true, null, { x: "y" });

      expect(ctx.logs[0]!.args).toEqual(["one", 2, true, null, { x: "y" }]);
    });
  });
});

// ---------------------------------------------------------------------------
// createOpsContext factory
// ---------------------------------------------------------------------------

describe("createOpsContext", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a context with Date.now() as default seed and timestamp", () => {
    const fakeNow = 1700000000000;
    vi.setSystemTime(fakeNow);

    const ctx = createOpsContext();

    // The pinned timestamp should be Date.now() at construction time
    expect(ctx.now()).toBe(fakeNow);
  });

  it("uses the provided seed instead of Date.now()", () => {
    vi.setSystemTime(1000);

    const ctxA = createOpsContext(42);
    const ctxB = createOpsContext(42);

    // Same explicit seed → same random sequence
    const seqA = Array.from({ length: 5 }, () => ctxA.random());
    const seqB = Array.from({ length: 5 }, () => ctxB.random());
    expect(seqA).toEqual(seqB);
  });

  it("returns an OpsContext instance", () => {
    const ctx = createOpsContext(1);
    expect(ctx).toBeInstanceOf(OpsContext);
  });
});
