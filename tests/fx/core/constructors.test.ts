import { Fx } from "@robelest/fx";
import { describe, it, expect, vi } from "vite-plus/test";

// ---------------------------------------------------------------------------
// succeed
// ---------------------------------------------------------------------------

describe("Fx.succeed", () => {
  it("wraps a value into a successful computation", async () => {
    expect(await Fx.run(Fx.succeed(42))).toBe(42);
  });

  it("preserves referential identity", async () => {
    const obj = { name: "test", value: 123 };
    expect(await Fx.run(Fx.succeed(obj))).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// fail
// ---------------------------------------------------------------------------

describe("Fx.fail", () => {
  it("creates an immediately-failed computation", async () => {
    const error = new Error("boom");
    await expect(Fx.run(Fx.fail(error))).rejects.toBe(error);
  });

  it("preserves custom error types", async () => {
    class AppError {
      readonly _tag = "AppError";
      constructor(readonly message: string) {}
    }
    const error = new AppError("test");
    await expect(Fx.run(Fx.fail(error))).rejects.toBe(error);
  });
});

// ---------------------------------------------------------------------------
// fatal
// ---------------------------------------------------------------------------

describe("Fx.fatal", () => {
  it("throws the original defect unwrapped from FxFatal", async () => {
    const defect = new Error("invariant violated");
    await expect(Fx.run(Fx.fatal(defect))).rejects.toBe(defect);
  });

  it("bypasses recover", async () => {
    const defect = new Error("defect");
    const fx = Fx.fatal(defect).pipe(Fx.recover(() => Fx.succeed("recovered")));
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });

  it("bypasses fold", async () => {
    const defect = new Error("defect");
    const fx = Fx.fatal(defect).pipe(
      Fx.fold({ ok: () => "ok", err: () => "err" }),
    );
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });

  it("bypasses inspect", async () => {
    const spy = vi.fn();
    const defect = new Error("defect");
    const fx = Fx.fatal(defect).pipe(Fx.inspect(() => Fx.sync(spy)));
    await expect(Fx.run(fx)).rejects.toBe(defect);
    expect(spy).not.toHaveBeenCalled();
  });

  it("works with non-Error defects", async () => {
    await expect(Fx.run(Fx.fatal("string defect"))).rejects.toBe(
      "string defect",
    );
  });
});

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

describe("Fx.sync", () => {
  it("defers evaluation of a synchronous thunk", async () => {
    let called = false;
    const fx = Fx.sync(() => {
      called = true;
      return 42;
    });
    expect(called).toBe(false);
    expect(await Fx.run(fx)).toBe(42);
    expect(called).toBe(true);
  });

  it("re-evaluates on each run", async () => {
    let count = 0;
    const fx = Fx.sync(() => ++count);
    await Fx.run(fx);
    await Fx.run(fx);
    expect(count).toBe(2);
  });

  it("propagates a thrown exception as a defect", async () => {
    const defect = new Error("sync boom");
    const fx = Fx.sync(() => {
      throw defect;
    });
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });
});

// ---------------------------------------------------------------------------
// promise
// ---------------------------------------------------------------------------

describe("Fx.promise", () => {
  it("wraps an infallible promise thunk", async () => {
    expect(await Fx.run(Fx.promise(() => Promise.resolve(42)))).toBe(42);
  });

  it("defers the promise creation", async () => {
    let called = false;
    const fx = Fx.promise(() => {
      called = true;
      return Promise.resolve("ok");
    });
    expect(called).toBe(false);
    await Fx.run(fx);
    expect(called).toBe(true);
  });

  it("propagates a synchronous throw from the thunk as a defect", async () => {
    const defect = new Error("thunk boom");
    const fx = Fx.promise(() => {
      throw defect;
    });
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });

  it("propagates a rejection as a defect", async () => {
    const defect = new Error("rejected");
    const fx = Fx.promise(() => Promise.reject(defect));
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });
});

// ---------------------------------------------------------------------------
// from
// ---------------------------------------------------------------------------

describe("Fx.from", () => {
  it("succeeds when ok returns a value", async () => {
    expect(
      await Fx.run(Fx.from({ ok: () => 42, err: (e) => e as Error })),
    ).toBe(42);
  });

  it("succeeds when ok returns a Promise", async () => {
    expect(
      await Fx.run(
        Fx.from({ ok: () => Promise.resolve("async"), err: (e) => e as Error }),
      ),
    ).toBe("async");
  });

  it("fails with the mapped error when ok throws", async () => {
    class MappedError {
      constructor(readonly cause: unknown) {}
    }
    const fx = Fx.from({
      ok: (): number => {
        throw new Error("raw");
      },
      err: (e) => new MappedError(e),
    });
    await expect(Fx.run(fx)).rejects.toBeInstanceOf(MappedError);
  });

  it("fails with the mapped error when ok rejects", async () => {
    const fx = Fx.from({
      ok: () => Promise.reject(new Error("rejected")),
      err: (e) => String(e),
    });
    await expect(Fx.run(fx)).rejects.toMatch("rejected");
  });

  it("propagates err mapper throw as a defect", async () => {
    const defect = new Error("mapper boom");
    const fx = Fx.from({
      ok: (): number => {
        throw new Error("original");
      },
      err: () => {
        throw defect;
      },
    });
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });
});

// ---------------------------------------------------------------------------
// defer
// ---------------------------------------------------------------------------

describe("Fx.defer", () => {
  it("constructs a fresh Fx on each execution", async () => {
    let count = 0;
    const fx = Fx.defer(() => Fx.succeed(++count));
    expect(await Fx.run(fx)).toBe(1);
    expect(await Fx.run(fx)).toBe(2);
  });

  it("allows side-effects in the factory", async () => {
    const log: string[] = [];
    const fx = Fx.defer(() => {
      log.push("factory");
      return Fx.succeed("ok");
    });
    expect(log).toHaveLength(0);
    await Fx.run(fx);
    expect(log).toEqual(["factory"]);
  });
});

// ---------------------------------------------------------------------------
// unit
// ---------------------------------------------------------------------------

describe("Fx.unit", () => {
  it("succeeds with undefined", async () => {
    expect(await Fx.run(Fx.unit)).toBeUndefined();
  });
});
