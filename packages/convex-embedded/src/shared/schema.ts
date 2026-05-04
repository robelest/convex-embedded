import type {
  MigrationsMap,
  MigrationStep,
} from "@/shared/migrations/types";
import { targetVersionFromMigrations } from "@/shared/migrations/types";
import type { CrdtFieldDescriptor } from "@/shared/types";
import { CrdtType } from "@/shared/types";

const CRDT_FIELD = Symbol.for("convex-embedded:crdt-field");

export function isCrdtField(
  value: unknown,
): value is CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    CRDT_FIELD in value &&
    (value as any)[CRDT_FIELD] === true
  );
}

export function getCrdtType(field: unknown): CrdtType | null {
  if (isCrdtField(field)) return field.type;
  return null;
}

/** @deprecated Re-exported for transitional uses; prefer `MigrationStep`. */
export type LocalTableMigrationStep = MigrationStep;

export interface DefineOptions {
  shape: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  migrations?: MigrationsMap;
}

export interface Definition {
  version: number;
  shape: Record<string, unknown>;
  defaults: Record<string, unknown>;
  migrations: MigrationsMap;
  getShape(): Record<string, unknown>;
  getCrdtFields(): Map<string, CrdtFieldDescriptor>;
  getOmittedFields(): string[];
}

export function define(options: DefineOptions): Definition {
  const { shape, defaults = {}, migrations = {} } = options;
  const version = targetVersionFromMigrations(migrations);

  return {
    version,
    shape,
    defaults,
    migrations,
    getShape() {
      return shape;
    },
    getCrdtFields() {
      const fields = new Map<string, CrdtFieldDescriptor>();
      for (const [key, value] of Object.entries(shape)) {
        if (isCrdtField(value)) {
          fields.set(key, value);
        }
      }
      return fields;
    },
    getOmittedFields() {
      const omitted: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        if (isCrdtField(value) && value.type === CrdtType.Omitted) {
          omitted.push(key);
        }
      }
      return omitted;
    },
  };
}

