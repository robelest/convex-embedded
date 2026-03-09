/**
 * Schema utilities for convex-resolve.
 *
 * Provides CRDT field type wrappers that map to Yjs data structures:
 *   - schema.prose()     → Y.XmlFragment  (character-level merge)
 *   - schema.register(v) → Y.Map          (multi-value register)
 *   - schema.counter()   → Y.Array        (append-only increments)
 *   - schema.set(v)      → Y.Map          (add-wins set)
 *   - schema.omit(v)     → remote-only    (stripped from local sync)
 *
 * Also provides schema.define() for versioned schema definitions
 * with migration history.
 */
import * as Y from "yjs";
import type { Validator } from "convex/values";
import { v } from "convex/values";
import type {
  Conflict,
  CrdtFieldDescriptor,
} from "@/shared/types";
import { CrdtType } from "@/shared/types";

// ---------------------------------------------------------------------------
// Internal: CRDT field descriptor symbol
// ---------------------------------------------------------------------------

const CRDT_FIELD = Symbol.for("convex-resolve:crdt-field");

/** Check if a value is a CRDT field descriptor. */
export function isCrdtField(value: unknown): value is CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return (
    typeof value === "object" &&
    value !== null &&
    CRDT_FIELD in value &&
    (value as any)[CRDT_FIELD] === true
  );
}

/** Extract the CRDT type from a field descriptor. */
export function getCrdtType(field: unknown): CrdtType | null {
  if (isCrdtField(field)) return field.type;
  return null;
}

// ---------------------------------------------------------------------------
// Field type constructors
// ---------------------------------------------------------------------------

export interface RegisterOptions<T> {
  /** Custom conflict resolver. If not provided, latest-timestamp wins. */
  resolve?: (conflict: Conflict<T>) => T;
}

/**
 * Rich text field — maps to Y.XmlFragment for character-level CRDT merge.
 * Use with ProseMirror or TipTap bindings.
 */
export function prose(): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Prose,
    validator: v.string(), // serialized as string for Convex storage
  };
}

/**
 * Multi-value register — maps to Y.Map<{ value, timestamp }>.
 * Concurrent writes produce a conflict. Custom resolver can pick the winner.
 */
export function register<T>(
  validator: Validator<T, any, any>,
  options?: RegisterOptions<T>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Register,
    validator,
    resolve: options?.resolve as ((conflict: Conflict<unknown>) => unknown) | undefined,
  };
}

/**
 * Counter — maps to Y.Array<{ client, delta, timestamp }>.
 * Append-only array of increments. Materialized value = sum of all deltas.
 */
export function counter(): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Counter,
    validator: v.number(),
  };
}

/**
 * Add-wins set — maps to Y.Map<{ addedBy, addedAt }>.
 * Key presence = membership. Delete key = remove. Yjs add-wins semantics.
 */
export function set<T>(
  validator: Validator<T, any, any>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Set,
    validator,
  };
}

/**
 * Marks a field as remote-only. It exists on the remote Convex backend
 * but is stripped from every payload sent to local embedded runtime.
 *
 * Only needed on registered (synced) tables. Tables without register()
 * are never synced — they stay on remote by default.
 */
export function omit<T>(
  validator: Validator<T, any, any>,
): CrdtFieldDescriptor & { [CRDT_FIELD]: true } {
  return {
    [CRDT_FIELD]: true as const,
    type: CrdtType.Omitted,
    validator,
  };
}

// ---------------------------------------------------------------------------
// schema.define() — versioned schema definition
// ---------------------------------------------------------------------------

export interface DefineOptions {
  /** Current schema version number. */
  version: number;
  /** Current field shape as a Convex validator (v.object(...)). */
  shape: Record<string, unknown>;
  /** Previous version shapes, keyed by version number. */
  history?: Record<number, Record<string, unknown>>;
  /** Default values for fields added in the current version. */
  defaults?: Record<string, unknown>;
}

export interface Definition {
  version: number;
  shape: Record<string, unknown>;
  history: Record<number, Record<string, unknown>>;
  defaults: Record<string, unknown>;
  /** Get the field descriptors for a specific version. */
  getShape(version?: number): Record<string, unknown>;
  /** Get all CRDT field names and their types for the current version. */
  getCrdtFields(): Map<string, CrdtFieldDescriptor>;
  /** Get field names that should be omitted from local sync. */
  getOmittedFields(): string[];
}

