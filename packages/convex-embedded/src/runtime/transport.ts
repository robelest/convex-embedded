/**
 * Transport configuration for ConvexClient / ConvexReactClient.
 *
 * Creates the `{ url, webSocketConstructor }` pair that plugs ConvexClient
 * into the embedded runtime's in-memory protocol handler via LoopbackWebSocket.
 */

import { LoopbackWebSocketConstructor } from "./loopback-ws.js";

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

// ---------------------------------------------------------------------------
// createTransport
// ---------------------------------------------------------------------------

/**
 * Build the transport config that ConvexClient expects.
 *
 * @param runtime  Any object with a `handleMessage` method (the sync
 *                 protocol handler exposed by `EmbeddedRuntime`).
 * @returns        `{ url, webSocketConstructor }` suitable for passing
 *                 to `new ConvexClient(url, { webSocketConstructor })`.
 */
export function createTransport(runtime: ProtocolHandler): {
  url: string;
  webSocketConstructor: any;
} {
  const webSocketConstructor = LoopbackWebSocketConstructor(
    (message: string) => runtime.handleMessage(message),
  );
  return {
    url: "http://embedded.local",
    webSocketConstructor,
  };
}
