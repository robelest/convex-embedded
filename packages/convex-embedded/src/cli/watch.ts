import { watch } from "node:fs";
import path from "node:path";

import { runCodegen, type RunCodegenInput, type RunCodegenResult } from "./codegen";

/**
 * Input to {@link watchCodegen}. Extends {@link RunCodegenInput} with
 * watch-mode hooks.
 *
 * @public
 */
export interface WatchCodegenInput extends RunCodegenInput {
  /** Called after each successful regeneration. */
  onResult?: (result: RunCodegenResult) => void;
  /** Called when codegen throws; the watcher continues running. */
  onError?: (error: unknown) => void;
  /** How long to coalesce rapid file events (default 50ms). */
  debounceMs?: number;
}

/**
 * Handle returned by {@link watchCodegen}. Call `close()` to stop the
 * watcher and free the underlying `fs.watch` resource.
 *
 * @public
 */
export interface WatchCodegenHandle {
  close(): void;
}

/**
 * Watch the convex directory and re-run codegen on file changes.
 *
 * Uses `node:fs.watch({ recursive: true })`. Requires Node 20+ on Linux;
 * macOS and Windows have supported it longer. No external deps.
 */
export async function watchCodegen(
  input: WatchCodegenInput,
): Promise<WatchCodegenHandle> {
  const cwd = input.cwd ?? process.cwd();
  const convexRoot = path.resolve(cwd, input.convexDir);
  const outFile = path.resolve(cwd, input.outFile);
  const generatedRoot = path.resolve(convexRoot, "_generated");
  const debounceMs = input.debounceMs ?? 50;

  await runOnce();

  let pending: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch(
    convexRoot,
    { recursive: true },
    (_event, filename) => {
      if (!filename) return;
      const absolute = path.resolve(convexRoot, filename.toString());
      // Ignore self-writes to _generated/ to avoid infinite loops.
      if (
        absolute === outFile ||
        absolute.startsWith(generatedRoot + path.sep) ||
        absolute === generatedRoot
      ) {
        return;
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(absolute)) return;
      if (pending !== null) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        void runOnce();
      }, debounceMs);
    },
  );

  return {
    close: () => {
      if (pending !== null) clearTimeout(pending);
      watcher.close();
    },
  };

  async function runOnce(): Promise<void> {
    try {
      const result = await runCodegen(input);
      input.onResult?.(result);
    } catch (err) {
      input.onError?.(err);
    }
  }
}
