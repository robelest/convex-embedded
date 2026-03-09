/**
 * Transport configuration for ConvexClient / ConvexReactClient.
 *
 * Creates the `{ url, webSocketConstructor }` pair that plugs ConvexClient
 * into the embedded runtime's in-memory protocol handler via LoopbackWebSocket.
 */

import { LoopbackWebSocketConstructor } from "$/runtime/loopback-ws";
import type { LoopbackWebSocket } from "$/runtime/loopback-ws";

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
  return {
    url: "http://embedded.local",
    webSocketConstructor,
  };
}
