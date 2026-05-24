import "vitest";

interface EmbeddedMatchers<R> {
  /** Assert a Yjs `Y.Map` field's LWW register resolves to `expected`. */
  toHaveYjsField: (key: string, expected: unknown) => R;
}

declare module "vitest" {
  interface Matchers<T> extends EmbeddedMatchers<T> {}
  interface AsymmetricMatchersContaining extends EmbeddedMatchers<unknown> {}
}
