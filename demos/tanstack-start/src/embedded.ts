/// <reference types="vite/client" />
/**
 * Embedded Convex runtime — runs a lightweight Convex backend in the browser.
 *
 * Creates an in-memory embedded runtime that loads the convex/ modules
 * from the monorepo root. The transport it produces can be used to create
 * a ConvexReactClient that talks to this local runtime instead of the cloud.
 */
import { createEmbeddedConvex } from "@robelest/convex-embedded";

// Eagerly import all convex function modules (excluding generated & config).
// Three levels up from src/ → demos/tanstack-start/ → demos/ → repo root.
const modules = import.meta.glob(
  [
    "../../../convex/**/*.{ts,tsx,js,jsx}",
    "!../../../convex/_generated/**",
    "!../../../convex/convex.config.ts",
  ],
);

let runtime: ReturnType<typeof createEmbeddedConvex> | null = null;

export function getEmbeddedRuntime() {
  if (!runtime) {
    runtime = createEmbeddedConvex({ modules });
  }
  return runtime;
}

export function getTransport() {
  return getEmbeddedRuntime().createTransport();
}
