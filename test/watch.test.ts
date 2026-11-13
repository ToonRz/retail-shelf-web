import { describe, expect, it } from "vitest";
import type { Box } from "../src/agent-contract";
import { autoSlots, cropLabel, cropRect, dragToRect, type FoundItem, motionScore, newTrack, parseSlots, slotHasProduct, stageToFrame, stepTrack, toFoundItems, toGray, type Track, UNKNOWN_NAME } from "../src/ui/watch-logic";

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

describe("auto slots", () => {
  const it_ = (name: string | null, x1: number, y1: number, x2: number, y2: number): FoundItem => ({ name, xyxy: [x1, y1, x2, y2] });
  const named = (cls: string, classId: number, x1: number, y1: number, x2: number, y2: number, conf = 0.9): Box => ({ cls, classId, conf, xyxy: [x1, y1, x2, y2] });
  const r2 = (n: number) => Math.round(n * 1000) / 1000;

  it("joins same-name neighbours of one row and splits rows and names", () => {
    const items = [
      it_("pepsi", 0, 0, 100, 200), it_("pepsi", 105, 5, 205, 205), it_("lays", 210, 0, 310, 200), // top row
      it_("pepsi", 0, 300, 100, 500), it_(null, 110, 300, 210, 500), it_(null, 215, 305, 315, 505), // bottom row
    ];
    const s = autoSlots(items, 1000, 1000);
    expect(s.map((x) => x.name)).toEqual(["pepsi", "lays", "pepsi 2", UNKNOWN_NAME]);
    // pepsi top: union 0..205 x 0..205 grown by 4 %
    expect(s[0].rect.map(r2)).toEqual([0, 0, r2((205 + 205 * 0.04) / 1000), r2((205 + 205 * 0.04) / 1000)]);
    expect(s.every(({ rect: [x, y, w, h] }) => x >= 0 && y >= 0 && x + w <= 1 && y + h <= 1)).toBe(true);
  });

  it("starts a new slot across a wide gap and finds rows whatever the input order", () => {
    const items = [it_("a", 600, 10, 700, 110), it_("a", 0, 0, 100, 100), it_("a", 110, 0, 210, 100)];
    const s = autoSlots(items, 1000, 1000);
    expect(s.map((x) => x.name)).toEqual(["a", "a 2"]);
    expect(s[0].rect[0]).toBe(0);
  });

  it("splits a long run evenly so each slot still counts as stocked when it is full", () => {
    const row = Array.from({ length: 10 }, (_, i) => it_("water", 100 + i * 50, 100, 148 + i * 50, 300)); // away from the frame edge, where the padding is clamped
    const s = autoSlots(row, 1000, 1000);
    expect(s.length).toBe(2);
    for (const { rect: [x, y, w, h] } of s) {
      const W = 1000, H = 1000;
      const inSlot = row.filter((b) => b.xyxy[0] >= x * W - 1 && b.xyxy[2] <= (x + w) * W + 1)
        .map((b) => ({ cls: "product", classId: 110, conf: 0.9, xyxy: [b.xyxy[0] - x * W, b.xyxy[1] - y * H, b.xyxy[2] - x * W, b.xyxy[3] - y * H] as Box["xyxy"] }));
      expect(inSlot.length).toBe(5);
      expect(slotHasProduct(inSlot, w * W, h * H)).toBe(true);
      for (const one of inSlot) expect(slotHasProduct([one], w * W, h * H)).toBe(true); // the last facing left, even at the edge, still counts
    }
    // at the cap (6) the edge facing is still inside slotHasProduct's inner 80 %
    const six = autoSlots(row.slice(0, 6), 1000, 1000);
    expect(six.length).toBe(1);
    const [x, y, w, h] = six[0].rect;
    const edge: Box = { cls: "product", classId: 110, conf: 0.9, xyxy: [100 - x * 1000, 100 - y * 1000, 148 - x * 1000, 300 - y * 1000] };
    expect(slotHasProduct([edge], w * 1000, h * 1000)).toBe(true);
    expect(autoSlots([], 100, 100)).toEqual([]);
  });

  it("names 110-class boxes, leaves shelf-model boxes unknown and drops frame-sized boxes", () => {
    const boxes = [named("pepsi", 3, 0, 0, 10, 10), named("product", 110, 20, 0, 30, 10), named("lays", 5, 0, 0, 100, 90)];
    expect(toFoundItems(boxes, 110, 100, 100)).toEqual([{ name: "pepsi", xyxy: [0, 0, 10, 10] }, { name: null, xyxy: [20, 0, 30, 10] }]);
  });

  it("takes the name of a crop from the most confident centred named box", () => {
    expect(cropLabel([named("a", 1, 40, 40, 60, 60, 0.6), named("b", 2, 30, 30, 70, 70, 0.8), named("product", 110, 40, 40, 60, 60, 0.99)], 110, 100, 100)).toBe("b");
    expect(cropLabel([named("edge", 1, 80, 0, 100, 40)], 110, 100, 100)).toBeNull();
    expect(cropLabel([], 110, 100, 100)).toBeNull();
  });

  it("pads a crop around a box and keeps it inside the frame", () => {
    expect(cropRect([10, 10, 30, 50], 100, 100, 0.1)).toEqual([8, 6, 24, 48]);
    expect(cropRect([0, 0, 100, 100], 100, 100)).toEqual([0, 0, 100, 100]);
  });
});
