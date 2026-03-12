import { Fx } from "@robelest/fx";
import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fx.pipe (standalone utility)
// ---------------------------------------------------------------------------

describe("Fx.pipe", () => {
  it("returns the value unchanged with no functions", () => {
    expect(Fx.pipe(42)).toBe(42);
  });

  it("applies functions left-to-right", () => {
    const result = Fx.pipe(
      [3, 1, 2],
      (arr) => [...arr].sort(),
      (arr) => arr.join(","),
      (s) => `[${s}]`,
    );
    expect(result).toBe("[1,2,3]");
  });
});

// ---------------------------------------------------------------------------
// .pipe() instance method on Fx
// ---------------------------------------------------------------------------

describe("Fx .pipe() instance method", () => {
  it("chains a single combinator", async () => {
    const result = await Fx.run(Fx.succeed(5).pipe(Fx.map((x) => x * 3)));
    expect(result).toBe(15);
  });

  it("chains multiple combinators left-to-right", async () => {
    const log: number[] = [];
    const result = await Fx.run(
      Fx.succeed(10).pipe(
        Fx.map((x) => x + 1),
        Fx.tap((x) => Fx.sync(() => log.push(x))),
        Fx.map((x) => x * 2),
      ),
    );
    expect(result).toBe(22);
    expect(log).toEqual([11]);
  });
});

// ---------------------------------------------------------------------------
// Fx.attempt
// ---------------------------------------------------------------------------

describe("Fx.attempt", () => {
  it("calls onOk when async fn succeeds", async () => {
    const result = await Fx.run(
      Fx.attempt(
        () => Promise.resolve(42),
        (x) => `ok: ${x}`,
        (e) => `err: ${e}`,
      ),
    );
    expect(result).toBe("ok: 42");
  });

  it("calls onErr when async fn throws", async () => {
    const result = await Fx.run(
      Fx.attempt(
        () => Promise.reject(new Error("boom")),
        (x) => `ok: ${x}`,
        (e) => `err: ${(e as Error).message}`,
      ),
    );
    expect(result).toBe("err: boom");
  });

  it("always produces a successful computation", async () => {
    const result = await Fx.run(
      Fx.attempt(
        () => Promise.reject("anything"),
        () => "ok",
        () => "recovered",
      ),
    );
    expect(result).toBe("recovered");
  });

  it("propagates a throwing onOk callback as a defect", async () => {
    const defect = new Error("onOk blew up");
    await expect(
      Fx.run(
        Fx.attempt(
          () => Promise.resolve("fine"),
          () => {
            throw defect;
          },
          () => "recovered",
        ),
      ),
    ).rejects.toBe(defect);
  });

  it("propagates a throwing onErr callback as a defect", async () => {
    const defect = new Error("onErr blew up");
    await expect(
      Fx.run(
        Fx.attempt(
          () => Promise.reject(new Error("original")),
          () => "ok",
          () => {
            throw defect;
          },
        ),
      ),
    ).rejects.toBe(defect);
  });
});

// ---------------------------------------------------------------------------
// Fx.detach
// ---------------------------------------------------------------------------

describe("Fx.detach", () => {
  it("runs the function without returning a promise", () => {
    const result = Fx.detach(() => Promise.resolve(), "label");
    expect(result).toBeUndefined();
  });

  it("logs errors to console.error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("detach fail");

    Fx.detach(() => Promise.reject(error), "[test]");

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("[test]", error);
    });
    errorSpy.mockRestore();
  });

  it("does not reject the caller on error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // detach returns void synchronously — even a rejecting fn must not throw
    const act = () =>
      Fx.detach(() => Promise.reject(new Error("ignored")), "[safe]");
    expect(act).not.toThrow();

    // wait for the background rejection to be caught and logged
    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledOnce();
    });
    errorSpy.mockRestore();
  });
});
