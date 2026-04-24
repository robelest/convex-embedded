import { markRoute } from "@/shared/route";
import { STORAGE_UPLOAD_URL_META } from "@/shared/symbols";
import type { StorageUploadUrlMeta } from "@/shared/symbols";

export function localOnly<T>(fn: T): T {
  return markRoute(fn, "local");
}

export function remoteOnly<T>(fn: T): T {
  return markRoute(fn, "remote");
}

export function storageUploadUrl<T>(fn: T): T {
  Object.defineProperty(fn as object, STORAGE_UPLOAD_URL_META, {
    value: {
      __brand: "convex-embedded:storageUploadUrlMeta",
    } satisfies StorageUploadUrlMeta,
    enumerable: false,
    configurable: false,
  });
  return fn;
}
