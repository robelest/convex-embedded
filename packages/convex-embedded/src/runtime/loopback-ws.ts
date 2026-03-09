/**
 * In-memory WebSocket bridge for ConvexClient.
 *
 * Connects ConvexClient to the embedded runtime without real networking.
 * Messages are passed directly through a handler callback, and responses
 * are delivered synchronously via `onmessage`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

// ---------------------------------------------------------------------------
// LoopbackWebSocket
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket-compatible class that routes messages through an
 * in-memory handler instead of a real network connection.
 *
 * The `handler` callback receives each sent message and returns an array
 * of response strings that are dispatched as `onmessage` events.
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

  onopen: ((ev: any) => void) | null = null;
  onclose: ((ev: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onerror: ((ev: any) => void) | null = null;

  private _handler: (message: string) => Promise<string[]>;
  private _listeners: Map<string, Set<(ev: any) => void>> = new Map();

  constructor(url: string, handler: (message: string) => Promise<string[]>) {
    this.url = url;
    this._handler = handler;

    // Schedule open on the next microtask, matching real WebSocket behaviour.
    Promise.resolve().then(() => {
      if (this.readyState !== CONNECTING) return;
      this.readyState = OPEN;
      console.debug("[convex-embedded:ws] open", url);
      const event = { type: "open" };
      this.onopen?.(event);
      this._emit("open", event);
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
      try { return JSON.parse(data).type; } catch { return "?"; }
    })();
    console.debug("[convex-embedded:ws] send", msgType);

    // Fire-and-forget: handler is async but we schedule delivery on the
    // microtask queue so that ConvexClient's send() remains synchronous.
    this._handler(data).then(
      (responses) => {
        for (const response of responses) {
          if (this.readyState !== OPEN) break;
          const respType = (() => {
            try { return JSON.parse(response).type; } catch { return "?"; }
          })();
          console.debug("[convex-embedded:ws] recv", respType);
          const event = { type: "message", data: response };
          this.onmessage?.(event);
          this._emit("message", event);
        }
      },
      (error) => {
        console.error("[convex-embedded:ws] handler error:", error);
        const event = { type: "error", error };
        this.onerror?.(event);
        this._emit("error", event);
      },
    );
  }

  /** Close the connection and fire the `onclose` event. */
  close(_code?: number, _reason?: string): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    console.debug("[convex-embedded:ws] close", _code, _reason);
    const event = { type: "close", code: _code ?? 1000, reason: _reason ?? "" };
    this.onclose?.(event);
    this._emit("close", event);
  }

  addEventListener(type: string, listener: (ev: any) => void): void {
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: any) => void): void {
    this._listeners.get(type)?.delete(listener);
  }

  private _emit(type: string, event: any): void {
    const set = this._listeners.get(type);
    if (set) {
      for (const listener of set) {
        listener(event);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Constructor factory
// ---------------------------------------------------------------------------

/**
 * Creates a WebSocket constructor compatible with ConvexClient's
 * `webSocketConstructor` option.
 *
 * @param handler  Called for every message sent by ConvexClient. Must return
 *                 an array of response JSON strings to deliver back.
 */
export function LoopbackWebSocketConstructor(
  handler: (message: string) => Promise<string[]>,
): new (url: string) => LoopbackWebSocket {
  return class extends LoopbackWebSocket {
    constructor(url: string) {
      super(url, handler);
    }
  };
}
