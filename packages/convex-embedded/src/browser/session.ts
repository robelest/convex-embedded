import type { SessionBroadcast, SessionEvent } from "@/runtime/platform";

const DEFAULT_CHANNEL_NAME = "convex-embedded-session";

export class BrowserSessionBroadcast implements SessionBroadcast {
  private _channelName: string;
  private _bc: BroadcastChannel | null = null;
  private _callbacks: Set<(event: SessionEvent) => void> = new Set();
  private _storageHandler: ((ev: StorageEvent) => void) | null = null;
  private _closed = false;

  constructor(channelName: string = DEFAULT_CHANNEL_NAME) {
    this._channelName = channelName;
    this._init();
  }

  notify(event: SessionEvent): void {
    if (this._closed) return;

    if (this._bc) {
      this._bc.postMessage(event);
    } else if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(
          this._channelName,
          JSON.stringify({ event, ts: Date.now() }),
        );
      } catch {
        // best-effort only
      }
    }
  }

  onNotification(callback: (event: SessionEvent) => void): () => void {
    this._callbacks.add(callback);
    return () => this._callbacks.delete(callback);
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
      this._bc.onmessage = (ev: MessageEvent<SessionEvent>) => {
        this._dispatch(ev.data);
      };
      return;
    }

    if (typeof window !== "undefined") {
      this._storageHandler = (ev: StorageEvent) => {
        if (ev.key !== this._channelName || ev.newValue === null) return;
        try {
          const payload = JSON.parse(ev.newValue) as { event: SessionEvent };
          this._dispatch(payload.event);
        } catch {
          // ignore malformed payload
        }
      };
      window.addEventListener("storage", this._storageHandler);
    }
  }

  private _dispatch(event: SessionEvent): void {
    for (const callback of this._callbacks) {
      try {
        callback(event);
      } catch {
        // keep fanout alive
      }
    }
  }
}
