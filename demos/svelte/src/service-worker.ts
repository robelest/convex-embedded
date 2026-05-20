/// <reference no-default-lib="true"/>
/// <reference lib="esnext" />
/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, files, version } from "$service-worker";

const self = globalThis as unknown as ServiceWorkerGlobalScope;

const CACHE = `convex-embedded-demo-${version}`;
const ASSETS = [...build, ...files];
const PRECACHE_URLS = [...ASSETS, "/"];
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

  if (!isSameOrigin) {
    return;
  }

  if (isSameOrigin && url.pathname.startsWith("/__convex_embedded/upload/")) {
    return;
  }

  async function respond() {
    const cache = await caches.open(CACHE);
    const cacheKey = ASSETS.includes(url.pathname) ? url.pathname : request;
    const cached =
      (await cache.match(cacheKey)) ?? (await cache.match(request));

    if (isSameOrigin && ASSETS.includes(url.pathname) && cached) {
      return cached;
    }

    try {
      const response = await fetch(request);
      if (response instanceof Response && response.ok) {
        await cache.put(cacheKey, response.clone());
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
