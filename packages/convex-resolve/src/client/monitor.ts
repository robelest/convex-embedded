/**
 * @internal
 * @deprecated Use `createConvexClient()` from `@robelest/convex-embedded/browser`.
 *
 * Thin compatibility shim — delegates to engine.ts.
 */
export { engine as monitor } from "@/client/engine";
export type {
  EngineConfig as MonitorConfig,
  EngineInstance as MonitorInstance,
  TableConfig,
  EmbeddedClientLike,
} from "@/client/engine";
