import { Fx } from "@robelest/fx";
import { describe, it, expect, vi, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// retry policies
// ---------------------------------------------------------------------------

describe("Fx.retry.exponential", () => {
  it("computes baseMs * 2^attempt", () => {
    const policy = Fx.retry.exponential(100);
    expect(policy.next(0, null)).toBe(100);
    expect(policy.next(1, null)).toBe(200);
    expect(policy.next(2, null)).toBe(400);
    expect(policy.next(3, null)).toBe(800);
  });

  it("never returns null (infinite retries)", () => {
    const policy = Fx.retry.exponential(50);
    expect(policy.next(100, null)).not.toBeNull();
  });

  it("returns Infinity-safe delays for large attempt numbers", () => {
    const policy = Fx.retry.exponential(100);
    // 2^50 * 100 = 1.1259e17 — large but still a finite IEEE-754 double
    const delay50 = policy.next(50, null)!;
    expect(delay50).not.toBeNull();
    expect(Number.isFinite(delay50)).toBe(true);
    expect(delay50).toBe(100 * 2 ** 50);

    // At attempt 1017, 100 * 2^1017 is the last finite value
    const delayLast = policy.next(1017, null)!;
    expect(Number.isFinite(delayLast)).toBe(true);

    // At attempt 1018, 100 * 2^1018 overflows IEEE-754 to Infinity.
    // The policy still returns a non-null number (never stops),
    // but the delay is no longer finite — documenting the overflow edge.
    const delayOverflow = policy.next(1018, null)!;
    expect(delayOverflow).not.toBeNull();
    expect(delayOverflow).toBe(Infinity);
  });
});

describe("Fx.retry.recurs", () => {
  it("allows exactly n retries", () => {
    const policy = Fx.retry.recurs(3);
    expect(policy.next(0, null)).toBe(0);
    expect(policy.next(1, null)).toBe(0);
    expect(policy.next(2, null)).toBe(0);
    expect(policy.next(3, null)).toBeNull();
  });

  it("recurs(0) allows zero retries", () => {
    const policy = Fx.retry.recurs(0);
    expect(policy.next(0, null)).toBeNull();
  });
});

describe("Fx.retry.jittered", () => {
  it("applies jitter within the 0.75-1.25 range", () => {
    const base = Fx.retry.exponential(1000);
    const jittered = Fx.retry.jittered(base);

    // Sample 50 values at attempt=0 (base = 1000)
    const values = Array.from({ length: 50 }, () => jittered.next(0, null)!);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(750);
      expect(v).toBeLessThanOrEqual(1250);
    }
  });

  it("passes through null from inner policy", () => {
    const limited = Fx.retry.recurs(0);
    const jittered = Fx.retry.jittered(limited);
    expect(jittered.next(0, null)).toBeNull();
  });
});

describe("Fx.retry.compose", () => {
  it("takes delay from first policy, stops when second returns null", () => {
    const composed = Fx.retry.compose(
      Fx.retry.exponential(100),
      Fx.retry.recurs(2),
    );
    expect(composed.next(0, null)).toBe(100);
    expect(composed.next(1, null)).toBe(200);
    expect(composed.next(2, null)).toBeNull();
  });

  it("stops when delay policy returns null", () => {
    const delayThatStops = {
      next: (attempt: number) => (attempt < 1 ? 50 : null),
    };
    const composed = Fx.retry.compose(delayThatStops, Fx.retry.recurs(10));
    expect(composed.next(0, null)).toBe(50);
    expect(composed.next(1, null)).toBeNull();
  });
});

describe("Fx.retry.while", () => {
  it("stops when predicate returns false", () => {
    const policy = Fx.retry.while(Fx.retry.recurs(10), (meta) => {
      return meta.input !== "stop";
    });
    expect(policy.next(0, "continue")).toBe(0);
    expect(policy.next(1, "stop")).toBeNull();
  });

  it("passes attempt number to predicate", () => {
    const attempts: number[] = [];
    const policy = Fx.retry.while(Fx.retry.recurs(5), (meta) => {
      attempts.push(meta.attempt);
      return true;
    });
    policy.next(0, null);
    policy.next(1, null);
    policy.next(2, null);
    expect(attempts).toEqual([0, 1, 2]);
  });

  it("receives the typed error in the predicate during retry", () => {
    const seenErrors: string[] = [];
    const policy = Fx.retry.while<string>(Fx.retry.recurs(5), (meta) => {
      seenErrors.push(meta.input);
      return meta.input !== "fatal-error";
    });

    // Simulate calling next with different errors on each attempt
    expect(policy.next(0, "transient-1")).toBe(0);
    expect(policy.next(1, "transient-2")).toBe(0);
    expect(policy.next(2, "fatal-error")).toBeNull();

    expect(seenErrors).toEqual(["transient-1", "transient-2", "fatal-error"]);
  });
});

