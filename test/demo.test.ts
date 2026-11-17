import { describe, expect, it } from "vitest";
import type { Box } from "../src/agent-contract";
import { CHAPTERS, chapterAt, clock, DEMO_STEPS, distinctNames, jsonPreview, splitBoxes, totalMs, VIDEO_SECONDS } from "../src/ui/demo-logic";

const box = (cls: string, classId: number, conf = 0.9): Box => ({ cls, classId, conf, xyxy: [1.4, 2.6, 30.2, 40.9] });

describe("demo steps", () => {
  it("runs one to two minutes, video included", () => {
    const ms = totalMs();
    expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(ms).toBeLessThanOrEqual(120_000);
    expect(totalMs(DEMO_STEPS, 10)).toBe(ms - (VIDEO_SECONDS - 10) * 1000);
  });
  it("has one video step, and every step id once", () => {
    expect(DEMO_STEPS.filter((s) => s.ms === null).map((s) => s.id)).toEqual(["video"]);
    expect(new Set(DEMO_STEPS.map((s) => s.id)).size).toBe(DEMO_STEPS.length);
  });
});

describe("clock", () => {
  it("formats m:ss", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(9_600)).toBe("0:10");
    expect(clock(110_000)).toBe("1:50");
    expect(clock(-5)).toBe("0:00");
  });
});

describe("chapters", () => {
  it("are in order and inside the recording", () => {
    for (let i = 1; i < CHAPTERS.length; i++) expect(CHAPTERS[i].at).toBeGreaterThan(CHAPTERS[i - 1].at);
    expect(CHAPTERS[0].at).toBe(0);
    expect(CHAPTERS.at(-1)!.at).toBeLessThan(VIDEO_SECONDS);
  });
  it("maps clip times of demo-shelf.mp4 into the sped-up recording", () => {
    expect(CHAPTERS[1].at).toBe(11.5); // watching starts at clip 0:00
    expect(CHAPTERS.find((c) => c.title.includes("lays ของหมด"))!.at).toBeCloseTo(11.5 + 37.4 / 3, 1);
  });
  it("finds the chapter playing", () => {
    expect(chapterAt(0)).toBe(0);
    expect(chapterAt(11.49)).toBe(0);
    expect(chapterAt(11.5)).toBe(1);
    expect(chapterAt(999)).toBe(CHAPTERS.length - 1);
  });
});

describe("boxes", () => {
  it("splits named boxes from shelf-only products", () => {
    const { named, unknown } = splitBoxes([box("lays", 3), box("product", 110), box("pocky", 109)], 110);
    expect(named.map((b) => b.cls)).toEqual(["lays", "pocky"]);
    expect(unknown.map((b) => b.cls)).toEqual(["product"]);
    expect(distinctNames([box("lays", 3), box("lays", 3), box("copp", 7)])).toBe(2);
  });
  it("previews the DetectResult with rounded numbers and a box count", () => {
    const r = { version: "v0.3.2", backend: "wasm", latency_ms: 701.6, width: 1280, height: 720, boxes: [box("lays", 3, 0.876), box("copp", 7), box("product", 110)] };
    const text = jsonPreview(r);
    expect(text).toContain('"latency_ms": 702,');
    expect(text).toContain('"boxes": [ // 3 กล่อง');
    expect(text).toContain('{"cls":"lays","classId":3,"conf":0.88,"xyxy":[1,3,30,41]},');
    expect(text).toContain("…");
    expect(text).not.toContain("product");
    expect(jsonPreview({ ...r, boxes: [box("lays", 3)] })).not.toContain("…");
  });
});
