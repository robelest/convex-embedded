/**
 * Table-level subscription invalidation system.
 *
 * Tracks which query subscriptions depend on which tables, and fires
 * callbacks when mutations write to those tables so that stale queries
 * can be re-evaluated.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Subscription {
  tables: Set<string>;
  callback: () => void;
}

// ---------------------------------------------------------------------------
// SubscriptionManager
// ---------------------------------------------------------------------------

/**
 * Manages table-level subscriptions for reactive query invalidation.
 *
 * Each subscription is keyed by a unique `queryToken` and maps to a set of
 * table names the query reads from. When a mutation commits writes to one or
 * more tables, {@link invalidate} fires every callback whose table set
 * overlaps with the written tables.
 */
export class SubscriptionManager {
  private _subscriptions: Map<string, Subscription> = new Map();

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
    callback: () => void,
  ): () => void {
    this._subscriptions.set(queryToken, { tables, callback });
    return () => {
      this._subscriptions.delete(queryToken);
    };
  }

  /**
   * Invalidate all subscriptions that overlap with the given set of written
   * tables. Called after a mutation commits.
   */
  invalidate(tablesWritten: Set<string>): void {
    for (const sub of this._subscriptions.values()) {
      for (const table of sub.tables) {
        if (tablesWritten.has(table)) {
          sub.callback();
          break; // fire at most once per subscription
        }
      }
    }
  }

  /** Remove all subscriptions. */
  clear(): void {
    this._subscriptions.clear();
  }
}
