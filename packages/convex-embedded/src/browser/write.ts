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

export function createBrowserWriteBroadcast(
  channelName: string = DEFAULT_CHANNEL_NAME,
): WriteBroadcast {
  let bc: BroadcastChannel | null = null;
  const callbacks: Set<(tablesWritten: Set<string>) => void> = new Set();
  let storageHandler: ((ev: StorageEvent) => void) | null = null;
  let closed = false;
  const senderId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `sender-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  function dispatch(tablesWritten: Set<string>): void {
    for (const cb of callbacks) {
      try {
        cb(tablesWritten);
      } catch {}
    }
  }

  if (typeof BroadcastChannel !== "undefined") {
    bc = new BroadcastChannel(channelName);
    bc.onmessage = (ev: MessageEvent<string[]>) => {
      dispatch(new Set(ev.data));
    };
  } else if (typeof window !== "undefined") {
    storageHandler = (ev: StorageEvent) => {
      if (ev.key !== channelName || ev.newValue === null) return;
      try {
        const parsed = JSON.parse(ev.newValue);
        if (isValidStoredWritePayload(parsed)) {
          dispatch(new Set(parsed.tables));
        }
      } catch {}
    };
    window.addEventListener("storage", storageHandler);
  }

  return {
    notify(tablesWritten: Set<string>): void {
      if (closed) return;
      const payload = Array.from(tablesWritten);
      if (bc) {
        bc.postMessage(payload);
      } else if (typeof localStorage !== "undefined") {
        try {
          seq += 1;
          localStorage.setItem(
            channelName,
            JSON.stringify({
              tables: payload,
              sender: senderId,
              seq,
            }),
          );
        } catch {}
      }
    },
    onNotification(callback: (tablesWritten: Set<string>) => void): () => void {
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      bc?.close();
      bc = null;
      if (storageHandler && typeof window !== "undefined") {
        window.removeEventListener("storage", storageHandler);
        storageHandler = null;
      }
      callbacks.clear();
    },
  };
}
