import type { WriteBroadcast } from "@/runtime/platform";

const DEFAULT_CHANNEL_NAME = "convex-embedded-writes";

export class BrowserWriteBroadcast implements WriteBroadcast {
  private _channelName: string;
  private _bc: BroadcastChannel | null = null;
  private _callbacks: Set<(tablesWritten: Set<string>) => void> = new Set();
  private _storageHandler: ((ev: StorageEvent) => void) | null = null;
  private _closed = false;

  constructor(channelName: string = DEFAULT_CHANNEL_NAME) {
    this._channelName = channelName;
    this._init();
  }

  notify(tablesWritten: Set<string>): void {
    if (this._closed) return;

    const payload = Array.from(tablesWritten);
    if (this._bc) {
      this._bc.postMessage(payload);
    } else if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(
          this._channelName,
          JSON.stringify({ tables: payload, ts: Date.now() }),
        );
      } catch {
        // best-effort
      }
    }
  }

  onNotification(callback: (tablesWritten: Set<string>) => void): () => void {
    this._callbacks.add(callback);
    return () => {
      this._callbacks.delete(callback);
    };
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._bc?.close();
    this._bc = null;
    if (this._storageHandler && typeof window !== "undefined") {
      window.removeEventListener("storage", this._storageHandler);
      this._storageHandler = null;
    }
    this._callbacks.clear();
  }

  private _init(): void {
    if (typeof BroadcastChannel !== "undefined") {
      this._bc = new BroadcastChannel(this._channelName);
      this._bc.onmessage = (ev: MessageEvent<string[]>) => {
        this._dispatch(new Set(ev.data));
      };
      return;
    }

    if (typeof window !== "undefined") {
      this._storageHandler = (ev: StorageEvent) => {
        if (ev.key !== this._channelName || ev.newValue === null) return;
        try {
          const { tables } = JSON.parse(ev.newValue) as {
            tables: string[];
            ts: number;
          };
          this._dispatch(new Set(tables));
        } catch {
          // malformed payload
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
        // keep loop alive
      }
    }
  }
}
