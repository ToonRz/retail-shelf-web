// Service Worker for retail-shelf-web (public/sw.js)
const CACHE_PREFIX = "retail-shelf-";

function getCacheName(agentVersion) {
  return `${CACHE_PREFIX}${agentVersion}`;
}

function isOldCache(cacheName, currentVersion) {
  return cacheName.startsWith(CACHE_PREFIX) && cacheName !== getCacheName(currentVersion);
}

function getCachesToDelete(allCacheNames, currentVersion) {
  return allCacheNames.filter((name) => isOldCache(name, currentVersion));
}

function isCacheableUrl(url, base, agentVersion, shelfAgentVersion) {
  try {
    const parsed = new URL(url, self.location.href);
    const path = parsed.pathname;
    const cleanBase = base.endsWith("/") ? base : `${base}/`;

    if (!path.startsWith(cleanBase) && path !== cleanBase.slice(0, -1) && path !== "/") {
      return false;
    }

    const relPath = path.startsWith(cleanBase) ? path.slice(cleanBase.length) : path.replace(/^\//, "");

    if (relPath === "" || relPath === "index.html" || relPath === "favicon.ico" || relPath === "manifest.webmanifest") {
      return true;
    }
    if (relPath.startsWith("assets/")) return true;
    if (relPath.startsWith("samples/")) return true;
    if (relPath.startsWith(`agent/${agentVersion}/`)) return true;
    if (shelfAgentVersion && relPath.startsWith(`agent/${shelfAgentVersion}/`)) return true;

    return false;
  } catch {
    return false;
  }
}

function isCacheReady(cachedUrls, base, agentVersion) {
  if (!cachedUrls || cachedUrls.length === 0) return false;
  const hasShell = cachedUrls.some(
    (u) => u.endsWith("/index.html") || u.endsWith(base) || u.endsWith("/") || u.includes("index.html")
  );
  if (agentVersion === "mock") return hasShell;
  const hasModel = cachedUrls.some((u) => u.includes(`/agent/${agentVersion}/model.onnx`));
  const hasWasm = cachedUrls.some((u) => u.includes("ort-wasm") || u.includes(".wasm"));
  return hasShell && hasModel && hasWasm;
}

const urlParams = new URL(self.location.href).searchParams;
const AGENT_VERSION = urlParams.get("v") || "v0.3.1";
const SHELF_AGENT_VERSION = urlParams.get("shelf_v") || "v0.2.1";
const BASE_URL = urlParams.get("base") || "/retail-shelf-web/";

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

      const cached = await cache.match(req);
      if (cached) {
        return cached;
      }

      try {
        const res = await fetch(req);
        if (res.ok && isCacheableUrl(req.url, BASE_URL, AGENT_VERSION, SHELF_AGENT_VERSION)) {
          await cache.put(req, res.clone());
          void checkAndNotifyClients();
        }
        return res;
      } catch (err) {
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

