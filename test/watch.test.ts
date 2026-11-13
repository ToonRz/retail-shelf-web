import { describe, expect, it } from "vitest";
import type { Box } from "../src/agent-contract";
import { autoSlots, cropLabel, clipRect, cropRect, dragToRect, endMessage, fitView, fitViews, type Gray, IDENTITY, refineView, mapRect, type NBox, unmapRect, visibleFraction, type FoundItem, motionScore, newTrack, parseSlots, slotHasProduct, stageToFrame, stepTrack, toFoundItems, toGray, type Track, UNKNOWN_NAME } from "../src/ui/watch-logic";

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

describe("endMessage", () => {
  const slots = [{ id: "a", name: "lays", rect: [0, 0, 0.5, 0.5] as [number, number, number, number] }, { id: "b", name: "toro", rect: [0.5, 0, 0.5, 0.5] as [number, number, number, number] }];
  it("names slots that looked empty but not for the hold time yet", () => {
    const tracks = new Map<string, Track>([["a", { ...newTrack(), status: "stocked" }], ["b", { ...newTrack(), status: "checking", emptySince: 0 }]]);
    expect(endMessage(slots, tracks, 15)).toBe("วิดีโอจบแล้ว · toro ว่างยังไม่ถึง 15 วินาทีจึงยังไม่เตือน");
  });
  it("is plain when nothing is pending", () => {
    expect(endMessage(slots, new Map([["b", { ...newTrack(), status: "out" }]]), 15)).toBe("วิดีโอจบแล้ว");
  });
});

describe("follow the view", () => {
  // a 2-row shelf of 6 products, each a different size so no guess is ambiguous
  const ref: NBox[] = [[0.05, 0.05, 0.3, 0.45], [0.38, 0.1, 0.62, 0.45], [0.7, 0.05, 0.95, 0.42], [0.08, 0.55, 0.28, 0.95], [0.4, 0.52, 0.65, 0.93], [0.72, 0.58, 0.93, 0.95]];
  const move = (bs: NBox[], s: number, tx: number, ty: number): NBox[] => bs.map(([a, b, c, d]) => [s * a + tx, s * b + ty, s * c + tx, s * d + ty]);
  const near = (v: { s: number; tx: number; ty: number }, s: number, tx: number, ty: number) => {
    expect(v.s).toBeCloseTo(s, 3); expect(v.tx).toBeCloseTo(tx, 3); expect(v.ty).toBeCloseTo(ty, 3);
  };

  it("maps a rect there and back", () => {
    const v = { s: 1.5, tx: -0.2, ty: 0.1 };
    const r = mapRect([0.2, 0.3, 0.1, 0.2], v);
    expect(r.map((n) => +n.toFixed(6))).toEqual([0.1, 0.55, 0.15, 0.3]);
    expect(unmapRect(r, v).map((n) => +n.toFixed(6))).toEqual([0.2, 0.3, 0.1, 0.2]);
  });

  it("measures and clips the part inside the frame", () => {
    expect(visibleFraction([0.2, 0.2, 0.2, 0.2])).toBeCloseTo(1);
    expect(visibleFraction([-0.1, 0, 0.2, 0.5])).toBeCloseTo(0.5);
    expect(visibleFraction([1.1, 0, 0.2, 0.5])).toBe(0);
    expect(clipRect([-0.1, 0.9, 0.2, 0.2]).map((n) => +n.toFixed(6))).toEqual([0, 0.9, 0.1, 0.1]);
  });

  it("finds a small move from the last view", () => {
    near(fitView(ref, move(ref, 1.05, -0.02, 0.01), IDENTITY)!.view, 1.05, -0.02, 0.01);
  });

  const cut = (bs: NBox[]): NBox[] => bs.map(([a, b, c, d]) => [Math.max(0, a), Math.max(0, b), Math.min(1, c), Math.min(1, d)] as NBox)
    .filter(([a, b, c, d]) => c > a && d > b);

  it("finds a big zoom in one step, with products cut by the frame edge", () => {
    const cur = cut(move(ref, 1.25, -0.125, -0.1)); // zoom on the centre: only 1 product is still whole
    expect(cur.filter(([a, b, c, d]) => a > 0.01 && b > 0.01 && c < 0.99 && d < 0.99).length).toBe(1);
    near(fitView(ref, cur, IDENTITY)!.view, 1.25, -0.125, -0.1);
    near(fitView(ref, cut(move(ref, 1.6, -0.3, -0.25)), { s: 1.5, tx: -0.27, ty: -0.22 })!.view, 1.6, -0.3, -0.25);
  });

  it("ignores products taken away and boxes that were not there before", () => {
    const cur = [...move(ref, 0.8, 0.1, 0.05).slice(0, 4), [0.9, 0.9, 0.97, 0.98] as NBox];
    const f = fitView(ref, cur, IDENTITY)!;
    near(f.view, 0.8, 0.1, 0.05);
    expect(f.matched).toBe(4);
  });

  it("keeps to the last view on a row of identical products", () => {
    const row: NBox[] = [0, 1, 2, 3, 4].map((i) => [0.1 + i * 0.16, 0.3, 0.24 + i * 0.16, 0.6]);
    const prev = { s: 1, tx: 0.04, ty: 0 };
    near(fitView(row, row.map(([a, b, c, d]) => [a + 0.05, b, c + 0.05, d] as NBox), prev)!.view, 1, 0.05, 0);
  });

  it("offers every view that fits a grid of equal products zoomed so a column is out of the frame", () => {
    // 4 columns x 2 rows of the same size; zoom on the right 3 columns: one column to the left fits the 6 boxes as well
    const grid: NBox[] = [0, 1].flatMap((r) => [0, 1, 2, 3].map((c) => [0.03 + c * 0.24, 0.1 + r * 0.42, 0.21 + c * 0.24, 0.45 + r * 0.42] as NBox));
    const s = 1 / 0.72, truth = { s, tx: -0.27 * s, ty: -0.05 };
    const cur = cut(move(grid, truth.s, truth.tx, truth.ty)).filter(([a, , c]) => c - a > 0.1);
    const views = fitViews(grid, cur, IDENTITY).map((f) => f.view);
    expect(views.some((v) => Math.abs(v.s - truth.s) < 0.01 && Math.abs(v.tx - truth.tx) < 0.01 && Math.abs(v.ty - truth.ty) < 0.01)).toBe(true);
    expect(views.some((v) => Math.abs(v.tx - (truth.tx + 0.24 * s)) < 0.01)).toBe(true); // one column off
  });

  it("gives up when nothing agrees", () => {
    expect(fitView(ref, [], IDENTITY)).toBeNull();
    expect(fitView(ref, [[0.4, 0.4, 0.42, 0.9]], IDENTITY)).toBeNull();
  });
});

