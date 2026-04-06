import * as Y from "yjs";

import { normalizeProseContent } from "@/crdt/prose-lite";
import { proseContentToYDoc } from "@/crdt/prose-yjs";
import type { Definition } from "@/shared/schema";
import { getCrdtType } from "@/shared/schema";
import { CrdtType } from "@/shared/types";

export function initYjsDoc(
  schemaDef: Definition,
  row: Record<string, unknown>,
): Y.Doc {
  const doc = new Y.Doc();
  const fields = doc.getMap("fields");

  for (const [key, value] of Object.entries(row)) {
    if (key === "_id" || key === "_creationTime") continue;
    const fieldDef = schemaDef.shape[key];
    const crdtType = getCrdtType(fieldDef);

    if (crdtType === CrdtType.Omitted) continue;

    if (crdtType === CrdtType.Prose) {
      const seeded = proseContentToYDoc(normalizeProseContent(value), key);
      Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(seeded));
      seeded.destroy();
    } else if (crdtType === CrdtType.Register) {
      const registerMap = new Y.Map<{ value: unknown; timestamp: number }>();
      registerMap.set("_init", { value, timestamp: Date.now() });
      fields.set(key, registerMap);
    } else if (crdtType === CrdtType.Counter) {
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
      const setMap = new Y.Map<{ addedBy: string; addedAt: number }>();
      if (Array.isArray(value)) {
        for (const item of value) {
          const serialized =
            typeof item === "string" ? item : JSON.stringify(item);
          setMap.set(serialized, { addedBy: "_init", addedAt: Date.now() });
        }
      }
      fields.set(key, setMap);
    } else {
      fields.set(key, value as any);
    }
  }

  return doc;
}

export function encodeDocumentState(
  schemaDef: Definition,
  row: Record<string, unknown>,
): Uint8Array {
  const doc = initYjsDoc(schemaDef, row);
  return Y.encodeStateAsUpdateV2(doc);
}

/**
 * Compute the incremental diff between a full update and a client's state vector.
 *
 * @remarks Uses `Y.diffUpdateV2` which is not part of Yjs's documented public API
 * but is stable and avoids creating a temporary Y.Doc just to compute a diff.
 */
export function computeDiff(
  serverUpdate: Uint8Array,
  clientVector: Uint8Array,
): Uint8Array {
  return Y.diffUpdateV2(serverUpdate, clientVector);
}

export function mergeUpdate(...updates: Uint8Array[]): Uint8Array {
  return Y.mergeUpdatesV2(updates);
}

/**
 * Check whether a Yjs V2 update is empty (contains no actual operations).
 *
 * The magic byte sequence is the encoding of an empty Yjs V2 update:
 * `{structs: [], ds: {clients: []}}` — 13 zero-ish bytes produced by
 * `Y.encodeStateAsUpdateV2(new Y.Doc())`.
 */
export function isDiffEmpty(update: Uint8Array): boolean {
  const EMPTY_YJS_V2_UPDATE = [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];

  return (
    update.byteLength === 0 ||
    (update.byteLength === EMPTY_YJS_V2_UPDATE.length &&
      update.every((value, index) => EMPTY_YJS_V2_UPDATE[index] === value))
  );
}
