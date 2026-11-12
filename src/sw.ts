/// <reference lib="webworker" />
import {
  getCacheName,
  getCachesToDelete,
  isCacheableUrl,
  isCacheReady,
} from "./sw-cache";

declare const self: ServiceWorkerGlobalScope;
declare const __AGENT_VERSION__: string;
declare const __SHELF_AGENT_VERSION__: string;

const urlParams = new URL(self.location.href).searchParams;
const AGENT_VERSION: string =
  urlParams.get("v") || (typeof __AGENT_VERSION__ !== "undefined" ? __AGENT_VERSION__ : "v0.3.1");
const SHELF_AGENT_VERSION: string =
  urlParams.get("shelf_v") || (typeof __SHELF_AGENT_VERSION__ !== "undefined" ? __SHELF_AGENT_VERSION__ : "v0.2.1");
const BASE_URL: string = urlParams.get("base") || (import.meta.env?.BASE_URL ?? "/retail-shelf-web/");

const CACHE_NAME = getCacheName(AGENT_VERSION);

const CORE_ASSETS = [
  BASE_URL,
  `${BASE_URL}index.html`,
  `${BASE_URL}samples/lays.jpg`,
  `${BASE_URL}samples/hanami.jpg`,
  `${BASE_URL}samples/pocky.jpg`,
  `${BASE_URL}samples/copp.jpg`,
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const url of CORE_ASSETS) {
        try {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
        } catch {
          // Precache best-effort
        }
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      const keys = await caches.keys();
      const toDelete = getCachesToDelete(keys, AGENT_VERSION);
      await Promise.all(toDelete.map((k) => caches.delete(k)));
      await checkAndNotifyClients();
    })()
  );
});

async function checkAndNotifyClients() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const keys = await cache.keys();
    const urls = keys.map((k) => k.url);
    if (isCacheReady(urls, BASE_URL, AGENT_VERSION)) {
      const allClients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of allClients) {
        client.postMessage({ type: "OFFLINE_READY", cacheName: CACHE_NAME });
      }
    }
  } catch {
    // Ignore notification errors
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // 1. Cache-first strategy for fast offline performance and zero duplicate model downloads
      const cached = await cache.match(req);
      if (cached) {
        return cached;
      }

      // 2. Network fetch fallback
      try {
        const res = await fetch(req);
        if (res.ok && isCacheableUrl(req.url, BASE_URL, AGENT_VERSION, SHELF_AGENT_VERSION)) {
          await cache.put(req, res.clone());
          void checkAndNotifyClients();
        }
        return res;
      } catch (err) {
        // 3. Fallback for navigation requests when offline
        if (req.mode === "navigate") {
          const fallback = (await cache.match(`${BASE_URL}index.html`)) || (await cache.match(BASE_URL));
          if (fallback) return fallback;
        }
        throw err;
      }
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CHECK_OFFLINE") {
    void checkAndNotifyClients();
  }
});