describe("refineView", () => {
  // a shelf as a function of reference coordinates (0..1): a light back wall, two shelf strips and six products
  // of different shades; outside it the camera sees a dark wall
  const products: Array<[number, number, number, number, number]> = [[0.05, 0.05, 0.3, 0.45, 60], [0.38, 0.1, 0.62, 0.45, 200], [0.7, 0.05, 0.95, 0.42, 90],
    [0.08, 0.55, 0.28, 0.95, 160], [0.4, 0.52, 0.65, 0.93, 40], [0.72, 0.58, 0.93, 0.95, 230]];
  const scene = (u: number, v: number) => {
    if (u < 0 || u > 1 || v < 0 || v > 1) return 30;
    const p = products.find(([a, b, c, d]) => u >= a && u <= c && v >= b && v <= d);
    if (p) return p[4] + 20 * Math.sin(40 * u) * Math.sin(30 * v); // print on the pack
    return (v > 0.46 && v < 0.5) || v > 0.96 ? 245 : 150 + 10 * Math.sin(60 * u);
  };
  const render = (view: { s: number; tx: number; ty: number }, hole?: [number, number, number, number]): Gray => {
    const w = 128, h = 96, px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / w, fy = (y + 0.5) / h;
      const inHole = hole && fx >= hole[0] && fx <= hole[2] && fy >= hole[1] && fy <= hole[3];
      px[y * w + x] = inHole ? 200 : Math.max(0, Math.min(255, Math.round(scene((fx - view.tx) / view.s, (fy - view.ty) / view.s))));
    }
    return { w, h, px };
  };

  it("pins the zoom and pan from a rough guess, with part of the shelf changed", () => {
    const truth = { s: 1.3, tx: -0.15, ty: -0.135 };
    const r = refineView(render(IDENTITY), render(truth, [0.3, 0.6, 0.6, 0.95]) /* one product taken away */, [{ s: 1.17, tx: -0.126, ty: -0.037 }, IDENTITY]);
    expect(r.view.s).toBeCloseTo(1.3, 1);
    expect(Math.abs(r.view.s - 1.3)).toBeLessThan(0.02);
    expect(Math.abs(r.view.tx + 0.15)).toBeLessThan(0.01);
    expect(Math.abs(r.view.ty + 0.135)).toBeLessThan(0.01);
    expect(r.score).toBeGreaterThan(0.7);
    expect(r.sharp).toBeGreaterThan(0.05);
  });

  it("picks the true view among views one product apart, with the reference seen whole on a dark wall", () => {
    // reference: the whole shelf shrunk into the middle of the frame (dark wall around it); now: zoomed on its right part
    const refView = { s: 0.7, tx: 0.15, ty: 0.15 }, truth = { s: 1.2, tx: -0.35, ty: -0.1 };
    const at = (v: typeof truth) => ({ s: v.s / refView.s, tx: v.tx - (v.s / refView.s) * refView.tx, ty: v.ty - (v.s / refView.s) * refView.ty });
    const shifted = { ...truth, tx: truth.tx + 0.33 * truth.s }; // one product to the left
    const r = refineView(render(refView), render(truth), [at(shifted), at({ ...truth, tx: truth.tx + 0.02 })]);
    expect(Math.abs(r.view.s - at(truth).s)).toBeLessThan(0.03);
    expect(Math.abs(r.view.tx - at(truth).tx)).toBeLessThan(0.015);
    expect(Math.abs(r.view.ty - at(truth).ty)).toBeLessThan(0.015);
  });

  it("finds no clear match on a picture of something else", () => {
    const other: Gray = { w: 128, h: 96, px: Uint8Array.from({ length: 128 * 96 }, (_, i) => (i * 7919) % 251) };
    expect(refineView(render(IDENTITY), other, [IDENTITY]).sharp).toBeLessThan(0.03);
  });
});
