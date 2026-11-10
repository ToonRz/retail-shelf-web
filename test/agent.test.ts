import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAgentVersion } from "../vite.config";
import { createMockAgent } from "../src/mockAgent";

describe("agent.version pin", () => {
  it("the committed pin is valid", () => {
    expect(readAgentVersion()).toMatch(/^(mock|v\d+\.\d+\.\d+)$/);
  });
  it("refuses anything else", () => {
    const p = join(mkdtempSync(join(tmpdir(), "pin-")), "agent.version");
    for (const bad of ["1.2.3", "v1.2", "latest", ""]) {
      writeFileSync(p, bad);
      expect(() => readAgentVersion(p)).toThrow(/agent.version/);
    }
  });
});

describe("mock agent", () => {
  it("returns boxes inside the image, sorted by conf, filtered by conf", async () => {
    const a = createMockAgent();
    const r = await a.detect({ width: 800, height: 600 } as ImageData);
    expect(r.boxes.length).toBeGreaterThan(0);
    for (const b of r.boxes) {
      expect(b.xyxy[0]).toBeGreaterThanOrEqual(0);
      expect(b.xyxy[2]).toBeLessThanOrEqual(800);
      expect(b.xyxy[3]).toBeLessThanOrEqual(600);
    }
    expect(r.boxes.map((b) => b.conf)).toEqual([...r.boxes.map((b) => b.conf)].sort((x, y) => y - x));
    expect((await a.detect({ width: 10, height: 10 } as ImageData, { conf: 0.9 })).boxes.every((b) => b.conf >= 0.9)).toBe(true);
  });
});
