import { dependencyOverlapsChanges } from "@/replication/invalidation";
import { evaluateFieldPath, evaluateValue } from "@/runtime/db/fieldpath";
import type { QueryDependency, StoredDocument } from "@/runtime/db/types";
import { stableValueKey } from "@/shared/valuekey";
import { recordCounter } from "@/tracing/metrics";
import { withSpanSync } from "@/tracing/spans";

type ProtocolChangeLike = {
  tableName: string;
  before: StoredDocument | null;
  after: StoredDocument | null;
};

interface Subscription {
  tables: Set<string>;
  dependencies: QueryDependency[];
  callback: () => void;
}

type IndexRangeEqDependency = {
  tableName: string;
  fieldPath: string;
  valueKey: string;
};

function hasPreciseChange(change: ProtocolChangeLike): boolean {
  return change.before !== null || change.after !== null;
}

function getIndexRangeEqDependencies(
  dependencies: QueryDependency[],
): IndexRangeEqDependency[] {
  return dependencies.flatMap((dependency) => {
    if (dependency.type !== "IndexRange") {
      return [];
    }

    return dependency.range
      .filter((filter) => filter.type === "Eq")
      .map((filter) => ({
        tableName: dependency.tableName,
        fieldPath: filter.fieldPath,
        valueKey: stableValueKey(evaluateValue(filter.value)),
      }));
  });
}

/**
 * Manages reactive query invalidation.
 *
 * Each subscription is keyed by a unique `queryToken` and maps to a set of
 * table names the query reads from and optional query dependencies. When a
 * mutation commits writes, {@link invalidate} fires callbacks whose tracked
 * dependencies or tables overlap the change set.
 */
export class SubscriptionManager {
  private _subscriptions: Map<string, Subscription> = new Map();
  private _subscriptionsByTable: Map<string, Set<string>> = new Map();
  private _tableFallbackSubscriptionsByTable: Map<string, Set<string>> =
    new Map();
  private _subscriptionsByIndexRangeEq: Map<
    string,
    Map<string, Map<string, Set<string>>>
  > = new Map();
  private _indexRangeBroadSubscriptionsByTable: Map<string, Set<string>> =
    new Map();

  /**
   * Register a subscription.
   *
   * @param queryToken  Unique identifier for this query subscription.
   * @param tables      Set of table names this query reads from.
   * @param callback    Invoked when any of `tables` is written to.
   * @returns An unsubscribe function that removes this subscription.
   */
  subscribe(
    queryToken: string,
    tables: Set<string>,
    dependencies: QueryDependency[] | (() => void),
    callback?: () => void,
  ): () => void {
    const resolvedDependencies = Array.isArray(dependencies)
      ? dependencies
      : [];
    const resolvedCallback =
      typeof dependencies === "function" ? dependencies : callback;
    if (!resolvedCallback) {
      throw new Error("Subscription callback is required.");
    }

    this._subscriptions.set(queryToken, {
      tables,
      dependencies: resolvedDependencies,
      callback: resolvedCallback,
    });
    for (const table of tables) {
      let tokens = this._subscriptionsByTable.get(table);
      if (!tokens) {
        tokens = new Set();
        this._subscriptionsByTable.set(table, tokens);
      }
      tokens.add(queryToken);

      if (resolvedDependencies.length === 0) {
        let fallbackTokens = this._tableFallbackSubscriptionsByTable.get(table);
        if (!fallbackTokens) {
          fallbackTokens = new Set();
          this._tableFallbackSubscriptionsByTable.set(table, fallbackTokens);
        }
        fallbackTokens.add(queryToken);
      }
    }
    const eqDependencies = getIndexRangeEqDependencies(resolvedDependencies);
    for (const dependency of eqDependencies) {
      let fieldMap = this._subscriptionsByIndexRangeEq.get(
        dependency.tableName,
      );
      if (!fieldMap) {
        fieldMap = new Map();
        this._subscriptionsByIndexRangeEq.set(dependency.tableName, fieldMap);
      }
      let valueMap = fieldMap.get(dependency.fieldPath);
      if (!valueMap) {
        valueMap = new Map();
        fieldMap.set(dependency.fieldPath, valueMap);
      }
      let tokens = valueMap.get(dependency.valueKey);
      if (!tokens) {
        tokens = new Set();
        valueMap.set(dependency.valueKey, tokens);
      }
      tokens.add(queryToken);
    }
    for (const dependency of resolvedDependencies) {
      if (
        dependency.type !== "IndexRange" ||
        dependency.range.length === 0 ||
        dependency.range.some((filter) => filter.type !== "Eq")
      ) {
        let tokens = this._indexRangeBroadSubscriptionsByTable.get(
          dependency.tableName,
        );
        if (!tokens) {
          tokens = new Set();
          this._indexRangeBroadSubscriptionsByTable.set(
            dependency.tableName,
            tokens,
          );
        }
        tokens.add(queryToken);
      }
    }
    return () => {
      this._unsubscribe(queryToken);
    };
  }

  /**
   * Update the tracked dependencies for an existing subscription.
   */
  update(
    queryToken: string,
    tables: Set<string>,
    dependencies: QueryDependency[],
    callback: () => void,
  ): () => void {
    this._unsubscribe(queryToken);
    return this.subscribe(queryToken, tables, dependencies, callback);
  }