export function define(options: DefineOptions): Definition {
  const { version, shape, history = {}, defaults = {} } = options;

  return {
    version,
    shape,
    history,
    defaults,

    getShape(v?: number): Record<string, unknown> {
      if (v === undefined || v === version) return shape;
      const historyShape = history[v];
      if (!historyShape) {
        throw new Error(
          `convex-resolve: No schema shape found for version ${v}. ` +
            `Available versions: ${Object.keys(history).join(", ")}`,
        );
      }
      return historyShape;
    },

    getCrdtFields(): Map<string, CrdtFieldDescriptor> {
      const fields = new Map<string, CrdtFieldDescriptor>();
      for (const [key, value] of Object.entries(shape)) {
        if (isCrdtField(value)) {
          fields.set(key, value);
        }
      }
      return fields;
    },

    getOmittedFields(): string[] {
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

// Import and re-export createConflict from shared (defined there to avoid
// cross-boundary imports when client/ needs it)
import { createConflict } from "@/shared/conflict";
export { createConflict };

// ---------------------------------------------------------------------------
// Yjs document helpers — mapping schema fields to Yjs structures
// ---------------------------------------------------------------------------

/**
 * Initialize a Y.Doc from a document row according to the schema definition.
 * Creates the top-level Y.Map("fields") and populates each field with the
 * appropriate Yjs structure.
 */
export function initYjsDoc(
  schemaDef: Definition,
  row: Record<string, unknown>,
): Y.Doc {
  const doc = new Y.Doc();
  const fields = doc.getMap("fields");

  for (const [key, value] of Object.entries(row)) {
    // Skip internal Convex fields
    if (key === "_id" || key === "_creationTime") continue;

    const fieldDef = schemaDef.shape[key];
    const crdtType = getCrdtType(fieldDef);

    if (crdtType === CrdtType.Omitted) {
      // Omitted fields are not stored in Yjs
      continue;
    }

    if (crdtType === CrdtType.Prose) {
      // Y.XmlFragment — initialize from string content
      const xml = doc.getXmlFragment(key);
      if (typeof value === "string" && value.length > 0) {
        const text = new Y.XmlText(value);
        xml.insert(0, [text]);
      }
    } else if (crdtType === CrdtType.Register) {
      // Y.Map with { value, timestamp } entries keyed by client
      const registerMap = new Y.Map<{ value: unknown; timestamp: number }>();
      registerMap.set("_init", { value, timestamp: Date.now() });
      fields.set(key, registerMap);
    } else if (crdtType === CrdtType.Counter) {
      // Y.Array of { client, delta, timestamp }
      const counterArr = new Y.Array<{
        client: string;
        delta: number;
        timestamp: number;
      }>();
      if (typeof value === "number" && value !== 0) {
        counterArr.push([
          { client: "_init", delta: value, timestamp: Date.now() },
        ]);
      }
      fields.set(key, counterArr);
    } else if (crdtType === CrdtType.Set) {
      // Y.Map where key presence = membership
      const setMap = new Y.Map<{ addedBy: string; addedAt: number }>();
      if (Array.isArray(value)) {
        for (const item of value) {
          const serialized = typeof item === "string" ? item : JSON.stringify(item);
          setMap.set(serialized, { addedBy: "_init", addedAt: Date.now() });
        }
      }
      fields.set(key, setMap);
    } else {
      // Plain field — last-write-wins
      fields.set(key, value as any);
    }
  }

  return doc;
}

/**
 * Encode a document row as a full Yjs state snapshot (V2 encoding).
 */
export function encodeDocumentState(
  schemaDef: Definition,
  row: Record<string, unknown>,
): Uint8Array {
  const doc = initYjsDoc(schemaDef, row);
  return Y.encodeStateAsUpdateV2(doc);
}

/**
 * Compute the diff between a server document and a client's state vector.
 * Returns the minimal binary update needed to bring the client up to date.
 */
export function computeDiff(
  serverUpdate: Uint8Array,
  clientVector: Uint8Array,
): Uint8Array {
  // Create a doc from the server's full state
  const serverDoc = new Y.Doc();
  Y.applyUpdateV2(serverDoc, serverUpdate);

  // Diff against the client's state vector
  return Y.encodeStateAsUpdateV2(serverDoc, clientVector);
}

/**
 * Merge a client's update into the server document and return the merged state.
 */
export function mergeUpdate(
  serverUpdate: Uint8Array,
  clientUpdate: Uint8Array,
): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, serverUpdate);
  Y.applyUpdateV2(doc, clientUpdate);
  return Y.encodeStateAsUpdateV2(doc);
}

/**
 * Check if a diff is effectively empty (client is already up to date).
 * Yjs V2 empty updates/diffs are exactly 13 bytes:
 * [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]
 */
export function isDiffEmpty(diff: Uint8Array): boolean {
  if (diff.byteLength === 0) return true;
  if (diff.byteLength !== 13) return false;
  // V2 empty update: all zeros except byte 6 which is 1
  for (let i = 0; i < 13; i++) {
    if (i === 6) {
      if (diff[i] !== 1) return false;
    } else {
      if (diff[i] !== 0) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Re-export the schema namespace as a single object
// ---------------------------------------------------------------------------

export const schema = {
  define,
  prose,
  register,
  counter,
  set,
  omit,
  createConflict,
  isCrdtField,
  getCrdtType,
  initYjsDoc,
  encodeDocumentState,
  computeDiff,
  mergeUpdate,
  isDiffEmpty,
};
