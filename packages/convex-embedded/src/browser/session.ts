import type { SessionBroadcast, SessionEvent } from "@/runtime/platform";
import { createDisposableScope } from "@/utils/scope";

const DEFAULT_CHANNEL_NAME = "convex-embedded-session";

function isValidSessionEvent(value: unknown): value is { type: "authChanged" } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: unknown }).type === "authChanged"
  );
}

function isValidStoredSessionPayload(
  value: unknown,
): value is { event: SessionEvent; sender: string; seq: number } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    isValidSessionEvent(obj.event) &&
    typeof obj.sender === "string" &&
    typeof obj.seq === "number"
  );
}

export class BrowserSessionBroadcast implements SessionBroadcast {
  private _channelName: string;
  private _bc: BroadcastChannel | null = null;
  private _callbacks: Set<(event: SessionEvent) => void> = new Set();
  private _storageHandler: ((ev: StorageEvent) => void) | null = null;
  private _closed = false;
  private _scope = createDisposableScope();
  private _senderId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `sender-${Math.random().toString(36).slice(2)}`;
  private _seq = 0;

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
        this._seq += 1;
        localStorage.setItem(
          this._channelName,
          JSON.stringify({ event, sender: this._senderId, seq: this._seq }),
        );
      } catch {}
    }
  }

  onNotification(callback: (event: SessionEvent) => void): () => void {
    this._callbacks.add(callback);
    return () => this._callbacks.delete(callback);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    void this._scope.close();
    this._callbacks.clear();
  }

  private _init(): void {
    if (typeof BroadcastChannel !== "undefined") {
      this._bc = new BroadcastChannel(this._channelName);
      this._bc.onmessage = (ev: MessageEvent<SessionEvent>) => {
        this._dispatch(ev.data);
      };
      this._scope.addFinalizer(() => {
        this._bc?.close();
        this._bc = null;
      });
      return;
    }

    if (typeof window !== "undefined") {
      this._storageHandler = (ev: StorageEvent) => {
        if (ev.key !== this._channelName || ev.newValue === null) return;
        try {
          const parsed = JSON.parse(ev.newValue);
          if (isValidStoredSessionPayload(parsed)) {
            this._dispatch(parsed.event);
          }
        } catch {}
      };
      window.addEventListener("storage", this._storageHandler);
      this._scope.addFinalizer(() => {
        if (this._storageHandler && typeof window !== "undefined") {
          window.removeEventListener("storage", this._storageHandler);
          this._storageHandler = null;
        }
      });
    }
  }

  private _dispatch(event: SessionEvent): void {
    for (const callback of this._callbacks) {
      try {
        callback(event);
      } catch {}
    }
  }
}
