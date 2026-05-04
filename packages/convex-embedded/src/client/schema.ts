/**
 * Client-side schema helpers.
 *
 * Provides utilities for working with CRDT fields on the client:
 *   - Extract prose content as a string
 *   - Create empty states for CRDT fields
 *   - Check if a field has conflicts
 *
 * Re-exports Conflict<T> for convenience.
 */
import * as Y from "yjs";

import { proseContentToPlainText } from "@/crdt/prose/content";
import { yDocToProseContent } from "@/crdt/prose/yjs";
import { createConflict } from "@/shared/conflict";
import type { Conflict, ConflictEntry } from "@/shared/types";
import { materializeYjsDoc } from "@/shared/yjs";

export { materializeYjsDoc };

/**
 * Extract plain text content from a Yjs document's prose field.
 * Returns the text content of the Y.XmlFragment.
 */
export function extractProseText(doc: Y.Doc, fieldName: string): string {
  const collectText = (node: any): string => {
    if (node instanceof Y.XmlText) {
      return node.toString();
    }

    if (typeof node?.toArray === "function") {
      return node
        .toArray()
        .map((child: unknown) => collectText(child))
        .join("");
    }

    return "";
  };

  const fragment = doc.getXmlFragment(fieldName);
  const text = collectText(fragment).trim();
  return text.length > 0
    ? text
    : proseContentToPlainText(yDocToProseContent(doc, fieldName));
}

/**
 * Create an empty Y.Doc with the field structure for a given schema.
 * Useful for initializing a new document before any data is written.
 */
export function createEmptyDoc(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap("fields");
  return doc;
}

/**
 * Check if a register field has a conflict (multiple concurrent values).
 * Returns the Conflict object if there are multiple entries, null otherwise.
 */
export function getRegisterConflict<T>(
  doc: Y.Doc,
  fieldName: string,
): Conflict<T> | null {
  const fields = doc.getMap("fields");
  const registerMap = fields.get(fieldName);

  if (!(registerMap instanceof Y.Map)) return null;

  const entries: ConflictEntry<T>[] = [];
  registerMap.forEach((val: any, key: string) => {
    entries.push({
      value: val.value as T,
      clientId: key,
      timestamp: val.timestamp ?? 0,
    });
  });

  if (entries.length <= 1) return null;
  return createConflict(entries);
}

/**
 * Resolve a register field's value, using the custom resolver if one exists,
 * or falling back to latest-timestamp-wins.
 */
export function resolveRegister<T>(
  doc: Y.Doc,
  fieldName: string,
  resolver?: (conflict: Conflict<T>) => T,
): T | undefined {
  const fields = doc.getMap("fields");
  const registerMap = fields.get(fieldName);

  if (!(registerMap instanceof Y.Map)) return undefined;

  const entries: ConflictEntry<T>[] = [];
  registerMap.forEach((val: any, key: string) => {
    entries.push({
      value: val.value as T,
      clientId: key,
      timestamp: val.timestamp ?? 0,
    });
  });

  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0]!.value;

  const conflict = createConflict(entries);
  if (resolver) return resolver(conflict);
  return conflict.latest();
}

/**
 * Get the materialized value of a counter field (sum of all deltas).
 */
export function getCounterValue(doc: Y.Doc, fieldName: string): number {
  const fields = doc.getMap("fields");
  const counterArr = fields.get(fieldName);

  if (!(counterArr instanceof Y.Array)) return 0;

  let sum = 0;
  for (let i = 0; i < counterArr.length; i++) {
    const entry = counterArr.get(i) as any;
    if (entry && typeof entry.delta === "number") {
      sum += entry.delta;
    }
  }
  return sum;
}

/**
 * Get all members of an add-wins set field.
 */
export function getSetMembers<T = string>(doc: Y.Doc, fieldName: string): T[] {
  const fields = doc.getMap("fields");
  const setMap = fields.get(fieldName);

  if (!(setMap instanceof Y.Map)) return [];

  const members: T[] = [];
  setMap.forEach((_val: any, key: string) => {
    try {
      members.push(JSON.parse(key) as T);
    } catch {
      members.push(key as unknown as T);
    }
  });
  return members;
}

/**
 * Encode the state vector of a Y.Doc.
 * This is what the client sends to the server during resolve.
 */
export function encodeStateVector(doc: Y.Doc): Uint8Array {
  return Y.encodeStateVector(doc);
}

/**
 * Apply a binary update (diff) to a Y.Doc.
 * This is what the client does after receiving a resolve response.
 */
export function applyUpdate(doc: Y.Doc, update: Uint8Array): void {
  Y.applyUpdateV2(doc, update);
}

/**
 * Encode a Y.Doc's full state as a V2 update.
 * Used when pushing local changes to the server.
 */
export function encodeState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdateV2(doc);
}

export const clientSchema = {
  extractProseText,
  createEmptyDoc,
  getRegisterConflict,
  resolveRegister,
  getCounterValue,
  getSetMembers,
  encodeStateVector,
  applyUpdate,
  encodeState,
  materializeYjsDoc,
};
