/**
 * Transport configuration for ConvexClient / ConvexReactClient.
 *
 * Creates the `{ url, webSocketConstructor }` pair that plugs ConvexClient
 * into the embedded runtime's in-memory protocol handler via LoopbackWebSocket.
 */

import { LoopbackWebSocketConstructor } from "@/runtime/loopback";
import type { LoopbackWebSocket } from "@/runtime/loopback";

/**
 * Minimal interface for the embedded runtime's protocol handler.
 * The runtime must expose a `handleMessage` that accepts a JSON string
 * and returns an array of JSON response strings.
 */
interface ProtocolHandler {
  handleMessage(message: string): Promise<string[]>;
  teardownSession?(sessionId: string): void;
}

interface SessionSocketRegistry {
  socketsBySession: Map<string, Set<LoopbackWebSocket>>;
  sessionBySocket: WeakMap<LoopbackWebSocket, string>;
}

function addSocketToSession(
  registry: SessionSocketRegistry,
  sessionId: string,
  socket: LoopbackWebSocket,
): void {
  const existingSession = registry.sessionBySocket.get(socket);
  if (existingSession === sessionId) return;
  if (existingSession !== undefined) {
    detachSocketFromSession(registry, existingSession, socket);
  }

  const sockets = registry.socketsBySession.get(sessionId) ?? new Set();
  sockets.add(socket);
  registry.socketsBySession.set(sessionId, sockets);
  registry.sessionBySocket.set(socket, sessionId);
}

function detachSocketFromSession(
  registry: SessionSocketRegistry,
  sessionId: string,
  socket: LoopbackWebSocket,
): boolean {
  const sockets = registry.socketsBySession.get(sessionId);
  if (sockets === undefined) return false;

  sockets.delete(socket);
  if (sockets.size === 0) {
    registry.socketsBySession.delete(sessionId);
    return true;
  }

  return false;
}

function getSocketsForSession(
  registry: SessionSocketRegistry,
  sessionId: string,
): Set<LoopbackWebSocket> {
  return registry.socketsBySession.get(sessionId) ?? new Set();
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
   * Used by cross-tab remote to deliver `Transition` messages containing
   * re-evaluated query results after another tab writes to the shared
   * IndexedDB store.
   */
  pushMessage(sessionId: string, data: string): void;
}

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
 * @internal
 */
export function createTransport(
  runtime: ProtocolHandler,
  ready: Promise<void> = Promise.resolve(),
): EmbeddedTransport {
  const activeSockets = new Set<LoopbackWebSocket>();
  const sessionRegistry: SessionSocketRegistry = {
    socketsBySession: new Map(),
    sessionBySocket: new WeakMap(),
  };

  const webSocketConstructor = LoopbackWebSocketConstructor(() => {
    let connectionSessionId: string | undefined;
    let socketRef: LoopbackWebSocket | undefined;

    const handler = async (message: string): Promise<string[]> => {
      await ready;
      try {
        const parsed = JSON.parse(message);
        if (parsed.type === "Connect" && parsed.sessionId) {
          connectionSessionId = parsed.sessionId;
          if (socketRef !== undefined) {
            addSocketToSession(
              sessionRegistry,
              parsed.sessionId as string,
              socketRef,
            );
          }
        }
        if (connectionSessionId && !parsed.sessionId) {
          parsed.sessionId = connectionSessionId;
          return runtime.handleMessage(JSON.stringify(parsed));
        }
      } catch {}
      return runtime.handleMessage(message);
    };

    Object.assign(handler, {
      _setSocketRef: (socket: LoopbackWebSocket) => {
        socketRef = socket;
      },
    });

    return handler;
  });

  const TrackedWsConstructor = class extends webSocketConstructor {
    constructor(url: string) {
      super(url);
      const socket = this as unknown as LoopbackWebSocket;
      activeSockets.add(socket);
      socket.addEventListener("close", () => {
        activeSockets.delete(socket);
        const sessionId = sessionRegistry.sessionBySocket.get(socket);
        if (sessionId === undefined) return;

        const removedLastSocket = detachSocketFromSession(
          sessionRegistry,
          sessionId,
          socket,
        );
        if (removedLastSocket) {
          runtime.teardownSession?.(sessionId);
        }
      });
    }
  };

  return {
    url: "http://embedded.local",
    webSocketConstructor: TrackedWsConstructor,
    closeAll(): void {
      for (const ws of Array.from(activeSockets)) {
        ws.close(1001, "runtime shutdown");
      }
      activeSockets.clear();
    },
    pushMessage(sessionId: string, data: string): void {
      for (const ws of getSocketsForSession(sessionRegistry, sessionId)) {
        ws.deliverMessage(data);
      }
    },
  };
}
