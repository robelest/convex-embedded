/**
 * In-memory WebSocket bridge for ConvexClient.
 *
 * Connects ConvexClient to the embedded runtime without real networking.
 * Messages are passed directly through a handler callback, and responses
 * are delivered synchronously via `onmessage`.
 */

import { createLogger } from "@/shared/logger";

const log = createLogger("ws");

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * Interval (ms) between server Ping messages. The Convex SDK's
 * `web_socket_manager` expects periodic server messages to avoid
 * triggering an inactivity-based reconnect (~60 s default).
 */
const PING_INTERVAL_MS = 30_000;

/** Base event shape for LoopbackWebSocket events. */
/** @internal */
export interface LoopbackEvent {
  type: string;
}

/** Event fired when the WebSocket connection opens. */
/** @internal */
export interface LoopbackOpenEvent extends LoopbackEvent {
  type: "open";
}

/** Event fired when the WebSocket receives a message. */
/** @internal */
export interface LoopbackMessageEvent extends LoopbackEvent {
  type: "message";
  data: string;
}

/** Event fired when the WebSocket connection closes. */
/** @internal */
export interface LoopbackCloseEvent extends LoopbackEvent {
  type: "close";
  code: number;
  reason: string;
}

/** Event fired when a WebSocket error occurs. */
/** @internal */
export interface LoopbackErrorEvent extends LoopbackEvent {
  type: "error";
  error: unknown;
}

/**
 * Minimal WebSocket-compatible class that routes messages through an
 * in-memory handler instead of a real network connection.
 *
 * The `handler` callback receives each sent message and returns an array
 * of response strings that are dispatched as `onmessage` events.
 * @internal
 */
export class LoopbackWebSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readonly CONNECTING = CONNECTING;
  readonly OPEN = OPEN;
  readonly CLOSING = CLOSING;
  readonly CLOSED = CLOSED;

  readyState: number = CONNECTING;
  binaryType: string = "blob";
  readonly url: string;

  onopen: ((ev: LoopbackOpenEvent) => void) | null = null;
  onclose: ((ev: LoopbackCloseEvent) => void) | null = null;
  onmessage: ((ev: LoopbackMessageEvent) => void) | null = null;
  onerror: ((ev: LoopbackErrorEvent) => void) | null = null;

  private _handler: (message: string) => Promise<string[]>;
  private _listeners: Map<string, Set<(ev: LoopbackEvent) => void>> = new Map();
  private _pingInterval: ReturnType<typeof setInterval> | null = null;
  private _sendQueue: Promise<void> = Promise.resolve();

  constructor(url: string, handler: (message: string) => Promise<string[]>) {
    this.url = url;
    this._handler = handler;

    void Promise.resolve().then(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      log.debug("open", url);
      const event = { type: "open" as const };
      this.onopen?.(event);
      this._emit("open", event);

      this._startPingInterval();
    });
  }

  /**
   * Send a message to the embedded runtime. The handler is invoked and
   * each response string is delivered as an `onmessage` event.
   */
  send(data: string): void {
    if (this.readyState !== OPEN) {
      throw new Error("WebSocket is not open");
    }

    const msgType = (() => {
      try {
        return JSON.parse(data).type;
      } catch {
        return "?";
      }
    })();
    log.debug("send", msgType);

    this._sendQueue = this._sendQueue
      .then(
        async () => {
          const responses = await this._handler(data);
          for (const response of responses) {
            await this._queueInboundMessage(response);
          }
        },
        async () => {
          const responses = await this._handler(data);
          for (const response of responses) {
            await this._queueInboundMessage(response);
          }
        },
      )
      .catch((error) => {
        log.error("handler error:", error);
        const event = { type: "error" as const, error };
        this.onerror?.(event);
        this._emit("error", event);
      });
  }

  /** Close the connection and fire the `onclose` event. */
  close(_code?: number, _reason?: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this._stopPingInterval();
    log.debug("close", _code, _reason);
    const event = {
      type: "close" as const,
      code: _code ?? 1000,
      reason: _reason ?? "",
    };
    this.onclose?.(event);
    this._emit("close", event);
  }

  /**
   * Deliver a server-initiated message to this WebSocket.
   *
   * Triggers `onmessage` and any `addEventListener("message", ...)` listeners,
   * exactly as if the message were a response to a `send()` call. Used by the
   * transport's `pushMessage` for cross-tab remote.
   */
  deliverMessage(data: string): void {
    if (this.readyState !== OPEN) return;
    this._sendQueue = this._sendQueue.then(
      () => this._queueInboundMessage(data),
      () => this._queueInboundMessage(data),
    );
  }

  addEventListener(type: string, listener: (ev: LoopbackEvent) => void): void {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (ev: LoopbackEvent) => void,
  ): void {
    this._listeners.get(type)?.delete(listener);
  }

  /** Start sending periodic Ping messages to keep the connection alive. */
  private _startPingInterval(): void {
    this._pingInterval = setInterval(() => {
      if (this.readyState !== OPEN) {
        this._stopPingInterval();
        return;
      }
      const pingEvent = {
        type: "message" as const,
        data: JSON.stringify({ type: "Ping" }),
      };
      this.onmessage?.(pingEvent);
      this._emit("message", pingEvent);
    }, PING_INTERVAL_MS);
  }

  /** Clear the Ping keepalive interval. */
  private _stopPingInterval(): void {
    if (this._pingInterval !== null) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  private _emit(type: string, event: LoopbackEvent): void {
    const set = this._listeners.get(type);
    if (set) {
      for (const listener of set) {
        listener(event);
      }
    }
  }

  private async _queueInboundMessage(data: string): Promise<void> {
    if (this.readyState !== OPEN) return;
    const respType = (() => {
      try {
        return JSON.parse(data).type;
      } catch {
        return "?";
      }
    })();
    log.debug("recv", respType);
    const event = { type: "message" as const, data };
    this.onmessage?.(event);
    this._emit("message", event);
  }
}

/**
 * Creates a WebSocket constructor compatible with ConvexClient's
 * `webSocketConstructor` option.
 *
 * Accepts either:
 * - A **handler factory** (zero-arg function returning a handler) — a fresh
 *   handler is created for each WebSocket instance, allowing per-connection
 *   state (e.g. capturing the session ID from the first `Connect` message).
 * - A **handler** directly — shared across all instances (legacy behaviour).
 *
 * @param handlerOrFactory  A message handler, or a factory that returns one.
 * @returns A `WebSocket`-compatible constructor for Convex client wiring.
 * @internal
 */
export function LoopbackWebSocketConstructor(
  handlerOrFactory:
    | ((message: string) => Promise<string[]>)
    | (() => (message: string) => Promise<string[]>),
): new (url: string) => LoopbackWebSocket {
  const isFactory = handlerOrFactory.length === 0;

  return class extends LoopbackWebSocket {
    constructor(url: string) {
      const handler = isFactory
        ? (handlerOrFactory as () => (message: string) => Promise<string[]>)()
        : (handlerOrFactory as (message: string) => Promise<string[]>);
      super(url, handler);
      const socketAwareHandler = handler as ((
        message: string,
      ) => Promise<string[]>) & {
        _setSocketRef?: (socket: LoopbackWebSocket) => void;
      };
      socketAwareHandler._setSocketRef?.(this);
    }
  };
}
