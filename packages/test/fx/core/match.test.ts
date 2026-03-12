import { Fx } from "@robelest/fx";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Test union types
// ---------------------------------------------------------------------------

type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rect"; width: number; height: number }
  | { kind: "triangle"; base: number; height: number };

type Event =
  | { type: "click"; x: number; y: number }
  | { type: "keypress"; key: string }
  | { type: "scroll"; delta: number };

class ParseError {
  readonly _tag = "ParseError" as const;
  constructor(readonly message: string) {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Fx.match", () => {
  it("dispatches to the correct handler based on discriminant value", async () => {
    const shape: Shape = { kind: "circle", radius: 5 };

    const result = await Fx.run(
      Fx.match(shape, shape.kind, {
        circle: (s) => Fx.succeed(Math.PI * s.radius ** 2),
        rect: (s) => Fx.succeed(s.width * s.height),
        triangle: (s) => Fx.succeed((s.base * s.height) / 2),
      }),
    );

    expect(result).toBeCloseTo(Math.PI * 25);
  });

  it("narrows each handler parameter to the specific variant", async () => {
    const event: Event = { type: "keypress", key: "Enter" };

    const result = await Fx.run(
      Fx.match(event, event.type, {
        click: (e) => Fx.succeed(`${e.x},${e.y}`),
        keypress: (e) => Fx.succeed(e.key),
        scroll: (e) => Fx.succeed(`delta:${e.delta}`),
      }),
    );

    expect(result).toBe("Enter");
  });

  it("works with _tag as the discriminant field", async () => {
    type Tagged = { _tag: "A"; value: number } | { _tag: "B"; label: string };

    const tagged: Tagged = { _tag: "B", label: "hello" };

    const result = await Fx.run(
      Fx.match(tagged, tagged._tag, {
        A: (t) => Fx.succeed(String(t.value)),
        B: (t) => Fx.succeed(t.label),
      }),
    );

    expect(result).toBe("hello");
  });

  it("propagates typed failures from handlers", async () => {
    const shape: Shape = { kind: "rect", width: -1, height: 5 };

    await expect(
      Fx.run(
        Fx.match(shape, shape.kind, {
          circle: (s) => Fx.succeed(s.radius),
          rect: (s) =>
            s.width < 0
              ? Fx.fail(new ParseError("negative width"))
              : Fx.succeed(s.width * s.height),
          triangle: (s) => Fx.succeed(s.base),
        }),
      ),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof ParseError && e.message === "negative width",
    );
  });

  it("composes with Fx.gen via yield*", async () => {
    const shape: Shape = { kind: "triangle", base: 10, height: 6 };

    const result = await Fx.run(
      Fx.gen(function* () {
        const area = yield* Fx.match(shape, shape.kind, {
          circle: (s) => Fx.succeed(Math.PI * s.radius ** 2),
          rect: (s) => Fx.succeed(s.width * s.height),
          triangle: (s) => Fx.succeed((s.base * s.height) / 2),
        });
        return area * 2;
      }),
    );

    expect(result).toBe(60);
  });

  it("composes with downstream combinators via pipe", async () => {
    const event: Event = { type: "scroll", delta: 120 };

    const result = await Fx.run(
      Fx.match(event, event.type, {
        click: (e) => Fx.succeed(e.x + e.y),
        keypress: (e) => Fx.succeed(e.key.length),
        scroll: (e) => Fx.succeed(e.delta),
      }).pipe(Fx.map((n) => n * 2)),
    );

    expect(result).toBe(240);
  });

  it("handles single-variant unions", async () => {
    type Only = { kind: "only"; value: number };
    const v: Only = { kind: "only", value: 99 };

    const result = await Fx.run(
      Fx.match(v, v.kind, {
        only: (o) => Fx.succeed(o.value),
      }),
    );

    expect(result).toBe(99);
  });

  it("handlers can return Fx.unit", async () => {
    const shape: Shape = { kind: "circle", radius: 1 };

    const result = await Fx.run(
      Fx.match(shape, shape.kind, {
        circle: () => Fx.unit,
        rect: () => Fx.unit,
        triangle: () => Fx.unit,
      }),
    );

    expect(result).toBeUndefined();
  });
});
