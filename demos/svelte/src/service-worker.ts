/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, files, version } from "$service-worker";

const self = globalThis as unknown as ServiceWorkerGlobalScope;

const CACHE = `convex-embedded-demo-${version}`;
const ASSETS = [...build, ...files];
const WA_SQLITE_ORIGIN = "https://wa-sqlite.trestle.inc";
const WA_SQLITE_ASSETS = [
  `${WA_SQLITE_ORIGIN}/v1.0.0/dist/wa-sqlite-async.wasm`,
  `${WA_SQLITE_ORIGIN}/v1.0.0/dist/wa-sqlite-async.mjs`,
  `${WA_SQLITE_ORIGIN}/v1.0.0/src/examples/IDBBatchAtomicVFS.js`,
  `${WA_SQLITE_ORIGIN}/v1.0.0/src/sqlite-api.js`,
];
const PRECACHE_URLS = [...ASSETS, "/", ...WA_SQLITE_ASSETS];
const SHELL_FALLBACKS = ["/"];

async function warmResource(cache: Cache, resource: string) {
  try {
    const response = await fetch(resource, { cache: "reload" });
    if (response instanceof Response && response.ok) {
      await cache.put(resource, response.clone());
    }
  } catch {
    // Ignore optional precache misses during install.
  }
}

self.addEventListener("install", (event) => {
  async function warmCache() {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(
      PRECACHE_URLS.map((resource) => warmResource(cache, resource)),
    );
    await self.skipWaiting();
  }

  event.waitUntil(warmCache());
});

self.addEventListener("activate", (event) => {
  async function cleanupCaches() {
    for (const key of await caches.keys()) {
      if (key !== CACHE) {
        await caches.delete(key);
      }
    }

    await self.clients.claim();
  }

  event.waitUntil(cleanupCaches());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isWaSqliteAsset = url.origin === WA_SQLITE_ORIGIN;

  if (!isSameOrigin && !isWaSqliteAsset) {
    return;
  }

  if (isSameOrigin && url.pathname.startsWith("/__convex_embedded/upload/")) {
    return;
  }

  async function respond() {
    const cache = await caches.open(CACHE);
    const cached =
      (await cache.match(request)) ??
      (isSameOrigin ? await cache.match(url.pathname) : undefined);

    if (isWaSqliteAsset && cached) {
      return cached;
    }

    if (isSameOrigin && ASSETS.includes(url.pathname) && cached) {
      return cached;
    }

    try {
      const response = await fetch(request);
      if (response instanceof Response && response.ok) {
        await cache.put(
          isSameOrigin ? url.pathname : request,
          response.clone(),
        );
      }
      return response;
    } catch (error) {
      if (cached) {
        return cached;
      }

      if (request.mode === "navigate") {
        for (const fallback of SHELL_FALLBACKS) {
          const shell = await cache.match(fallback);
          if (shell) {
            return shell;
          }
        }
      }

      throw error;
    }
  }

  event.respondWith(respond());
});
