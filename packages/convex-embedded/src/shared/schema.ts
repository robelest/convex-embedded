/**
 * Core schema utilities — field detection, definition builder, and Yjs bridge.
 *
 * Consolidates former schema-core.ts + schema-utils.ts into a single module.
 */

import type { CrdtFieldDescriptor } from "@/shared/types";
import { CrdtType } from "@/shared/types";

// ---------------------------------------------------------------------------
// Field detection (was schema-core.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Definition builder (was schema-core.ts)
// ---------------------------------------------------------------------------

export type LocalTableMigrationStep = (ctx: {
  table: string;
  fromVersion: number;
  toVersion: number;
  targetVersion: number;
  schema: Definition;
  docs: {
    all(): Promise<Array<Record<string, unknown>>>;
    patchMissing(fields: Record<string, unknown>): Promise<number>;
    patch(id: unknown, fields: Record<string, unknown>): Promise<void>;
    replace(id: unknown, fields: Record<string, unknown>): Promise<void>;
    delete(id: unknown): Promise<void>;
    modify(
      transform: (
        doc: Record<string, unknown>,
      ) =>
        | Record<string, unknown>
        | null
        | void
        | Promise<Record<string, unknown> | null | void>,
    ): Promise<number>;
  };
}) => Promise<void> | void;

export interface DefineOptions {
  version: number;
  shape: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  migrate?: Record<number, LocalTableMigrationStep>;
}

export interface Definition {
  version: number;
  shape: Record<string, unknown>;
  defaults: Record<string, unknown>;
  migrate: Record<number, LocalTableMigrationStep>;
  getShape(): Record<string, unknown>;
  getCrdtFields(): Map<string, CrdtFieldDescriptor>;
  getOmittedFields(): string[];
}

export function define(options: DefineOptions): Definition {
  const { version, shape, defaults = {}, migrate = {} } = options;

  return {
    version,
    shape,
    defaults,
    migrate,
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

// ---------------------------------------------------------------------------
// Yjs bridge re-exports (was schema-utils.ts)
// ---------------------------------------------------------------------------

export {
  computeDiff,
  encodeDocumentState,
  initYjsDoc,
  isDiffEmpty,
  mergeUpdate,
} from "@/shared/schema-yjs";
