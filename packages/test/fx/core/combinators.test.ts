import { afterEach, describe, it, expect, vi } from "vitest";
import { Fx, TimeoutError } from "@robelest/fx";

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

describe("Fx.map", () => {
  it("transforms the success value", async () => {
    expect(await Fx.run(Fx.succeed(21).pipe(Fx.map((x) => x * 2)))).toBe(42);
  });

  it("passes failure through unchanged", async () => {
    const error = new Error("fail");
    await expect(Fx.run(Fx.fail(error).pipe(Fx.map(() => "x")))).rejects.toBe(
      error,
    );
  });

  it("propagates a throwing mapper as a defect", async () => {
    const defect = new Error("mapper boom");
    const fx = Fx.succeed(1).pipe(
      Fx.map(() => {
        throw defect;
      }),
    );
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });
});

// ---------------------------------------------------------------------------
// chain
// ---------------------------------------------------------------------------

describe("Fx.chain", () => {
  it("chains a new Fx from the success value", async () => {
    expect(
      await Fx.run(Fx.succeed(10).pipe(Fx.chain((x) => Fx.succeed(x + 5)))),
    ).toBe(15);
  });

  it("passes upstream failure through without calling f", async () => {
    const spy = vi.fn();
    const error = new Error("upstream");
    const fx = Fx.fail(error).pipe(
      Fx.chain(() => {
        spy();
        return Fx.succeed("unreachable");
      }),
    );
    await expect(Fx.run(fx)).rejects.toBe(error);
    expect(spy).not.toHaveBeenCalled();
  });

  it("propagates chained computation failure", async () => {
    const error = new Error("chained");
    await expect(
      Fx.run(Fx.succeed(1).pipe(Fx.chain(() => Fx.fail(error)))),
    ).rejects.toBe(error);
  });

  it("propagates a throwing chain function as a defect", async () => {
    const defect = new Error("chain boom");
    const fx = Fx.succeed(1).pipe(
      Fx.chain(() => {
        throw defect;
      }),
    );
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });
});

// ---------------------------------------------------------------------------
// tap
// ---------------------------------------------------------------------------