// ---------------------------------------------------------------------------
// Fx.retry combinator
// ---------------------------------------------------------------------------

describe("Fx.retry (combinator)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on failure and eventually succeeds", async () => {
    let attempt = 0;
    const fx = Fx.defer(() => {
      attempt++;
      return attempt < 3 ? Fx.fail("not yet") : Fx.succeed("done");
    });

    const result = await Fx.run(fx.pipe(Fx.retry(Fx.retry.recurs(5))));
    expect(result).toBe("done");
    expect(attempt).toBe(3);
  });

  it("returns the last failure when retries are exhausted", async () => {
    let attempt = 0;
    const fx = Fx.defer(() => {
      attempt++;
      return Fx.fail(`fail-${attempt}`);
    });

    await expect(Fx.run(fx.pipe(Fx.retry(Fx.retry.recurs(2))))).rejects.toBe(
      "fail-3",
    ); // initial + 2 retries = 3 attempts
  });

  it("does not retry on FxFatal", async () => {
    let attempt = 0;
    const fx = Fx.defer(() => {
      attempt++;
      return Fx.fatal(new Error("defect"));
    });

    await expect(
      Fx.run(fx.pipe(Fx.retry(Fx.retry.recurs(5)))),
    ).rejects.toBeInstanceOf(Error);
    expect(attempt).toBe(1);
  });

  it("works with compose(exponential, recurs)", async () => {
    let attempt = 0;
    const fx = Fx.defer(() => {
      attempt++;
      return attempt < 3 ? Fx.fail("retry") : Fx.succeed("ok");
    });

    const policy = Fx.retry.compose(
      Fx.retry.exponential(1), // 1ms base to keep test fast
      Fx.retry.recurs(5),
    );

    const result = await Fx.run(fx.pipe(Fx.retry(policy)));
    expect(result).toBe("ok");
  });

  it("applies delay between retries", async () => {
    vi.useFakeTimers();

    let attempt = 0;
    const fx = Fx.defer(() => {
      attempt++;
      return attempt < 3 ? Fx.fail("not yet") : Fx.succeed("delayed-ok");
    });

    const policy = Fx.retry.compose(
      Fx.retry.exponential(100),
      Fx.retry.recurs(3),
    );

    let resolved = false;
    const promise = Fx.run(fx.pipe(Fx.retry(policy))).then((v) => {
      resolved = true;
      return v;
    });

    // After initial attempt, first retry is pending (delay = 100ms)
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toBe(1);
    expect(resolved).toBe(false);

    // Advance 100ms — first retry fires (attempt 2 fails, delay = 200ms)
    await vi.advanceTimersByTimeAsync(100);
    expect(attempt).toBe(2);
    expect(resolved).toBe(false);

    // Advance 200ms — second retry fires (attempt 3 succeeds)
    await vi.advanceTimersByTimeAsync(200);
    expect(attempt).toBe(3);

    const result = await promise;
    expect(resolved).toBe(true);
    expect(result).toBe("delayed-ok");
  });

  it("retry with jittered(exponential) + recurs composes correctly", async () => {
    let attempt = 0;

    const fx = Fx.defer(() => {
      attempt++;
      return attempt <= 3 ? Fx.fail(`err-${attempt}`) : Fx.succeed("jitter-ok");
    });

    // Seed Math.random to return 0.5 (jitter multiplier = 0.75 + 0.5*0.5 = 1.0)
    // This makes jittered delays deterministic and equal to the base delays
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const policy = Fx.retry.compose(
      Fx.retry.jittered(Fx.retry.exponential(10)),
      Fx.retry.recurs(5),
    );

    // Collect what the policy computes for each attempt
    const delays = Array.from({ length: 5 }, (_, i) =>
      policy.next(i, `err-${i + 1}`),
    );

    // With Math.random() = 0.5 → jitter multiplier = 1.0
    // So delays are exactly the exponential values
    expect(delays[0]).toBe(10); // 10 * 2^0 * 1.0
    expect(delays[1]).toBe(20); // 10 * 2^1 * 1.0
    expect(delays[2]).toBe(40); // 10 * 2^2 * 1.0
    expect(delays[3]).toBe(80); // 10 * 2^3 * 1.0
    expect(delays[4]).toBe(160); // 10 * 2^4 * 1.0

    // Now run the actual Fx to verify end-to-end behavior
    const result = await Fx.run(
      fx.pipe(
        Fx.retry(
          Fx.retry.compose(
            Fx.retry.jittered(Fx.retry.exponential(1)),
            Fx.retry.recurs(5),
          ),
        ),
      ),
    );

    expect(result).toBe("jitter-ok");
    expect(attempt).toBe(4); // 1 initial + 3 retries

    randomSpy.mockRestore();
  });
});
