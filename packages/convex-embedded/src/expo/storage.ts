import {
  EncodingType,
  cacheDirectory,
  deleteAsync,
  getInfoAsync,
  makeDirectoryAsync,
  writeAsStringAsync,
} from "expo-file-system/legacy";

import type { EmbeddedCryptoProvider } from "@/runtime/crypto";
import type { EmbeddedRuntime } from "@/runtime/embedded";
import type { StorageSurface } from "@/runtime/storage";
import { encodeBase64 } from "@/shared/base64";
import { createLogger } from "@/shared/logger";

const UPLOAD_PATH_PREFIX = "/__convex_embedded/upload/";
const log = createLogger("expo-storage-surface");

type ExpoStorageSurface = StorageSurface & {
  close(): void;
  handleUpload(token: string, request: Request): Promise<Response>;
};

type CachedFileEntry = {
  uri: string;
  sha256: string | null;
};

const uploadSurfaces = new Map<string, ExpoStorageSurface>();

export function createExpoUploadFetch(): typeof globalThis.fetch {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (!requestUrl.includes(UPLOAD_PATH_PREFIX)) {
      return nativeFetch(input, init);
    }

    const request = new Request(input, init);
    const url = new URL(request.url, "http://convex-embedded.local");
    if (!url.pathname.startsWith(UPLOAD_PATH_PREFIX)) {
      return nativeFetch(input, init);
    }

    const token = url.pathname.slice(UPLOAD_PATH_PREFIX.length);
    const surface = uploadSurfaces.get(token);
    if (!surface) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: "Upload URL is invalid or expired." }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    }
    return surface.handleUpload(token, request);
  }) as typeof globalThis.fetch;
}

function uploadUrlForToken(token: string): string {
  return new URL(
    `${UPLOAD_PATH_PREFIX}${token}`,
    "http://convex-embedded.local",
  ).toString();
}

async function handleUploadRequest(
  runtime: EmbeddedRuntime,
  token: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Upload URL only accepts POST requests." }),
      {
        status: 405,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const body = await request.arrayBuffer();
    const blob = new Blob([body], { type: contentType || undefined });
    const storageId = await runtime.storeUploadedBlobWithMetadata(blob, {
      uploadSourceRef: runtime.consumeUploadUrlSource(token),
    });
    uploadSurfaces.delete(token);
    return new Response(JSON.stringify({ storageId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (thrown) {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    return new Response(
      JSON.stringify({ error: error.message || "Upload failed." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

export function createExpoStorageSurface(
  runtime: EmbeddedRuntime,
  crypto: EmbeddedCryptoProvider,
  options: { directory?: string } = {},
): ExpoStorageSurface {
  const rootDirectory = options.directory ?? cacheDirectory;
  if (!rootDirectory) {
    log.info("expo file cache directory unavailable; using no-op storage URLs");
    return {
      async getUrl(): Promise<string | null> {
        return null;
      },
      async generateUploadUrl(): Promise<string> {
        const token = crypto.randomUUID();
        uploadSurfaces.set(token, this);
        return uploadUrlForToken(token);
      },
      async handleUpload(token: string, request: Request): Promise<Response> {
        return handleUploadRequest(runtime, token, request);
      },
      close(): void {
        for (const [token, surface] of Array.from(uploadSurfaces.entries())) {
          if (surface === this) {
            uploadSurfaces.delete(token);
          }
        }
      },
    };
  }
  const storageDirectory = `${rootDirectory.replace(/\/?$/, "/")}convex-embedded/storage/`;

  const cachedFiles = new Map<string, CachedFileEntry>();

  const fileForStorageId = (storageId: string) =>
    `${storageDirectory}${encodeURIComponent(storageId)}.blob`;

  const ensureStorageDirectory = () =>
    makeDirectoryAsync(storageDirectory, { intermediates: true }).catch(
      () => undefined,
    );

  const deleteFileIfPresent = async (fileUri: string) => {
    const info = await getInfoAsync(fileUri);
    if (info.exists) {
      await deleteAsync(fileUri, { idempotent: true });
    }
  };

  void ensureStorageDirectory();

  return {
    async getUrl(storageId: string): Promise<string | null> {
      const metadata = await runtime.getStorageMetadata(storageId);
      const blob = await runtime.getStorageBlob(storageId);
      if (metadata === null || blob === null) {
        const current = cachedFiles.get(storageId);
        if (current) {
          await deleteFileIfPresent(fileForStorageId(storageId));
          cachedFiles.delete(storageId);
        }
        return null;
      }

      const sha256 =
        typeof metadata.sha256 === "string" ? metadata.sha256 : null;
      const current = cachedFiles.get(storageId);
      const fileUri = fileForStorageId(storageId);
      const info = await getInfoAsync(fileUri);
      if (current && current.sha256 === sha256 && info.exists) {
        return current.uri;
      }

      if (info.exists) {
        await deleteAsync(fileUri, { idempotent: true });
      }
      await ensureStorageDirectory();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeAsStringAsync(fileUri, encodeBase64(bytes), {
        encoding: EncodingType.Base64,
      });
      cachedFiles.set(storageId, { uri: fileUri, sha256 });
      return fileUri;
    },

    async generateUploadUrl(): Promise<string> {
      const token = crypto.randomUUID();
      uploadSurfaces.set(token, this);
      return uploadUrlForToken(token);
    },

    async handleUpload(token: string, request: Request): Promise<Response> {
      return handleUploadRequest(runtime, token, request);
    },

    close(): void {
      for (const [token, surface] of Array.from(uploadSurfaces.entries())) {
        if (surface === this) {
          uploadSurfaces.delete(token);
        }
      }
      for (const storageId of cachedFiles.keys()) {
        void deleteFileIfPresent(fileForStorageId(storageId));
      }
      cachedFiles.clear();
      log.info("closed expo storage surface");
    },
  };
}
