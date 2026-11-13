import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAgentVersion } from "../vite.config";
import { createMockAgent } from "../src/mockAgent";
import { oneAtATime } from "../src/agent";

describe("agent.version pin", () => {
  it("the committed pins are valid", () => {
    expect(readAgentVersion()).toMatch(/^(mock|v\d+\.\d+\.\d+)$/);
    expect(readAgentVersion("agent-shelf.version")).toMatch(/^(mock|v\d+\.\d+\.\d+)$/);
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

describe("oneAtATime (two pages loading the same release)", () => {
  it("runs calls with the same key one after another, even after a failure", async () => {
    const log: string[] = [];
    const job = (name: string, fail = false) => async () => {
      log.push(`${name} start`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`${name} end`);
      if (fail) throw new Error(name);
      return name;
    };
    const a = oneAtATime("v9.9.9", job("a", true));
    const b = oneAtATime("v9.9.9", job("b"));
    await expect(a).rejects.toThrow("a");
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["a start", "a end", "b start", "b end"]);
  });
  it("does not make different keys wait", async () => {
    const log: string[] = [];
    let release!: () => void;
    const slow = oneAtATime("v8.8.8", () => new Promise<void>((r) => { release = r; }));
    await oneAtATime("v7.7.7", async () => { log.push("other"); });
    expect(log).toEqual(["other"]);
    release();
    await slow;
  });
});
