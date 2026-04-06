/**
 * Migration runner for local schema versioning.
 *
 * Re-exports from `@/shared/migration-utils` and adds the `convex/server`
 * -aware overload of `MigrationConfig` that accepts `FunctionReference`.
 *
 * @module
 */

// Re-export everything from the shared migration utils
export { runMigrations, migration } from "@/shared/migration-utils";
export type {
  MigrationConfig,
  LocalTableMigrationStep,
  LocalTableMigrationContext,
  LocalTableDocsApi,
  LocalMigrationAdapter,
} from "@/shared/migration-utils";
