/**
 * runtime — creates a ConvexClient over an embedded runtime transport.
 *
 * Usage:
 *   import { runtime } from '@robelest/convex-resolve/client';
 *
 *   // With an embedded local runtime (e.g. Tauri, Electrobun)
 *   const localRuntime = createLocalRuntime({ ... });
 *   await localRuntime.start();
 *   const transport = localRuntime.createTransport();
 *   const rt = runtime.create(transport);
 *
 *   // With a remote local runtime URL (Bun/Node/Cloudflare)
 *   const rt = runtime.create({ clientUrl: 'http://localhost:3000' });
 *
 *   // rt.client is a standard ConvexClient
 */
import { createLogger } from "../shared/logger.js";

const log = createLogger("runtime");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * An embedded transport provides the URL and optional WebSocket constructor
 * needed to create a ConvexClient that talks to a local runtime instance.
 */
export interface EmbeddedTransport {
  /** The URL the ConvexClient connects to. */
  clientUrl: string;
  /** Custom WebSocket constructor for embedded transports. */
  webSocketConstructor?: unknown;
}

export interface RuntimeInstance {
  /** The transport this runtime uses. */
  transport: EmbeddedTransport;
  /**
   * Create a ConvexReactClient for this transport.
   * Caller must provide the ConvexReactClient constructor to avoid
   * hard dependency on convex/react.
   */
  createClient<T>(
    ClientConstructor: new (url: string, options?: Record<string, unknown>) => T,
    options?: Record<string, unknown>,
  ): T;
}

// ---------------------------------------------------------------------------
// runtime.create()
// ---------------------------------------------------------------------------

/**
 * Creates a runtime instance from an embedded transport.
 *
 * The transport can be:
 *   - An object from localRuntime.createTransport() (embedded)
 *   - A simple { clientUrl } object (remote local runtime server)
 */
function create(transport: EmbeddedTransport): RuntimeInstance {
  log.info(`runtime.create: clientUrl=${transport.clientUrl}`);

  return {
    transport,

    createClient<T>(
      ClientConstructor: new (url: string, options?: Record<string, unknown>) => T,
      options?: Record<string, unknown>,
    ): T {
      const clientOptions: Record<string, unknown> = { ...options };

      if (transport.webSocketConstructor) {
        clientOptions.webSocketConstructor = transport.webSocketConstructor;
      }

      return new ClientConstructor(transport.clientUrl, clientOptions);
    },
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const runtime = {
  create,
};
