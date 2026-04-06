import { Fx } from "@robelest/fx";

import {
  createAmbientCryptoProvider,
  type EmbeddedCryptoProvider,
} from "@/runtime/crypto";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { StorageSurface } from "@/runtime/storage";
import { createLogger } from "@/shared/logger";

const UPLOAD_PATH_PREFIX = "/__convex_embedded/upload/";
const log = createLogger("storage-surface");

type BrowserStorageSurface = StorageSurface & {
  close(): void;
  handleUpload(token: string, request: Request): Promise<Response>;
};

type ObjectUrlEntry = {
  url: string;
  sha256: string | null;
};

const uploadSurfaces = new Map<string, BrowserStorageSurface>();

let originalFetch: typeof globalThis.fetch | null = null;

function ensureFetchInterceptor(): void {
  if (originalFetch !== null || typeof globalThis.fetch !== "function") {
    return;
  }

  log.info("installing browser fetch interceptor for local uploads");
  originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (!requestUrl.includes(UPLOAD_PATH_PREFIX)) {
      return await originalFetch!(input, init);
    }

    const request = new Request(input, init);
    const url = new URL(request.url, globalThis.location?.origin);
    if (!url.pathname.startsWith(UPLOAD_PATH_PREFIX)) {
      return await originalFetch!(input, init);
    }

    const token = url.pathname.slice(UPLOAD_PATH_PREFIX.length);
    log.info(`intercepted local upload request for token ${token}`);
    const surface = uploadSurfaces.get(token);
    if (surface === undefined) {
      log.warn(`upload token ${token} was missing or expired`);
      return new Response(
        JSON.stringify({ error: "Upload URL is invalid or expired." }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    return await surface.handleUpload(token, request);
  }) as typeof globalThis.fetch;
}

function uploadUrlForToken(token: string): string {
  const origin = globalThis.location?.origin ?? "http://convex-embedded.local";
  return new URL(`${UPLOAD_PATH_PREFIX}${token}`, origin).toString();
}

function maybeRestoreFetch(): void {
  if (uploadSurfaces.size > 0 || originalFetch === null) {
    return;
  }

  log.info("restoring original fetch after upload surface cleanup");
  globalThis.fetch = originalFetch;
  originalFetch = null;
}

export function createBrowserStorageSurface(
  runtime: EmbeddedRuntime,
  crypto: EmbeddedCryptoProvider = runtime.crypto ??
    createAmbientCryptoProvider(),
): BrowserStorageSurface {
  const objectUrls = new Map<string, ObjectUrlEntry>();

  ensureFetchInterceptor();

  return {
    async getUrl(storageId: string): Promise<string | null> {
      log.debug(`resolving blob URL for ${storageId}`);
      const metadata = await runtime.getStorageMetadata(storageId);
      const blob = await runtime.getStorageBlob(storageId);
      if (metadata === null || blob === null) {
        const existing = objectUrls.get(storageId);
        if (existing !== undefined) {
          URL.revokeObjectURL(existing.url);
          objectUrls.delete(storageId);
        }
        return null;
      }

      const current = objectUrls.get(storageId);
      const sha256 =
        typeof metadata.sha256 === "string" ? metadata.sha256 : null;
      if (current !== undefined && current.sha256 === sha256) {
        return current.url;
      }
      if (current !== undefined) {
        URL.revokeObjectURL(current.url);
      }

      const next = URL.createObjectURL(blob);
      objectUrls.set(storageId, { url: next, sha256 });
      log.info(`created blob URL for ${storageId}`);
      return next;
    },

    async generateUploadUrl(): Promise<string> {
      const token = crypto.randomUUID();
      uploadSurfaces.set(token, this);
      const url = uploadUrlForToken(token);
      log.info(`generated local upload URL for token ${token}`);
      return url;
    },

    async handleUpload(token: string, request: Request): Promise<Response> {
      if (request.method !== "POST") {
        log.warn(`rejected non-POST upload request for token ${token}`);
        return new Response(
          JSON.stringify({ error: "Upload URL only accepts POST requests." }),
          {
            status: 405,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return await Fx.run(
        Fx.from({
          ok: async () => {
            log.info(`starting local upload for token ${token}`);
            const contentType = request.headers.get("content-type") ?? "";
            const body = await request.arrayBuffer();
            const blob = new Blob([body], {
              type: contentType || undefined,
            });
            log.debug(
              `received upload body for token ${token} (${blob.size} bytes, ${blob.type || "unknown type"})`,
            );
            const storageId = await runtime.storeUploadedBlob(blob);
            uploadSurfaces.delete(token);
            log.info(
              `completed local upload for token ${token} -> ${storageId}`,
            );
            return new Response(JSON.stringify({ storageId }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          },
          err: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        }).pipe(
          Fx.recover((error) =>
            Fx.succeed(
              (() => {
                log.error(`local upload failed for token ${token}`, error);
                return new Response(
                  JSON.stringify({ error: error.message || "Upload failed." }),
                  {
                    status: 500,
                    headers: { "Content-Type": "application/json" },
                  },
                );
              })(),
            ),
          ),
        ),
      );
    },

    close(): void {
      log.info("closing browser storage surface");
      for (const [token, surface] of Array.from(uploadSurfaces.entries())) {
        if (surface === this) {
          uploadSurfaces.delete(token);
        }
      }

      for (const { url } of objectUrls.values()) {
        URL.revokeObjectURL(url);
      }
      objectUrls.clear();
      maybeRestoreFetch();
    },
  };
}