  /**
   * Invalidate all subscriptions that overlap with the given writes. Called
   * after a mutation commits.
   */
  invalidate(changesOrTables: Set<string> | ProtocolChangeLike[]): void {
    withSpanSync("convex-embedded.sync.invalidate", () => {
      recordCounter("invalidation");
      const { candidateTokens, changes, tablesWritten } =
        this._gatherRelevantSubscriptions(changesOrTables);

      for (const token of candidateTokens) {
        const sub = this._subscriptions.get(token);
        if (!sub) {
          continue;
        }
        const overlaps =
          changes !== null && sub.dependencies.length > 0
            ? sub.dependencies.some((dependency) =>
                dependencyOverlapsChanges(dependency, changes),
              )
            : [...sub.tables].some((table) => tablesWritten.has(table));

        if (overlaps) {
          sub.callback();
        }
      }
    });
  }

  gatherRelevantTokens(
    changesOrTables: Set<string> | ProtocolChangeLike[],
  ): Set<string> {
    const { candidateTokens, changes, tablesWritten } =
      this._gatherRelevantSubscriptions(changesOrTables);
    const relevantTokens = new Set<string>();

    for (const token of candidateTokens) {
      const sub = this._subscriptions.get(token);
      if (!sub) {
        continue;
      }
      const overlaps =
        changes !== null && sub.dependencies.length > 0
          ? sub.dependencies.some((dependency) =>
              dependencyOverlapsChanges(dependency, changes),
            )
          : [...sub.tables].some((table) => tablesWritten.has(table));

      if (overlaps) {
        relevantTokens.add(token);
      }
    }

    return relevantTokens;
  }

  private _gatherRelevantSubscriptions(
    changesOrTables: Set<string> | ProtocolChangeLike[],
  ): {
    candidateTokens: Set<string>;
    changes: ProtocolChangeLike[] | null;
    tablesWritten: Set<string>;
  } {
    const changes = Array.isArray(changesOrTables) ? changesOrTables : null;
    const tablesWritten = Array.isArray(changesOrTables)
      ? new Set(changesOrTables.map((change) => change.tableName))
      : changesOrTables;

    const candidateTokens = new Set<string>();
    if (changes !== null) {
      for (const table of tablesWritten) {
        if (
          changes.some(
            (change) => change.tableName === table && !hasPreciseChange(change),
          )
        ) {
          for (const token of this._subscriptionsByTable.get(table) ?? []) {
            candidateTokens.add(token);
          }
        }
        for (const token of this._tableFallbackSubscriptionsByTable.get(
          table,
        ) ?? []) {
          candidateTokens.add(token);
        }
        for (const token of this._indexRangeBroadSubscriptionsByTable.get(
          table,
        ) ?? []) {
          candidateTokens.add(token);
        }
      }
      for (const change of changes) {
        const fieldMap = this._subscriptionsByIndexRangeEq.get(
          change.tableName,
        );
        if (!fieldMap) continue;
        for (const [fieldPath, valueMap] of fieldMap) {
          for (const doc of [change.before, change.after]) {
            if (doc === null) continue;
            const valueKey = stableValueKey(evaluateFieldPath(fieldPath, doc));
            for (const token of valueMap.get(valueKey) ?? []) {
              candidateTokens.add(token);
            }
          }
        }
      }
    } else {
      for (const table of tablesWritten) {
        for (const token of this._subscriptionsByTable.get(table) ?? []) {
          candidateTokens.add(token);
        }
      }
    }

    return { candidateTokens, changes, tablesWritten };
  }

  /** Remove all subscriptions. */
  clear(): void {
    this._subscriptions.clear();
    this._subscriptionsByTable.clear();
    this._tableFallbackSubscriptionsByTable.clear();
    this._subscriptionsByIndexRangeEq.clear();
    this._indexRangeBroadSubscriptionsByTable.clear();
  }

  private _unsubscribe(queryToken: string): void {
    const existing = this._subscriptions.get(queryToken);
    if (!existing) return;
    this._subscriptions.delete(queryToken);
    for (const table of existing.tables) {
      const tokens = this._subscriptionsByTable.get(table);
      if (!tokens) continue;
      tokens.delete(queryToken);
      if (tokens.size === 0) this._subscriptionsByTable.delete(table);

      const fallback = this._tableFallbackSubscriptionsByTable.get(table);
      if (fallback) {
        fallback.delete(queryToken);
        if (fallback.size === 0)
          this._tableFallbackSubscriptionsByTable.delete(table);
      }
    }
    for (const dependency of getIndexRangeEqDependencies(
      existing.dependencies,
    )) {
      const fieldMap = this._subscriptionsByIndexRangeEq.get(
        dependency.tableName,
      );
      const valueMap = fieldMap?.get(dependency.fieldPath);
      const tokens = valueMap?.get(dependency.valueKey);
      if (!fieldMap || !valueMap || !tokens) continue;
      tokens.delete(queryToken);
      if (tokens.size === 0) valueMap.delete(dependency.valueKey);
      if (valueMap.size === 0) fieldMap.delete(dependency.fieldPath);
      if (fieldMap.size === 0)
        this._subscriptionsByIndexRangeEq.delete(dependency.tableName);
    }
    for (const dependency of existing.dependencies) {
      if (
        dependency.type !== "IndexRange" ||
        dependency.range.length === 0 ||
        dependency.range.some((filter) => filter.type !== "Eq")
      ) {
        const tokens = this._indexRangeBroadSubscriptionsByTable.get(
          dependency.tableName,
        );
        if (!tokens) continue;
        tokens.delete(queryToken);
        if (tokens.size === 0)
          this._indexRangeBroadSubscriptionsByTable.delete(
            dependency.tableName,
          );
      }
    }
  }
}
