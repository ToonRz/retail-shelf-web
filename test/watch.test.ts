import { describe, expect, it } from "vitest";
import type { Box } from "../src/agent-contract";
import { dragToRect, motionScore, newTrack, parseSlots, slotHasProduct, stageToFrame, stepTrack, toGray, type Track } from "../src/ui/watch-logic";

const cfg = { holdMs: 10_000, clearMs: 3_000 };
const box = (x1: number, y1: number, x2: number, y2: number): Box => ({ cls: "product", classId: 0, conf: 0.9, xyxy: [x1, y1, x2, y2] });

/** Feed [time, hasProduct, blocked] and collect the events. */
function run(seq: Array<[number, boolean, boolean?]>, start: Track = newTrack()) {
  let t = start;
  const events: Array<[number, string]> = [];
  for (const [now, has, blocked] of seq) {
    const r = stepTrack(t, has, blocked ?? false, now, cfg);
    t = r.track;
    if (r.event) events.push([now, r.event]);
  }
  return { track: t, events };
}

describe("stepTrack", () => {
  it("alerts once, only after the slot has looked empty for the whole hold time", () => {
    const r = run([[0, true], [1000, false], [5000, false], [10_999, false], [11_000, false], [20_000, false]]);
    expect(r.events).toEqual([[11_000, "out"]]);
    expect(r.track.status).toBe("out");
  });
  it("does not alert on a brief miss", () => {
    const r = run([[0, false], [5000, false], [6000, true], [7000, false], [16_000, false]]);
    expect(r.events).toEqual([]);
    expect(r.track.status).toBe("checking");
  });
  it("pauses the wait while someone blocks the slot and keeps the status", () => {
    const r = run([[0, true], [1000, false], [5000, false], [9000, false, true], [10_000, false, true], [11_000, false], [15_999, false], [16_000, false]]);
    expect(r.events).toEqual([[16_000, "out"]]); // 1000-5000 + 10 000-16 000 counted; the blocked stretch is not
    expect(run([[0, true], [1000, false, true]]).track.status).toBe("stocked");
  });
  it("alerts for a slot that is empty from the start", () => {
    expect(run([[0, false], [10_000, false]]).events).toEqual([[10_000, "out"]]);
  });
  it("clears a raised alert only after the slot stays filled", () => {
    const out = run([[0, false], [10_000, false]]).track;
    expect(run([[20_000, true], [21_000, false], [22_000, true], [24_999, true]], out).events).toEqual([]);
    const r = run([[20_000, true], [23_000, true]], out);
    expect(r.events).toEqual([[23_000, "restocked"]]);
    expect(r.track.status).toBe("stocked");
  });
});

describe("slotHasProduct", () => {
  it("counts a real product and ignores tiny boxes and neighbours at the edge", () => {
    expect(slotHasProduct([box(20, 20, 80, 80)], 100, 100)).toBe(true);
    expect(slotHasProduct([box(40, 40, 50, 50)], 100, 100)).toBe(false);
    expect(slotHasProduct([box(92, 10, 100, 90)], 100, 100)).toBe(false);
    expect(slotHasProduct([], 100, 100)).toBe(false);
  });
});

describe("motion", () => {
  it("is zero for identical thumbnails and grows with the change", () => {
    const a = toGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]));
    expect([...a]).toEqual([255, 0]);
    expect(motionScore(a, a)).toBe(0);
    expect(motionScore(new Uint8Array([0, 0]), new Uint8Array([100, 0]))).toBe(50);
  });
});

describe("drawing", () => {
  it("maps a pointer through object-fit: contain", () => {
    expect(stageToFrame(100, 50, 200, 100, 100, 100)).toEqual([0.5, 0.5]);
    expect(stageToFrame(50, 0, 200, 100, 100, 100)).toEqual([0, 0]);
    expect(stageToFrame(0, 0, 200, 100, 100, 100)).toEqual([0, 0]);
  });
  it("normalizes a drag in any direction and rejects a click", () => {
    expect(dragToRect(0.5, 0.6, 0.1, 0.2)?.map((v) => Math.round(v * 10) / 10)).toEqual([0.1, 0.2, 0.4, 0.4]);
    expect(dragToRect(0.5, 0.5, 0.51, 0.51)).toBeNull();
  });
  it("drops malformed saved slots", () => {
    const ok = { id: "a", name: "A", rect: [0, 0, 0.5, 0.5] };
    expect(parseSlots(JSON.stringify([ok, { id: "b", name: "B", rect: [0, 2, 1, 1] }, null]))).toEqual([ok]);
    expect(parseSlots("not json")).toEqual([]);
    expect(parseSlots(null)).toEqual([]);
  });
});
