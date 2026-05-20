/**
 * Migration runner + ctx types for server-side imports.
 */

export {
  runMigrations,
  migration,
  type RunMigrationsOptions,
  type MigrationRuntimeAdapter,
} from "@/shared/migrations/migrate";

export {
  type MigrationContext,
  type MigrationDb,
  type MigrationLogger,
  type MigrationSchema,
  type MigrationStep,
  type MigrationSystem,
  type MigrationSystemTable,
  type MigrationsMap,
} from "@/shared/migrations/types";
