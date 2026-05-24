/**
 * Global test setup (registered via `setupFiles`).
 *
 * Mock hygiene (clearMocks / mockReset / restoreMocks / unstubGlobals /
 * unstubEnvs) is handled centrally in the vitest config. This module registers
 * the suite's custom matchers. Matcher type augmentation lives in `vitest.d.ts`.
 */

import { expect } from "vitest";
import * as Y from "yjs";

interface LwwEntry {
  value: unknown;
  timestamp?: number;
}

/** Read the winning value of a Yjs LWW register stored under `key`. */
function readLwwRegister(map: Y.Map<unknown>, key: string): unknown {
  const register = map.get(key);
  if (!(register instanceof Y.Map)) {
    return undefined;
  }
  let winner: LwwEntry | undefined;
  for (const entry of register.values() as Iterable<LwwEntry>) {
    if (
      winner === undefined ||
      (entry.timestamp ?? -Infinity) > (winner.timestamp ?? -Infinity)
    ) {
      winner = entry;
    }
  }
  return winner?.value;
}

expect.extend({
  toHaveYjsField(received: unknown, key: string, expected: unknown) {
    if (!(received instanceof Y.Map)) {
      return {
        pass: false,
        message: () =>
          `expected a Y.Map, received ${this.utils.printReceived(received)}`,
      };
    }
    const actual = readLwwRegister(received, key);
    const pass = this.equals(actual, expected);
    return {
      pass,
      actual,
      expected,
      message: () =>
        `expected Yjs field ${this.utils.printExpected(key)} ${
          pass ? "not " : ""
        }to equal ${this.utils.printExpected(
          expected,
        )}, received ${this.utils.printReceived(actual)}`,
    };
  },
});
