/**
 * CDN URL constants and WASM preloading utilities for wa-sqlite.
 *
 * The WASM binary is served from Cloudflare R2 with immutable caching.
 * Use {@link preloadLinks} to generate an HTML `<link rel="preload">` tag
 * that can be added to `<head>`, or call {@link injectPreloadLinks} to
 * programmatically inject it at runtime.
 *
 * {@link compileWasmModule} returns a singleton `WebAssembly.Module` compiled
 * via streaming — if the preload link was already in the document the browser
 * will reuse the cached response instead of issuing a second fetch.
 *
 * @example
 * ```html
 * <!-- Static preload in your HTML shell -->
 * <head>
 *   <link rel="preload" href="https://wa-sqlite.trestle.inc/v1.0.0/dist/wa-sqlite-async.wasm"
 *         as="fetch" type="application/wasm" crossorigin />
 * </head>
 * ```
 *
 * @example
 * ```ts
 * import { compileWasmModule } from "@robelest/convex-embedded/browser";
 *
 * const module = await compileWasmModule();
 * ```
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// CDN constants
// ---------------------------------------------------------------------------

/** Base URL for wa-sqlite assets served from Cloudflare R2. */
export const CDN_BASE = "https://wa-sqlite.trestle.inc/v1.0.0";

/** URL for the wa-sqlite async WASM binary. */
export const WASM_URL = `${CDN_BASE}/dist/wa-sqlite-async.wasm`;

// ---------------------------------------------------------------------------
// Preload link helpers
// ---------------------------------------------------------------------------

/**
 * Return an HTML `<link rel="preload">` tag for the WASM binary.
 *
 * Add the returned string to your document `<head>` to start the network
 * fetch before any JavaScript executes. The browser will cache the response
 * and {@link compileWasmModule} will reuse it automatically.
 *
 * @returns An HTML string suitable for injection into `<head>`.
 */
export function preloadLinks(): string {
  return `<link rel="preload" href="${WASM_URL}" as="fetch" type="application/wasm" crossorigin />`;
}

/**
 * Programmatically inject the WASM preload link into `document.head`.
 *
 * This is a convenience wrapper for environments where you cannot edit
 * the HTML shell directly (e.g. third-party hosting, framework plugins).
 * Calling this multiple times is safe — subsequent calls are no-ops.
 */
export function injectPreloadLinks(): void {
  if (typeof document === "undefined") {
    return;
  }

  // Avoid duplicates — check for an existing preload link with the same href.
  const existing = document.querySelector(
    `link[rel="preload"][href="${WASM_URL}"]`,
  );
  if (existing) {
    return;
  }

  const link = document.createElement("link");
  link.rel = "preload";
  link.href = WASM_URL;
  link.as = "fetch";
  link.type = "application/wasm";
  link.crossOrigin = "anonymous";
  document.head.appendChild(link);
}

// ---------------------------------------------------------------------------
// WASM compilation singleton
// ---------------------------------------------------------------------------

/** Module-level cache — at most one compile ever happens. */
let _compiledModule: Promise<WebAssembly.Module> | null = null;

/**
 * Compile the wa-sqlite WASM binary via streaming and return the module.
 *
 * The result is cached in a module-level variable so only one fetch+compile
 * cycle ever occurs regardless of how many times this function is called.
 * If {@link preloadLinks} or {@link injectPreloadLinks} was used beforehand
 * the browser will serve the response from the preload cache.
 *
 * Returns `null` when called during SSR (`typeof window === "undefined"`).
 *
 * @returns The compiled `WebAssembly.Module`, or `null` in non-browser
 *   environments.
 */
export function compileWasmModule(): Promise<WebAssembly.Module | null> {
  if (typeof window === "undefined") {
    return Promise.resolve(null);
  }

  if (!_compiledModule) {
    _compiledModule = WebAssembly.compileStreaming(fetch(WASM_URL));
  }

  return _compiledModule;
}
