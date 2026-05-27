/**
 * Typed `test.extend` fixtures — the replacement for hand-rolled
 * `beforeEach` / `afterEach` / manual `.close()` across the suite.
 *
 * Re-exported as the project-local `it` / `test` from `@tests/testkit`, so the
 * whole suite picks up fixtures by importing from there. Plain `it(name, fn)`
 * still works — fixtures are opt-in per test via the destructured first arg.
 */

import { Database } from "@embedded/runtime/db/database";
import * as vitest from "vitest";

import { OpaqueTestAdapter } from "./adapter";
import { createAppConvexTest, type AppConvexTest } from "./convex";
import {
  embeddedTest,
  type EmbeddedTestContext,
  type EmbeddedTestOptions,
  type ModuleValue,
} from "./embedded";

interface Closeable {
  close: () => unknown;
}

export interface TestFixtures {
  /** A fresh in-memory {@link Database} (schema-less). */
  db: Database;
  /** A fresh in-memory storage adapter, closed automatically. */
  storage: OpaqueTestAdapter;
  /** A typed convex-test harness for the demo backend + resolve component. */
  convex: AppConvexTest;
  /** Build an embedded runtime; the primary vehicle for runtime-level tests. */
  embedded: <M extends Record<string, ModuleValue>>(
    options: EmbeddedTestOptions<M>,
  ) => EmbeddedTestContext<M>;
  /** Register any closeable for automatic teardown after the test. */
  track: <T extends Closeable>(closeable: T) => T;
}

export const it = vitest.it.extend<TestFixtures>({
  db: async ({}, use) => {
    await use(new Database(null));
  },
  storage: async ({ onTestFinished }, use) => {
    const storage = new OpaqueTestAdapter();
    onTestFinished(() => storage.close());
    await use(storage);
  },
  convex: async ({}, use) => {
    await use(createAppConvexTest());
  },
  embedded: async ({}, use) => {
    await use(embeddedTest);
  },
  track: async ({ onTestFinished }, use) => {
    const closeables: Closeable[] = [];
    onTestFinished(async () => {
      for (const closeable of closeables.reverse()) {
        await closeable.close();
      }
    });
    await use((closeable) => {
      closeables.push(closeable);
      return closeable;
    });
  },
});
