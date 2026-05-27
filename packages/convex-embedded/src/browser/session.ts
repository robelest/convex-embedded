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

export function createBrowserSessionBroadcast(
  channelName: string = DEFAULT_CHANNEL_NAME,
): SessionBroadcast {
  let bc: BroadcastChannel | null = null;
  const callbacks: Set<(event: SessionEvent) => void> = new Set();
  let storageHandler: ((ev: StorageEvent) => void) | null = null;
  let closed = false;
  const scope = createDisposableScope();
  const senderId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `sender-${Math.random().toString(36).slice(2)}`;
  let seq = 0;

  function dispatch(event: SessionEvent): void {
    for (const callback of callbacks) {
      try {
        callback(event);
      } catch {}
    }
  }

  if (typeof BroadcastChannel !== "undefined") {
    bc = new BroadcastChannel(channelName);
    bc.onmessage = (ev: MessageEvent<SessionEvent>) => {
      dispatch(ev.data);
    };
    scope.addFinalizer(() => {
      bc?.close();
      bc = null;
    });
  } else if (typeof window !== "undefined") {
    storageHandler = (ev: StorageEvent) => {
      if (ev.key !== channelName || ev.newValue === null) return;
      try {
        const parsed = JSON.parse(ev.newValue);
        if (isValidStoredSessionPayload(parsed)) {
          dispatch(parsed.event);
        }
      } catch {}
    };
    window.addEventListener("storage", storageHandler);
    scope.addFinalizer(() => {
      if (storageHandler && typeof window !== "undefined") {
        window.removeEventListener("storage", storageHandler);
        storageHandler = null;
      }
    });
  }

  return {
    notify(event: SessionEvent): void {
      if (closed) return;
      if (bc) {
        bc.postMessage(event);
      } else if (typeof localStorage !== "undefined") {
        try {
          seq += 1;
          localStorage.setItem(
            channelName,
            JSON.stringify({ event, sender: senderId, seq }),
          );
        } catch {}
      }
    },
    onNotification(callback: (event: SessionEvent) => void): () => void {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    close(): void {
      if (closed) return;
      closed = true;
      void scope.close();
      callbacks.clear();
    },
  };
}
