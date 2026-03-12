import { Fx, FxFatal } from "@robelest/fx";
import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fx.bracket
// ---------------------------------------------------------------------------

describe("Fx.bracket", () => {
  it("acquires, uses, and releases on success", async () => {
    const log: string[] = [];

    const result = await Fx.run(
      Fx.bracket(
        Fx.sync(() => {
          log.push("acquire");
          return "resource";
        }),
        (r) => {
          log.push(`use:${r}`);
          return Fx.succeed(42);
        },
        (r, exit) => {
          log.push(`release:${r}:${exit._tag}`);
          return Fx.unit;
        },
      ),
    );

    expect(result).toBe(42);
    expect(log).toEqual([
      "acquire",
      "use:resource",
      "release:resource:Success",
    ]);
  });

  it("releases on typed failure from use phase", async () => {
    const released = vi.fn();
    const error = new Error("use failed");

    await expect(
      Fx.run(
        Fx.bracket(
          Fx.succeed("res"),
          () => Fx.fail(error),
          (_r, exit) => {
            released(exit._tag);
            return Fx.unit;
          },
        ),
      ),
    ).rejects.toBe(error);

    expect(released).toHaveBeenCalledWith("Failure");
  });

  it("releases on FxFatal from use phase", async () => {
    const released = vi.fn();
    const defect = new Error("fatal in use");

    await expect(
      Fx.run(
        Fx.bracket(
          Fx.succeed("res"),
          () => Fx.fatal(defect),
          (_r, exit) =>
            Fx.match(exit, exit._tag, {
              Success: () => Fx.sync(() => released("success")),
              Failure: (f) =>
                Fx.sync(() =>
                  released(f.error instanceof FxFatal ? "fatal" : "failure"),
                ),
            }) as Fx<void, never>,
        ),
      ),
    ).rejects.toBe(defect);

    expect(released).toHaveBeenCalledWith("fatal");
  });

  it("skips use and release when acquire fails", async () => {
    const useSpy = vi.fn();
    const releaseSpy = vi.fn();
    const error = new Error("acquire failed");

    await expect(
      Fx.run(
        Fx.bracket(
          Fx.fail(error),
          () => {
            useSpy();
            return Fx.succeed("x");
          },
          () => {
            releaseSpy();
            return Fx.unit;
          },
        ),
      ),
    ).rejects.toBe(error);

    expect(useSpy).not.toHaveBeenCalled();
    expect(releaseSpy).not.toHaveBeenCalled();
  });

  it("release defect replaces use-phase error when release throws", async () => {
    const releaseDefect = new Error("release exploded");
    const useError = new Error("use failed");

    // When the use phase fails with a typed error and the release itself
    // throws, bracket's implementation lets the release defect propagate —
    // the original use-phase error is lost.
    await expect(
      Fx.run(
        Fx.bracket(
          Fx.succeed("res"),
          () => Fx.fail(useError),
          () =>
            Fx.sync(() => {
              throw releaseDefect;
            }),
        ),
      ),
    ).rejects.toBe(releaseDefect);
  });

  it("nested brackets release inner then outer", async () => {
    const log: string[] = [];

    const result = await Fx.run(
      Fx.bracket(
        Fx.sync(() => {
          log.push("acquire:outer");
          return "outer";
        }),
        (outer) =>
          Fx.bracket(
            Fx.sync(() => {
              log.push("acquire:inner");
              return "inner";
            }),
            (inner) => {
              log.push(`use:${outer}+${inner}`);
              return Fx.succeed("done");
            },
            (inner) => {
              log.push(`release:${inner}`);
              return Fx.unit;
            },
          ),
        (outer) => {
          log.push(`release:${outer}`);
          return Fx.unit;
        },
      ),
    );

    expect(result).toBe("done");
    expect(log).toEqual([
      "acquire:outer",
      "acquire:inner",
      "use:outer+inner",
      "release:inner",
      "release:outer",
    ]);
  });

  it("bracket composes with recover — release runs and recovery succeeds", async () => {
    const released = vi.fn();
    const useError = new Error("use failed");

    const result = await Fx.run(
      Fx.bracket(
        Fx.succeed("res"),
        () => Fx.fail(useError),
        (_r, exit) => {
          released(exit._tag);
          return Fx.unit;
        },
      ).pipe(
        Fx.recover((err) => Fx.succeed(`recovered:${(err as Error).message}`)),
      ),
    );

    expect(released).toHaveBeenCalledWith("Failure");
    expect(result).toBe("recovered:use failed");
  });
});
