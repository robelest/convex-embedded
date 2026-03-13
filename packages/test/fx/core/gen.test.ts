import { Fx } from "@robelest/fx";
import { describe, it, expect } from "vite-plus/test";

// ---------------------------------------------------------------------------
// Fx.gen — generator runner
// ---------------------------------------------------------------------------

describe("Fx.gen", () => {
  it("empty generator returns the value directly", async () => {
    // eslint-disable-next-line require-yield
    const fx = Fx.gen(function* () {
      return 42;
    });
    expect(await Fx.run(fx)).toBe(42);
  });

  it("runs multiple yield* in sequence and returns the final value", async () => {
    const fx = Fx.gen(function* () {
      const a = yield* Fx.succeed(1);
      const b = yield* Fx.succeed(2);
      const c = yield* Fx.succeed(3);
      return a + b + c;
    });
    expect(await Fx.run(fx)).toBe(6);
  });

  it("short-circuits on the first failure", async () => {
    const error = new Error("short-circuit");
    const fx = Fx.gen(function* () {
      const a = yield* Fx.succeed(1);
      yield* Fx.fail(error);
      return a + 999; // unreachable
    });
    await expect(Fx.run(fx)).rejects.toBe(error);
  });

  it("propagates typed errors from yield*-ed computations", async () => {
    class AppError {
      constructor(readonly code: number) {}
    }
    const fx = Fx.gen(function* () {
      yield* Fx.from({
        ok: () => {
          throw new Error("raw");
        },
        err: (_e) => new AppError(42),
      });
      return "unreachable";
    });
    await expect(Fx.run(fx)).rejects.toBeInstanceOf(AppError);
  });

  // -------------------------------------------------------------------------
  // TS2766 regression — runtime short-circuit verification
  // (compile-time checks live in __typetests__)
  // -------------------------------------------------------------------------

  it("yield* Fx.fail() compiles and short-circuits (TS2766 regression)", async () => {
    class NotFoundError {
      readonly _tag = "NotFound" as const;
      constructor(readonly id: string) {}
    }
    const fx = Fx.gen(function* () {
      yield* Fx.fail(new NotFoundError("abc"));
      return "unreachable";
    });
    await expect(Fx.run(fx)).rejects.toBeInstanceOf(NotFoundError);
  });

  // -------------------------------------------------------------------------
  // Composition
  // -------------------------------------------------------------------------

  it("nested Fx.gen composes sequentially", async () => {
    const inner = Fx.gen(function* () {
      const x = yield* Fx.succeed(10);
      return x * 2;
    });
    const outer = Fx.gen(function* () {
      const a = yield* inner;
      const b = yield* Fx.succeed(5);
      return a + b;
    });
    expect(await Fx.run(outer)).toBe(25);
  });

  it("yield* inside recover works", async () => {
    const failing = Fx.fail("oops" as const);

    const recovered = failing.pipe(
      Fx.recover((e) =>
        Fx.gen(function* () {
          const fallback = yield* Fx.succeed("recovered");
          return `${fallback}:${e}`;
        }),
      ),
    );

    expect(await Fx.run(recovered)).toBe("recovered:oops");
  });

  it("defect from yielded Fx propagates as fatal", async () => {
    const defect = new TypeError("kaboom");
    const fx = Fx.gen(function* () {
      yield* Fx.sync(() => {
        throw defect;
      });
      return "unreachable";
    });
    await expect(Fx.run(fx)).rejects.toBe(defect);
  });

  // -------------------------------------------------------------------------
  // guard inside gen
  // -------------------------------------------------------------------------

  describe("Fx.guard inside Fx.gen", () => {
    it("short-circuits when condition is true with a fail fallback", async () => {
      const error = new Error("guarded");
      const fx = Fx.gen(function* () {
        yield* Fx.guard(true, Fx.fail(error));
        return "unreachable";
      });
      await expect(Fx.run(fx)).rejects.toBe(error);
    });

    it("continues when condition is false", async () => {
      const fx = Fx.gen(function* () {
        yield* Fx.guard(false, Fx.fail(new Error("guarded")));
        return "continued";
      });
      expect(await Fx.run(fx)).toBe("continued");
    });

    it("returns the fallback value when condition is true with succeed", async () => {
      const fx = Fx.gen(function* () {
        const v = yield* Fx.guard(true, Fx.succeed("early"));
        return v ?? "fallback";
      });
      expect(await Fx.run(fx)).toBe("early");
    });
  });
});
