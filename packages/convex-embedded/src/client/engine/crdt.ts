import { getCrdtType } from "@/shared/schema";

interface TableSchemaCarrier {
  schema?: {
    getShape?: () => Record<string, unknown> | undefined;
  };
}

/**
 * Tracks which user tables have CRDT-typed fields and which `(table, docId)`
 * pairs need a CRDT merge pass.
 *
 * Marked rows accumulate while the engine is offline (or otherwise unable
 * to push) and drain during `mergeDirtyCrdtRows` after reconnect. The
 * grouping helper produces a per-table view in the engine's canonical
 * apply order so the merge loop can walk it directly.
 */
export class CrdtDirtyState {
  private readonly dirtyRows = new Set<string>();
  private readonly crdtFieldsByTable = new Map<string, Set<string>>();

  constructor(tables: Record<string, TableSchemaCarrier>) {
    for (const [tableName, tableConfig] of Object.entries(tables)) {
      const shape = tableConfig.schema?.getShape?.();
      if (!shape) continue;
      const crdtFields = new Set<string>();
      for (const [fieldName, fieldDef] of Object.entries(shape)) {
        if (getCrdtType(fieldDef) !== null) {
          crdtFields.add(fieldName);
        }
      }
      if (crdtFields.size > 0) {
        this.crdtFieldsByTable.set(tableName, crdtFields);
      }
    }
  }

  shouldTrack(tableName: string): boolean {
    return this.crdtFieldsByTable.has(tableName);
  }

  mark(tableName: string, docId: string): void {
    if (!this.crdtFieldsByTable.has(tableName)) return;
    this.dirtyRows.add(`${tableName}:${docId}`);
  }

  clear(tableName: string, docId: string): void {
    this.dirtyRows.delete(`${tableName}:${docId}`);
  }

  clearAll(): void {
    this.dirtyRows.clear();
  }

  hasDirty(): boolean {
    return this.dirtyRows.size > 0;
  }

  size(): number {
    return this.dirtyRows.size;
  }

  /**
   * Group dirty rows by their owning table, filtered + ordered by the
   * caller's canonical table apply order. Skips tables that don't
   * declare CRDT fields (defensive — entries should only ever be added
   * via `mark`).
   */
  iterateGrouped(orderedTables: string[]): Array<{
    tableName: string;
    docIds: Set<string>;
  }> {
    const rowsByTable = new Map<string, Set<string>>();
    for (const key of this.dirtyRows) {
      const sep = key.indexOf(":");
      if (sep < 0) continue;
      const tableName = key.slice(0, sep);
      const docId = key.slice(sep + 1);
      if (!this.crdtFieldsByTable.has(tableName)) continue;
      const set = rowsByTable.get(tableName) ?? new Set<string>();
      set.add(docId);
      rowsByTable.set(tableName, set);
    }
    return orderedTables.flatMap((tableName) => {
      const docIds = rowsByTable.get(tableName);
      return docIds && docIds.size > 0 ? [{ tableName, docIds }] : [];
    });
  }
}
