/**
 * Migration runner for local schema versioning.
 *
 * Re-exports from `@/shared/migrate` and adds the `convex/server`
 * -aware overload of `MigrationConfig` that accepts `FunctionReference`.
 *
 * @module
 */

/**
 * Run a set of embedded local table migrations against a runtime adapter.
 */
export { runMigrations, migration } from "@/shared/migrate";
/**
 * Migration configuration and adapter types re-exported for server-side local
 * schema upgrades.
 */
export type {
  MigrationConfig,
  LocalTableMigrationStep,
  LocalTableMigrationContext,
  LocalTableDocsApi,
  LocalMigrationAdapter,
} from "@/shared/migrate";
