import type { Validator } from "convex/values";

export interface MigrationDb {
  all(): Promise<Array<Record<string, unknown>>>;
  iter(): AsyncIterable<Record<string, unknown>>;
  get(id: string): Promise<Record<string, unknown> | null>;
  insert(fields: Record<string, unknown>): Promise<string>;
  patch(id: string, fields: Record<string, unknown>): Promise<void>;
  patchMissing(fields: Record<string, unknown>): Promise<number>;
  replace(id: string, fields: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
  modify(
    transform: (
      doc: Record<string, unknown>,
    ) =>
      | Record<string, unknown>
      | null
      | void
      | Promise<Record<string, unknown> | null | void>,
  ): Promise<number>;
}

export interface MigrationSchema {
  readonly fromVersion: number;
  readonly toVersion: number;
  addColumn(
    name: string,
    validator: Validator<unknown, "required" | "optional", string>,
    options?: { defaultSql?: string },
  ): Promise<void>;
  dropColumn(name: string): Promise<void>;
  addIndex(
    name: string,
    fields: readonly string[],
    options?: { unique?: boolean },
  ): Promise<void>;
  dropIndex(name: string): Promise<void>;
}

export interface MigrationSystemTable {
  all(): Promise<Array<Record<string, unknown>>>;
  get(id: string): Promise<Record<string, unknown> | null>;
  insert(fields: Record<string, unknown>): Promise<string>;
  patch(id: string, fields: Record<string, unknown>): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface MigrationSystem {
  table(name: string): MigrationSystemTable;
}

export interface MigrationLogger {
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
}

export interface MigrationContext {
  table: string;
  db: MigrationDb;
  schema: MigrationSchema;
  system: MigrationSystem;
  log: MigrationLogger;
}

export type MigrationStep = (ctx: MigrationContext) => Promise<void> | void;

export type MigrationsMap = Record<number, MigrationStep>;

export function targetVersionFromMigrations(migrations: MigrationsMap): number {
  const versions = Object.keys(migrations)
    .map((key) => Number(key))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (versions.length === 0) return 1;
  return Math.max(1, ...versions);
}
