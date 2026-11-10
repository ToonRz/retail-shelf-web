// Stand-in agent used while agent.version is "mock" (before the first real release),
// so the UI (task B) can be built without a model. Same interface as the real one.
import type { Agent, Backend, Box, DetectInput } from "./agent-contract";

// Boxes as fractions of the image, so they land in the same place on any picture.
const FAKE: Array<[string, number, number, number, number, number]> = [
  ["pepsi", 0.97, 0.05, 0.05, 0.2, 0.3],
  ["pepsi", 0.95, 0.22, 0.05, 0.37, 0.3],
  ["lays-salt", 0.93, 0.4, 0.08, 0.58, 0.3],
  ["mama-pork", 0.91, 0.62, 0.12, 0.85, 0.3],
  ["taro-original", 0.88, 0.1, 0.45, 0.28, 0.65],
  ["mama-pork", 0.84, 0.35, 0.48, 0.58, 0.65],
];

export function imageSize(img: DetectInput): { width: number; height: number } {
  if ("naturalWidth" in img && img.naturalWidth) return { width: img.naturalWidth, height: img.naturalHeight };
  return { width: img.width, height: img.height };
}

export function createMockAgent(backend: Backend = "wasm"): Agent {
  return {
    manifest: { version: "mock", model: { name: "mock", classes: 110, dataset: "mock" } },
    backend,
    async detect(img, opts = {}) {
      const { width, height } = imageSize(img);
      const conf = opts.conf ?? 0.25;
      const boxes: Box[] = FAKE.filter((f) => f[1] >= conf).map(([cls, c, x1, y1, x2, y2], i) => ({
        cls, classId: i, conf: c, xyxy: [x1 * width, y1 * height, x2 * width, y2 * height],
      }));
      await new Promise((r) => setTimeout(r, 30));
      return { version: "mock", model_sha256: "0".repeat(64), backend, latency_ms: 30, width, height, boxes };
    },
    async dispose() {},
  };
}