describe("Fx.tap", () => {
  it("runs the side-effect and returns the original value", async () => {
    const log: number[] = [];
    const result = await Fx.run(
      Fx.succeed(42).pipe(Fx.tap((x) => Fx.sync(() => log.push(x)))),
    );
    expect(result).toBe(42);
    expect(log).toEqual([42]);
  });

  it("propagates failure from the side-effect", async () => {
    const error = new Error("tap failed");
    await expect(
      Fx.run(Fx.succeed(42).pipe(Fx.tap(() => Fx.fail(error)))),
    ).rejects.toBe(error);
  });

  it("skips when upstream fails", async () => {
    const spy = vi.fn();
    const error = new Error("upstream");
    await expect(
      Fx.run(Fx.fail(error).pipe(Fx.tap(() => Fx.sync(spy)))),
    ).rejects.toBe(error);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

describe("Fx.inspect", () => {
  it("runs the side-effect on failure and passes through the error", async () => {
    const log: string[] = [];
    const error = new Error("inspected");
    const fx = Fx.fail(error).pipe(
      Fx.inspect((e) => Fx.sync(() => log.push(e.message))),
    );
    await expect(Fx.run(fx)).rejects.toBe(error);
    expect(log).toEqual(["inspected"]);
  });

  it("skips when upstream succeeds", async () => {
    const spy = vi.fn();
    expect(
      await Fx.run(Fx.succeed(42).pipe(Fx.inspect(() => Fx.sync(spy)))),
    ).toBe(42);
    expect(spy).not.toHaveBeenCalled();
  });

  it("replaces the original error when the side-effect Fx itself fails", async () => {
    const inspectError = new Error("inspect-fail");
    await expect(
      Fx.run(
        Fx.fail(new Error("original")).pipe(
          Fx.inspect(() => Fx.fail(inspectError)),
        ),
      ),
    ).rejects.toBe(inspectError);
  });
});

// ---------------------------------------------------------------------------
// recover
// ---------------------------------------------------------------------------

describe("Fx.recover", () => {
  it("catches typed errors and produces a new value", async () => {
    expect(
      await Fx.run(
        Fx.fail(new Error("bad")).pipe(
          Fx.recover(() => Fx.succeed("recovered")),
        ),
      ),
    ).toBe("recovered");
  });

  it("passes success through unchanged", async () => {
    expect(
      await Fx.run(Fx.succeed(42).pipe(Fx.recover(() => Fx.succeed(0)))),
    ).toBe(42);
  });

  it("can re-fail with a different error type", async () => {
    class AppError {
      constructor(readonly msg: string) {}
    }
    await expect(
      Fx.run(
        Fx.fail(new Error("raw")).pipe(
          Fx.recover((e) => Fx.fail(new AppError(e.message))),
        ),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });
});

// ---------------------------------------------------------------------------
// fold
// ---------------------------------------------------------------------------

describe("Fx.fold", () => {
  it("maps success via ok callback", async () => {
    expect(
      await Fx.run(
        Fx.succeed(42).pipe(
          Fx.fold({ ok: (x) => `success: ${x}`, err: (e) => `error: ${e}` }),
        ),
      ),
    ).toBe("success: 42");
  });

  it("maps failure via err callback", async () => {
    expect(
      await Fx.run(
        Fx.fail("boom").pipe(
          Fx.fold({ ok: (x) => `success: ${x}`, err: (e) => `error: ${e}` }),
        ),
      ),
    ).toBe("error: boom");
  });

  it("always produces a successful Fx", async () => {
    expect(
      await Fx.run(
        Fx.fail("any").pipe(Fx.fold({ ok: () => 1, err: () => 2 })),
      ),
    ).toBe(2);
  });

  it("propagates a throwing ok callback as a defect", async () => {
    const defect = new Error("ok boom");
    const fx = Fx.succeed(1).pipe(
      Fx.fold({
        ok: () => {
          throw defect;
        },
        err: () => "err",
      }),
    );
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });

  it("propagates a throwing err callback as a defect", async () => {
    const defect = new Error("err boom");
    const fx = Fx.fail("oops").pipe(
      Fx.fold({
        ok: () => "ok",
        err: () => {
          throw defect;
        },
      }),
    );
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });
});

// ---------------------------------------------------------------------------
// delay
// ---------------------------------------------------------------------------

describe("Fx.delay", () => {
  afterEach(() => vi.useRealTimers());

  it("delays execution by the specified ms", async () => {
    vi.useFakeTimers();
    const promise = Fx.run(Fx.succeed(1).pipe(Fx.delay(50)));
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toBe(1);
  });

  it("delay(0) resolves on the next tick", async () => {
    expect(await Fx.run(Fx.succeed("instant").pipe(Fx.delay(0)))).toBe(
      "instant",
    );
  });

  it("delays a failed computation equally", async () => {
    vi.useFakeTimers();
    const error = new Error("delayed fail");
    const assertion = expect(
      Fx.run(Fx.fail(error).pipe(Fx.delay(50))),
    ).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

describe("Fx.timeout", () => {
  it("returns value when computation finishes in time", async () => {
    expect(await Fx.run(Fx.succeed(42).pipe(Fx.timeout(1000)))).toBe(42);
  });

  it("fails with TimeoutError when computation exceeds duration", async () => {
    const slow = Fx.promise(
      () => new Promise<number>((r) => setTimeout(() => r(1), 200)),
    );
    await expect(Fx.run(slow.pipe(Fx.timeout(30)))).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it("TimeoutError contains the timeout duration", async () => {
    const slow = Fx.promise(
      () => new Promise<number>((r) => setTimeout(() => r(1), 200)),
    );
    await expect(Fx.run(slow.pipe(Fx.timeout(25)))).rejects.toSatisfy(
      (e) => e instanceof TimeoutError && e.ms === 25,
    );
  });

  it("timeout on an already-failed computation preserves the original error", async () => {
    const error = new Error("already failed");
    await expect(
      Fx.run(Fx.fail(error).pipe(Fx.timeout(1000))),
    ).rejects.toBe(error);
  });
});
