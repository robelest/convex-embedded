import type { WriteBroadcast } from "@/runtime/platform";

const DEFAULT_CHANNEL_NAME = "convex-embedded-writes";

function isValidStoredWritePayload(
  value: unknown,
): value is { tables: string[]; sender: string; seq: number } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    Array.isArray(obj.tables) &&
    obj.tables.every((t: unknown) => typeof t === "string") &&
    typeof obj.sender === "string" &&
    typeof obj.seq === "number"
  );
}

export class BrowserWriteBroadcast implements WriteBroadcast {
  private _channelName: string;
  private _bc: BroadcastChannel | null = null;
  private _callbacks: Set<(tablesWritten: Set<string>) => void> = new Set();
  private _storageHandler: ((ev: StorageEvent) => void) | null = null;
  private _closed = false;
  private _senderId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `sender-${Math.random().toString(36).slice(2)}`;
  private _seq = 0;

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
        this._seq += 1;
        localStorage.setItem(
          this._channelName,
          JSON.stringify({
            tables: payload,
            sender: this._senderId,
            seq: this._seq,
          }),
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
          const parsed = JSON.parse(ev.newValue);
          if (isValidStoredWritePayload(parsed)) {
            this._dispatch(new Set(parsed.tables));
          }
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
