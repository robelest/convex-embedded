import { Fx } from "@robelest/fx";
import { afterEach, describe, it, expect, vi } from "vite-plus/test";

const makeDelayed = (ms: number, value: number) =>
  Fx.promise(() => new Promise<number>((r) => setTimeout(() => r(value), ms)));

// ---------------------------------------------------------------------------
// Fx.each
// ---------------------------------------------------------------------------

describe("Fx.each", () => {
  it("processes items sequentially and collects results", async () => {
    expect(await Fx.run(Fx.each([1, 2, 3], (x) => Fx.succeed(x * 10)))).toEqual(
      [10, 20, 30],
    );
  });

  it("short-circuits on the first failure", async () => {
    const processed: number[] = [];
    await expect(
      Fx.run(
        Fx.each([1, 2, 3, 4], (x) => {
          processed.push(x);
          return x === 3 ? Fx.fail("stop") : Fx.succeed(x);
        }),
      ),
    ).rejects.toBe("stop");
    expect(processed).toEqual([1, 2, 3]);
  });

  it("returns empty array for empty input", async () => {
    expect(await Fx.run(Fx.each([], () => Fx.succeed(1)))).toEqual([]);
  });

  afterEach(() => vi.useRealTimers());

  it("proves sequential execution via ordering", async () => {
    vi.useFakeTimers();
    const log: number[] = [];

    const promise = Fx.run(
      Fx.each([1, 2, 3], (x) =>
        Fx.promise(
          () =>
            new Promise<number>((r) =>
              setTimeout(() => {
                log.push(x);
                r(x);
              }, 10),
            ),
        ),
      ),
    );

    // Each item is sequential — need 10ms per item (3 total)
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(10);

    expect(await promise).toEqual([1, 2, 3]);
    expect(log).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Fx.all
// ---------------------------------------------------------------------------

describe("Fx.all", () => {
  it("runs all computations and collects results", async () => {
    expect(
      await Fx.run(Fx.all([Fx.succeed(1), Fx.succeed(2), Fx.succeed(3)])),
    ).toEqual([1, 2, 3]);
  });

  it("returns the first failure in iteration order", async () => {
    await expect(
      Fx.run(Fx.all([Fx.succeed(1), Fx.fail("second"), Fx.fail("third")])),
    ).rejects.toBe("second");
  });

  it("works with empty iterable", async () => {
    expect(await Fx.run(Fx.all([]))).toEqual([]);
  });

  afterEach(() => vi.useRealTimers());

  it("runs computations concurrently", async () => {
    vi.useFakeTimers();

    const promise = Fx.run(
      Fx.all([makeDelayed(50, 1), makeDelayed(50, 2), makeDelayed(50, 3)]),
    );
    // All three timers are 50ms — if truly parallel, advancing 50ms resolves all
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toEqual([1, 2, 3]);
  });

  it("propagates fatal from any computation", async () => {
    await expect(
      Fx.run(Fx.all([Fx.succeed(1), Fx.fatal("boom"), Fx.succeed(3)])),
    ).rejects.toBe("boom");
  });
});

// ---------------------------------------------------------------------------
// Fx.race
// ---------------------------------------------------------------------------

describe("Fx.race", () => {
  it("returns the first computation to complete", async () => {
    expect(
      await Fx.run(
        Fx.race([
          Fx.promise(
            () => new Promise<string>((r) => setTimeout(() => r("fast"), 5)),
          ),
          Fx.promise(
            () => new Promise<string>((r) => setTimeout(() => r("slow"), 50)),
          ),
        ]),
      ),
    ).toBe("fast");
  });

  it("returns failure if the first to complete fails", async () => {
    await expect(
      Fx.run(
        Fx.race([
          Fx.from({
            ok: async () => {
              await new Promise((r) => setTimeout(r, 5));
              throw new Error("fast fail");
            },
            err: (e) => e as Error,
          }),
          Fx.promise(
            () => new Promise<string>((r) => setTimeout(() => r("slow"), 50)),
          ),
        ]),
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("resolves with a single computation", async () => {
    expect(await Fx.run(Fx.race([Fx.succeed(1)]))).toBe(1);
  });

  it("rejects when all computations fail", async () => {
    await expect(
      Fx.run(
        Fx.race([
          Fx.from({
            ok: async () => {
              await new Promise((r) => setTimeout(r, 5));
              throw new Error("first");
            },
            err: (e) => e as Error,
          }),
          Fx.from({
            ok: async () => {
              await new Promise((r) => setTimeout(r, 10));
              throw new Error("second");
            },
            err: (e) => e as Error,
          }),
        ]),
      ),
    ).rejects.toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Fx.zip
// ---------------------------------------------------------------------------

describe("Fx.zip", () => {
  it("pairs two success values into a tuple", async () => {
    expect(await Fx.run(Fx.zip(Fx.succeed("a"), Fx.succeed(1)))).toEqual([
      "a",
      1,
    ]);
  });

  it("fails when the first computation fails", async () => {
    const error = new Error("first");
    await expect(Fx.run(Fx.zip(Fx.fail(error), Fx.succeed(1)))).rejects.toBe(
      error,
    );
  });

  it("fails when the second computation fails", async () => {
    const error = new Error("second");
    await expect(Fx.run(Fx.zip(Fx.succeed(1), Fx.fail(error)))).rejects.toBe(
      error,
    );
  });

  it("prefers the first failure when both fail", async () => {
    const first = new Error("first");
    await expect(
      Fx.run(Fx.zip(Fx.fail(first), Fx.fail(new Error("second")))),
    ).rejects.toBe(first);
  });

  afterEach(() => vi.useRealTimers());

  it("runs both computations concurrently", async () => {
    vi.useFakeTimers();

    const promise = Fx.run(Fx.zip(makeDelayed(50, 1), makeDelayed(50, 2)));
    await vi.advanceTimersByTimeAsync(50);
    expect(await promise).toEqual([1, 2]);
  });

  it("propagates fatal from either side", async () => {
    await expect(
      Fx.run(Fx.zip(Fx.fatal("defect"), Fx.succeed(1))),
    ).rejects.toBe("defect");
  });
});
