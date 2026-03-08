/**
 * runtime — creates a ConvexClient over a Concave transport.
 *
 * Usage:
 *   import { runtime } from 'convex-resolve/client';
 *
 *   // With an embedded Concave runtime (e.g. Tauri, Electrobun)
 *   const concaveRuntime = createConcave({ ... });
 *   await concaveRuntime.start();
 *   const transport = concaveRuntime.createTransport();
 *   const rt = runtime.create(transport);
 *
 *   // With a remote Concave URL (Bun/Node/Cloudflare)
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
 * A Concave transport provides the URL and optional WebSocket constructor
 * needed to create a ConvexClient that talks to a local Concave instance.
 */
export interface ConcaveTransport {
  /** The URL the ConvexClient connects to. */
  clientUrl: string;
  /** Custom WebSocket constructor for embedded transports. */
  webSocketConstructor?: any;
}

export interface RuntimeInstance {
  /** The transport this runtime uses. */
  transport: ConcaveTransport;
  /**
   * Create a ConvexReactClient for this transport.
   * Caller must provide the ConvexReactClient constructor to avoid
   * hard dependency on convex/react.
   */
  createClient<T>(
    ClientConstructor: new (url: string, options?: any) => T,
    options?: Record<string, any>,
  ): T;
}

// ---------------------------------------------------------------------------
// runtime.create()
// ---------------------------------------------------------------------------

/**
 * Creates a runtime instance from a Concave transport.
 *
 * The transport can be:
 *   - An object from concaveRuntime.createTransport() (embedded)
 *   - A simple { clientUrl } object (remote Concave server)
 */
function create(transport: ConcaveTransport): RuntimeInstance {
  log.info(`runtime.create: clientUrl=${transport.clientUrl}`);

  return {
    transport,

    createClient<T>(
      ClientConstructor: new (url: string, options?: any) => T,
      options?: Record<string, any>,
    ): T {
      const clientOptions: Record<string, any> = { ...options };

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
