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
 * mutation commits writes, {@link SubscriptionManager.invalidate} fires
 * callbacks whose tracked dependencies or tables overlap the change set.
 */
export interface SubscriptionManager {
  subscribe(
    queryToken: string,
    tables: Set<string>,
    dependencies: QueryDependency[] | (() => void),
    callback?: () => void,
  ): () => void;
  update(
    queryToken: string,
    tables: Set<string>,
    dependencies: QueryDependency[],
    callback: () => void,
  ): () => void;
  invalidate(changesOrTables: Set<string> | ProtocolChangeLike[]): void;
  gatherRelevantTokens(
    changesOrTables: Set<string> | ProtocolChangeLike[],
  ): Set<string>;
  clear(): void;
}

export function createSubscriptionManager(): SubscriptionManager {
  const subscriptions = new Map<string, Subscription>();
  const subscriptionsByTable = new Map<string, Set<string>>();
  const tableFallbackSubscriptionsByTable = new Map<string, Set<string>>();
  const subscriptionsByIndexRangeEq = new Map<
    string,
    Map<string, Map<string, Set<string>>>
  >();
  const indexRangeBroadSubscriptionsByTable = new Map<string, Set<string>>();

  function gatherRelevantSubscriptions(
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
          for (const token of subscriptionsByTable.get(table) ?? []) {
            candidateTokens.add(token);
          }
        }
        for (const token of tableFallbackSubscriptionsByTable.get(table) ??
          []) {
          candidateTokens.add(token);
        }
        for (const token of indexRangeBroadSubscriptionsByTable.get(table) ??
          []) {
          candidateTokens.add(token);
        }
      }
      for (const change of changes) {
        const fieldMap = subscriptionsByIndexRangeEq.get(change.tableName);
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
        for (const token of subscriptionsByTable.get(table) ?? []) {
          candidateTokens.add(token);
        }
      }
    }

    return { candidateTokens, changes, tablesWritten };
  }

  function removeTokenFromTableIndex(
    index: Map<string, Set<string>>,
    table: string,
    queryToken: string,
  ): void {
    const tokens = index.get(table);
    if (!tokens) return;
    tokens.delete(queryToken);
    if (tokens.size === 0) index.delete(table);
  }

  function removeTokenFromAllIndexes(
    queryToken: string,
    existing: Subscription,
  ): void {
    for (const table of existing.tables) {
      removeTokenFromTableIndex(subscriptionsByTable, table, queryToken);
      removeTokenFromTableIndex(
        tableFallbackSubscriptionsByTable,
        table,
        queryToken,
      );
    }
    for (const dependency of getIndexRangeEqDependencies(
      existing.dependencies,
    )) {
      const fieldMap = subscriptionsByIndexRangeEq.get(dependency.tableName);
      const valueMap = fieldMap?.get(dependency.fieldPath);
      const tokens = valueMap?.get(dependency.valueKey);
      if (!fieldMap || !valueMap || !tokens) continue;
      tokens.delete(queryToken);
      if (tokens.size === 0) valueMap.delete(dependency.valueKey);
      if (valueMap.size === 0) fieldMap.delete(dependency.fieldPath);
      if (fieldMap.size === 0)
        subscriptionsByIndexRangeEq.delete(dependency.tableName);
    }
    for (const dependency of existing.dependencies) {
      if (
        dependency.type !== "IndexRange" ||
        dependency.range.length === 0 ||
        dependency.range.some((filter) => filter.type !== "Eq")
      ) {
        removeTokenFromTableIndex(
          indexRangeBroadSubscriptionsByTable,
          dependency.tableName,
          queryToken,
        );
      }
    }
  }

  function unsubscribe(queryToken: string): void {
    const existing = subscriptions.get(queryToken);
    if (!existing) return;
    subscriptions.delete(queryToken);
    removeTokenFromAllIndexes(queryToken, existing);
  }

  function subscribe(
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

    subscriptions.set(queryToken, {
      tables,
      dependencies: resolvedDependencies,
      callback: resolvedCallback,
    });
    for (const table of tables) {
      let tokens = subscriptionsByTable.get(table);
      if (!tokens) {
        tokens = new Set();
        subscriptionsByTable.set(table, tokens);
      }
      tokens.add(queryToken);

      if (resolvedDependencies.length === 0) {
        let fallbackTokens = tableFallbackSubscriptionsByTable.get(table);
        if (!fallbackTokens) {
          fallbackTokens = new Set();
          tableFallbackSubscriptionsByTable.set(table, fallbackTokens);
        }
        fallbackTokens.add(queryToken);
      }
    }
    const eqDependencies = getIndexRangeEqDependencies(resolvedDependencies);
    for (const dependency of eqDependencies) {
      let fieldMap = subscriptionsByIndexRangeEq.get(dependency.tableName);
      if (!fieldMap) {
        fieldMap = new Map();
        subscriptionsByIndexRangeEq.set(dependency.tableName, fieldMap);
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
        let tokens = indexRangeBroadSubscriptionsByTable.get(
          dependency.tableName,
        );
        if (!tokens) {
          tokens = new Set();
          indexRangeBroadSubscriptionsByTable.set(
            dependency.tableName,
            tokens,
          );
        }
        tokens.add(queryToken);
      }
    }
    return () => {
      unsubscribe(queryToken);
    };
  }

  return {
    subscribe,
    update(
      queryToken: string,
      tables: Set<string>,
      dependencies: QueryDependency[],
      callback: () => void,
    ): () => void {
      unsubscribe(queryToken);
      return subscribe(queryToken, tables, dependencies, callback);
    },
    invalidate(changesOrTables: Set<string> | ProtocolChangeLike[]): void {
      withSpanSync("convex-embedded.sync.invalidate", () => {
        recordCounter("invalidation");
        const { candidateTokens, changes, tablesWritten } =
          gatherRelevantSubscriptions(changesOrTables);

        for (const token of candidateTokens) {
          const sub = subscriptions.get(token);
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
    },
    gatherRelevantTokens(
      changesOrTables: Set<string> | ProtocolChangeLike[],
    ): Set<string> {
      const { candidateTokens, changes, tablesWritten } =
        gatherRelevantSubscriptions(changesOrTables);
      const relevantTokens = new Set<string>();

      for (const token of candidateTokens) {
        const sub = subscriptions.get(token);
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
    },
    clear(): void {
      subscriptions.clear();
      subscriptionsByTable.clear();
      tableFallbackSubscriptionsByTable.clear();
      subscriptionsByIndexRangeEq.clear();
      indexRangeBroadSubscriptionsByTable.clear();
    },
  };
}
