// Pure functions for Service Worker cache management.
// Unit tested in test/sw.test.ts.

export const CACHE_PREFIX = "retail-shelf-";

/** Cache name must contain the agent version (e.g. retail-shelf-v0.3.1). */
export function getCacheName(agentVersion: string): string {
  return `${CACHE_PREFIX}${agentVersion}`;
}

/** Determines if a cache belongs to retail-shelf but is an older/different version. */
export function isOldCache(cacheName: string, currentVersion: string): boolean {
  return cacheName.startsWith(CACHE_PREFIX) && cacheName !== getCacheName(currentVersion);
}

/** Given all cache names, returns only those old retail-shelf caches that should be deleted. */
export function getCachesToDelete(allCacheNames: string[], currentVersion: string): string[] {
  return allCacheNames.filter((name) => isOldCache(name, currentVersion));
}

/** Check if a URL should be cached for offline support. */
export function isCacheableUrl(
  url: string,
  base: string = "/retail-shelf-web/",
  agentVersion: string = "v0.3.1",
  shelfAgentVersion?: string
): boolean {
  try {
    const parsed = new URL(url, "http://localhost");
    const path = parsed.pathname;

    // Must be under the application scope or root
    const cleanBase = base.endsWith("/") ? base : `${base}/`;

    if (!path.startsWith(cleanBase) && path !== cleanBase.slice(0, -1) && path !== "/") {
      return false;
    }

    const relPath = path.startsWith(cleanBase) ? path.slice(cleanBase.length) : path.replace(/^\//, "");

    // 1. App shell (root, index.html, favicon, manifest)
    if (relPath === "" || relPath === "index.html" || relPath === "favicon.ico" || relPath === "manifest.webmanifest") {
      return true;
    }

    // 2. Built assets
    if (relPath.startsWith("assets/")) {
      return true;
    }

    // 3. Samples
    if (relPath.startsWith("samples/")) {
      return true;
    }

    // 4. Agent files for current AGENT_VERSION (or SHELF_AGENT_VERSION)
    if (relPath.startsWith(`agent/${agentVersion}/`)) {
      return true;
    }
    if (shelfAgentVersion && relPath.startsWith(`agent/${shelfAgentVersion}/`)) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

/** Normalize URL path for cache key comparison. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, "http://localhost");
    return parsed.pathname;
  } catch {
    return url;
  }
}

/** Check whether all required URLs are present in the list of cached URLs. */
export function isCacheComplete(cachedUrls: string[], requiredUrls: string[]): boolean {
  if (requiredUrls.length === 0) return false;
  const cachedSet = new Set(cachedUrls.map(normalizeUrl));
  return requiredUrls.every((req) => cachedSet.has(normalizeUrl(req)));
}

/**
 * Determine if the cache has all essential components for offline operation:
 * - App shell / HTML
 * - Model ONNX file for the pinned agent
 * - ONNX runtime WASM binary
 */
export function isCacheReady(cachedUrls: string[], base: string, agentVersion: string): boolean {
  if (!cachedUrls || cachedUrls.length === 0) return false;
  const hasShell = cachedUrls.some(
    (u) => u.endsWith("/index.html") || u.endsWith(base) || u.endsWith("/") || u.includes("index.html")
  );
  if (agentVersion === "mock") return hasShell;
  const hasModel = cachedUrls.some((u) => u.includes(`/agent/${agentVersion}/model.onnx`));
  const hasWasm = cachedUrls.some((u) => u.includes("ort-wasm") || u.includes(".wasm"));
  return hasShell && hasModel && hasWasm;
}

/** Check if cache is ready using browser CacheStorage API. */
export async function checkOfflineReady(base: string, agentVersion: string): Promise<boolean> {
  if (typeof window === "undefined" || !("caches" in window)) return false;
  try {
    const cacheName = getCacheName(agentVersion);
    const hasCache = await window.caches.has(cacheName);
    if (!hasCache) return false;
    const cache = await window.caches.open(cacheName);
    const keys = await cache.keys();
    return isCacheReady(keys.map((k) => k.url), base, agentVersion);
  } catch {
    return false;
  }
}

/** Register service worker and toggle offline banner when cache is complete. */
export function initServiceWorker(agentVersion: string, base: string = import.meta.env.BASE_URL) {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  const showBanner = () => {
    const banner = document.getElementById("offlineBanner");
    if (banner) banner.hidden = false;
  };

  const swUrl = `${base}sw.js?v=${encodeURIComponent(agentVersion)}&base=${encodeURIComponent(base)}`;
  navigator.serviceWorker
    .register(swUrl, { scope: base })
    .then((reg) => {
      reg.addEventListener("updatefound", () => {
        const installing = reg.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "activated") {
            void checkOfflineReady(base, agentVersion).then((ok) => ok && showBanner());
          }
        });
      });
      void checkOfflineReady(base, agentVersion).then((ok) => ok && showBanner());
    })
    .catch((err) => console.warn("SW register failed:", err));

  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data?.type === "OFFLINE_READY") showBanner();
  });

  void checkOfflineReady(base, agentVersion).then((ok) => ok && showBanner());
}

/** Ensure shell, samples, and agent release files are stored in CacheStorage. */
export async function ensureAgentCached(
  agentVersion: string,
  samples: string[] = [],
  base: string = import.meta.env.BASE_URL
) {
  if (typeof window === "undefined" || !("caches" in window)) return;
  try {
    const cacheName = getCacheName(agentVersion);
    const cache = await caches.open(cacheName);

    // Precache shell and sample images
    const shellUrls = [base, `${base}index.html`, ...samples.map((s) => `${base}samples/${s}`)];
    for (const u of shellUrls) {
      if (!(await cache.match(u))) {
        try {
          const r = await fetch(u);
          if (r.ok) await cache.put(u, r);
        } catch {
          // ignore
        }
      }
    }

    // Precache agent files from manifest
    if (agentVersion !== "mock") {
      const manifestUrl = `${base}agent/${agentVersion}/manifest.json`;
      let manifestRes = await cache.match(manifestUrl);
      if (!manifestRes) {
        try {
          const fetched = await fetch(manifestUrl);
          if (fetched.ok) {
            await cache.put(manifestUrl, fetched.clone());
            manifestRes = fetched;
          }
        } catch {
          // ignore
        }
      }
      if (manifestRes) {
        try {
          const manifest = await manifestRes.clone().json();
          const files = Object.keys(manifest.files ?? {});
          for (const f of files) {
            const fileUrl = `${base}agent/${agentVersion}/${f}`;
            if (!(await cache.match(fileUrl))) {
              try {
                const res = await fetch(fileUrl);
                if (res.ok) await cache.put(fileUrl, res);
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    const ready = await checkOfflineReady(base, agentVersion);
    if (ready) {
      const banner = document.getElementById("offlineBanner");
      if (banner) banner.hidden = false;
    }
  } catch (err) {
    console.warn("Failed to ensure agent cached:", err);
  }
}
