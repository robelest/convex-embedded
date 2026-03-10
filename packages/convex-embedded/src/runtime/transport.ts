/**
 * Transport configuration for ConvexClient / ConvexReactClient.
 *
 * Creates the `{ url, webSocketConstructor }` pair that plugs ConvexClient
 * into the embedded runtime's in-memory protocol handler via LoopbackWebSocket.
 */

import { LoopbackWebSocketConstructor } from "@/runtime/loopback-ws";
import type { LoopbackWebSocket } from "@/runtime/loopback-ws";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface for the embedded runtime's protocol handler.
 * The runtime must expose a `handleMessage` that accepts a JSON string
 * and returns an array of JSON response strings.
 */
interface ProtocolHandler {
  handleMessage(message: string): Promise<string[]>;
}

/** Transport configuration for ConvexClient. */
export interface EmbeddedTransport {
  /** URL passed to ConvexClient (placeholder — no real network is used). */
  url: string;
  /** WebSocket constructor that routes messages through the embedded runtime. */
  webSocketConstructor: new (url: string) => LoopbackWebSocket;
  /**
   * Close all active {@link LoopbackWebSocket} connections created by this
   * transport. Clears ping keepalive intervals and fires `onclose` events.
   *
   * Called by {@link EmbeddedRuntime.shutdown} to prevent interval leaks.
   */
  closeAll(): void;
  /**
   * Push a server-initiated message to all active WebSocket connections.
   *
   * Used by cross-tab sync to deliver `Transition` messages containing
   * re-evaluated query results after another tab writes to the shared
   * IndexedDB store.
   */
  pushMessage(data: string): void;
}

// ---------------------------------------------------------------------------
// createTransport
// ---------------------------------------------------------------------------

/**
 * Build the transport config that ConvexClient expects.
 *
 * Each `LoopbackWebSocket` instance (one per connection/reconnect) gets its
 * own handler closure that captures the session ID from the first `Connect`
 * message and injects it into all subsequent messages on that connection.
 *
 * This fixes the session-ID-mismatch bug: only `Connect` messages include
 * `sessionId` on the wire — `ModifyQuerySet`, `Mutation`, etc. do not. By
 * capturing the session ID per-connection, all messages on the same socket
 * are routed to the same protocol session.
 *
 * @param runtime  Any object with a `handleMessage` method (the sync
 *                 protocol handler exposed by `EmbeddedRuntime`).
 * @returns        `{ url, webSocketConstructor }` suitable for passing
 *                 to `new ConvexClient(url, { webSocketConstructor })`.
 */
export function createTransport(runtime: ProtocolHandler): EmbeddedTransport {
  // Track live WebSocket instances so we can close them on shutdown.
  const activeSockets = new Set<LoopbackWebSocket>();

  const webSocketConstructor = LoopbackWebSocketConstructor(() => {
    // Per-connection session ID — captured from the first Connect message.
    let connectionSessionId: string | undefined;

    return async (message: string): Promise<string[]> => {
      // Peek at the message to capture sessionId from Connect.
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "Connect" && parsed.sessionId) {
          connectionSessionId = parsed.sessionId;
        }
        // Inject the captured sessionId so that EmbeddedRuntime.handleMessage
        // always has a consistent sessionId for this connection.
        if (connectionSessionId && !parsed.sessionId) {
          parsed.sessionId = connectionSessionId;
          return runtime.handleMessage(JSON.stringify(parsed));
        }
      } catch {
        // Parse failed — fall through to let handleMessage deal with it.
      }
      return runtime.handleMessage(message);
    };
  });

  // Wrap the constructor to track/untrack instances.
  const TrackedWsConstructor = class extends webSocketConstructor {
    constructor(url: string) {
      super(url);
      activeSockets.add(this);
      // Remove from tracking when the socket closes (whether via
      // explicit close() or runtime shutdown).
      // Listen via addEventListener so we don't clobber the SDK's onclose.
      const self = this;
      this.addEventListener("close", () => {
        activeSockets.delete(self);
      });
    }
  };

  return {
    url: "http://embedded.local",
    webSocketConstructor: TrackedWsConstructor,
    closeAll(): void {
      // Snapshot the set since close() triggers removal via the listener.
      for (const ws of [...activeSockets]) {
        ws.close(1001, "runtime shutdown");
      }
      activeSockets.clear();
    },
    pushMessage(data: string): void {
      for (const ws of activeSockets) {
        ws.deliverMessage(data);
      }
    },
  };
}
