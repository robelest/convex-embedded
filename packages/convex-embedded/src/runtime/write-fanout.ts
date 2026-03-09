/**
 * Cross-tab write notification using BroadcastChannel.
 *
 * When a mutation commits, {@link WriteFanout.notify} broadcasts the set
 * of written table names so that other tabs / workers sharing the same
 * origin can invalidate their subscriptions.
 *
 * Falls back to `localStorage` storage events when `BroadcastChannel` is
 * unavailable (e.g. older Safari, SSR environments).
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CHANNEL_NAME = "convex-embedded-writes";

// ---------------------------------------------------------------------------
// WriteFanout
// ---------------------------------------------------------------------------

export class WriteFanout {
  private _channelName: string;
  private _bc: BroadcastChannel | null = null;
  private _callbacks: Set<(tablesWritten: Set<string>) => void> = new Set();
  private _storageHandler: ((ev: StorageEvent) => void) | null = null;
  private _closed = false;

  constructor(channelName: string = DEFAULT_CHANNEL_NAME) {
    this._channelName = channelName;
    this._init();
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Broadcast that the given tables have been written to.
   */
  notify(tablesWritten: Set<string>): void {
    if (this._closed) return;

    const payload = Array.from(tablesWritten);
    if (this._bc) {
      this._bc.postMessage(payload);
    } else if (typeof localStorage !== "undefined") {
      // localStorage events only fire in *other* tabs, which is the
      // behaviour we want.  We use a timestamp key so the value always
      // changes (storage events only fire when the value changes).
      try {
        localStorage.setItem(
          this._channelName,
          JSON.stringify({ tables: payload, ts: Date.now() }),
        );
      } catch {
        // Quota exceeded or unavailable — best-effort.
      }
    }
  }

  /**
   * Register a listener that fires whenever another context (tab/worker)
   * notifies about writes.
   *
   * @returns An unsubscribe function.
   */
  onNotification(
    callback: (tablesWritten: Set<string>) => void,
  ): () => void {
    this._callbacks.add(callback);
    return () => {
      this._callbacks.delete(callback);
    };
  }

  /** Tear down the channel / event listeners. */
  close(): void {
    if (this._closed) return;
    this._closed = true;

    if (this._bc) {
      this._bc.close();
      this._bc = null;
    }

    if (this._storageHandler && typeof window !== "undefined") {
      window.removeEventListener("storage", this._storageHandler);
      this._storageHandler = null;
    }

    this._callbacks.clear();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private _init(): void {
    if (typeof BroadcastChannel !== "undefined") {
      this._bc = new BroadcastChannel(this._channelName);
      this._bc.onmessage = (ev: MessageEvent) => {
        const tables: string[] = ev.data;
        this._dispatch(new Set(tables));
      };
    } else if (typeof window !== "undefined") {
      this._storageHandler = (ev: StorageEvent) => {
        if (ev.key !== this._channelName || ev.newValue === null) return;
        try {
          const { tables } = JSON.parse(ev.newValue) as {
            tables: string[];
            ts: number;
          };
          this._dispatch(new Set(tables));
        } catch {
          // Malformed payload — ignore.
        }
      };
      window.addEventListener("storage", this._storageHandler);
    }
  }

  private _dispatch(tablesWritten: Set<string>): void {
    for (const cb of this._callbacks) {
      try {
        cb(tablesWritten);
      } catch {
        // Never let a subscriber error kill the fanout loop.
      }
    }
  }
}
