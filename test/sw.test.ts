import { describe, expect, it } from "vitest";
import {
  CACHE_PREFIX,
  getCacheName,
  getCachesToDelete,
  isCacheableUrl,
  isCacheComplete,
  isCacheReady,
  isOldCache,
  normalizeUrl,
} from "../src/sw-cache";

describe("Service Worker Cache Logic", () => {
  const CURRENT_VERSION = "v0.3.1";

  it("constructs cache name containing the agent version", () => {
    expect(getCacheName(CURRENT_VERSION)).toBe("retail-shelf-v0.3.1");
    expect(getCacheName("v0.3.2")).toBe("retail-shelf-v0.3.2");
    expect(getCacheName("mock")).toBe("retail-shelf-mock");
  });

  it("identifies old caches that match the prefix but not the current version", () => {
    expect(isOldCache("retail-shelf-v0.1.0", CURRENT_VERSION)).toBe(true);
    expect(isOldCache("retail-shelf-v0.2.1", CURRENT_VERSION)).toBe(true);
    expect(isOldCache("retail-shelf-v0.3.1", CURRENT_VERSION)).toBe(false);
    expect(isOldCache("other-app-cache", CURRENT_VERSION)).toBe(false);
  });

  it("filters old caches to delete on agent bump while preserving current and unrelated caches", () => {
    const allCaches = [
      "retail-shelf-v0.1.0",
      "retail-shelf-v0.2.0",
      "retail-shelf-v0.2.1",
      "retail-shelf-v0.3.1",
      "third-party-cache-v1",
    ];

    const toDelete = getCachesToDelete(allCaches, CURRENT_VERSION);
    expect(toDelete).toEqual([
      "retail-shelf-v0.1.0",
      "retail-shelf-v0.2.0",
      "retail-shelf-v0.2.1",
    ]);

    // When bumped to v0.3.2, v0.3.1 should now be deleted
    const toDeleteAfterBump = getCachesToDelete(allCaches, "v0.3.2");
    expect(toDeleteAfterBump).toContain("retail-shelf-v0.3.1");
    expect(toDeleteAfterBump).not.toContain("third-party-cache-v1");
  });

  it("determines cacheable URLs for app shell, assets, samples, and pinned agent", () => {
    const base = "/retail-shelf-web/";

    // Shell
    expect(isCacheableUrl("/retail-shelf-web/", base, CURRENT_VERSION)).toBe(true);
    expect(isCacheableUrl("/retail-shelf-web/index.html", base, CURRENT_VERSION)).toBe(true);

    // Assets
    expect(isCacheableUrl("/retail-shelf-web/assets/index-DQUsxBVb.js", base, CURRENT_VERSION)).toBe(true);
    expect(isCacheableUrl("/retail-shelf-web/assets/style-123.css", base, CURRENT_VERSION)).toBe(true);

    // Current agent version
    expect(isCacheableUrl("/retail-shelf-web/agent/v0.3.1/manifest.json", base, CURRENT_VERSION)).toBe(true);
    expect(isCacheableUrl("/retail-shelf-web/agent/v0.3.1/model.onnx", base, CURRENT_VERSION)).toBe(true);
    expect(isCacheableUrl("/retail-shelf-web/agent/v0.3.1/shelf-agent.js", base, CURRENT_VERSION)).toBe(true);

    // Shelf agent version if specified
    expect(isCacheableUrl("/retail-shelf-web/agent/v0.2.1/model.onnx", base, CURRENT_VERSION, "v0.2.1")).toBe(true);

    // Samples
    expect(isCacheableUrl("/retail-shelf-web/samples/lays.jpg", base, CURRENT_VERSION)).toBe(true);

    // Outdated agent version - should not be cached
    expect(isCacheableUrl("/retail-shelf-web/agent/v0.1.0/model.onnx", base, CURRENT_VERSION)).toBe(false);

    // External or unrelated URLs
    expect(isCacheableUrl("https://example.com/other.js", base, CURRENT_VERSION)).toBe(false);
  });

  it("evaluates cache completeness correctly", () => {
    const required = [
      "/retail-shelf-web/",
      "/retail-shelf-web/index.html",
      "/retail-shelf-web/agent/v0.3.1/model.onnx",
    ];

    expect(isCacheComplete([], required)).toBe(false);
    expect(isCacheComplete(["/retail-shelf-web/", "/retail-shelf-web/index.html"], required)).toBe(false);
    expect(
      isCacheComplete(
        [
          "/retail-shelf-web/",
          "/retail-shelf-web/index.html",
          "/retail-shelf-web/agent/v0.3.1/model.onnx",
          "/retail-shelf-web/assets/extra.js",
        ],
        required
      )
    ).toBe(true);
  });

  it("evaluates isCacheReady when shell, model and wasm runtime are cached", () => {
    const base = "/retail-shelf-web/";
    expect(isCacheReady([], base, CURRENT_VERSION)).toBe(false);

    // Missing model and wasm
    expect(isCacheReady(["/retail-shelf-web/index.html"], base, CURRENT_VERSION)).toBe(false);

    // Missing wasm
    expect(
      isCacheReady(
        ["/retail-shelf-web/index.html", "/retail-shelf-web/agent/v0.3.1/model.onnx"],
        base,
        CURRENT_VERSION
      )
    ).toBe(false);

    // Complete
    expect(
      isCacheReady(
        [
          "/retail-shelf-web/index.html",
          "/retail-shelf-web/agent/v0.3.1/model.onnx",
          "/retail-shelf-web/agent/v0.3.1/ort-wasm-simd-threaded.jsep.wasm",
        ],
        base,
        CURRENT_VERSION
      )
    ).toBe(true);

    // Mock version only needs shell
    expect(isCacheReady(["/retail-shelf-web/index.html"], base, "mock")).toBe(true);
  });
});
