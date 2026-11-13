// Pure logic of the shelf watch page (src/watch.ts), unit-tested in test/watch.test.ts.
import type { Box } from "../agent-contract";

export type Rect = [number, number, number, number]; // x, y, w, h as fractions of the frame
export interface Slot { id: string; name: string; rect: Rect }

export type SlotStatus = "waiting" | "stocked" | "checking" | "out";
export interface Track { status: SlotStatus; emptySince: number | null; filledSince: number | null; lastAt: number | null }
export interface WatchConfig { holdMs: number; clearMs: number }
export type SlotEvent = "out" | "restocked" | null;

export const newTrack = (): Track => ({ status: "waiting", emptySince: null, filledSince: null, lastAt: null });

/**
 * One observation of a slot. An alert needs the slot to look empty for holdMs in a row, and a raised
 * alert clears only after it looks filled for clearMs. A blocked slot (someone in front of it) says
 * nothing about the stock, so it keeps the status and pauses both timers.
 */
export function stepTrack(t: Track, hasProduct: boolean, blocked: boolean, now: number, cfg: WatchConfig): { track: Track; event: SlotEvent } {
  if (blocked) {
    const dt = t.lastAt === null ? 0 : now - t.lastAt;
    return { track: { ...t, lastAt: now, emptySince: t.emptySince === null ? null : t.emptySince + dt, filledSince: t.filledSince === null ? null : t.filledSince + dt }, event: null };
  }
  if (hasProduct) {
    if (t.status !== "out") return { track: { status: "stocked", emptySince: null, filledSince: null, lastAt: now }, event: null };
    const filledSince = t.filledSince ?? now;
    if (now - filledSince >= cfg.clearMs) return { track: { status: "stocked", emptySince: null, filledSince: null, lastAt: now }, event: "restocked" };
    return { track: { ...t, emptySince: null, filledSince, lastAt: now }, event: null };
  }
  if (t.status === "out") return { track: { ...t, filledSince: null, lastAt: now }, event: null };
  const emptySince = t.emptySince ?? now;
  if (now - emptySince >= cfg.holdMs) return { track: { status: "out", emptySince, filledSince: null, lastAt: now }, event: "out" };
  return { track: { status: "checking", emptySince, filledSince: null, lastAt: now }, event: null };
}

/** Does a detection on the slot crop count as stock? Tiny boxes and products of the neighbouring slot peeking in at the edge do not. */
export function slotHasProduct(boxes: Box[], width: number, height: number, minArea = 0.04, inset = 0.1): boolean {
  return boxes.some(({ xyxy: [x1, y1, x2, y2] }) => {
    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    return ((x2 - x1) * (y2 - y1)) / (width * height) >= minArea
      && cx >= width * inset && cx <= width * (1 - inset) && cy >= height * inset && cy <= height * (1 - inset);
  });
}

/** RGBA pixels -> grayscale (for motionScore). */
export function toGray(rgba: Uint8ClampedArray): Uint8Array {
  const g = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < g.length; i++) g[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  return g;
}

/** Mean absolute difference (0-255) between two grayscale thumbnails of a slot. */
export function motionScore(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** Point on an element -> fraction of the frame shown inside it with object-fit: contain, clamped to the frame. */
export function stageToFrame(px: number, py: number, stageW: number, stageH: number, frameW: number, frameH: number): [number, number] {
  const s = Math.min(stageW / frameW, stageH / frameH);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp((px - (stageW - frameW * s) / 2) / (frameW * s)), clamp((py - (stageH - frameH * s) / 2) / (frameH * s))];
}

/** Normalize a drag into a Rect; null when it is too small to be a deliberate slot. */
export function dragToRect(x0: number, y0: number, x1: number, y1: number, minSize = 0.03): Rect | null {
  const w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
  return w < minSize || h < minSize ? null : [Math.min(x0, x1), Math.min(y0, y1), w, h];
}

/** Slots saved in localStorage; anything malformed is dropped instead of breaking the page. */
export function parseSlots(json: string | null): Slot[] {
  try {
    const v = JSON.parse(json ?? "[]") as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((s): s is Slot => typeof s?.id === "string" && typeof s?.name === "string" && Array.isArray(s?.rect)
      && s.rect.length === 4 && s.rect.every((n: unknown) => typeof n === "number" && n >= 0 && n <= 1));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- auto slots

/** A product found on the full frame: name from the 110-class model, null when it is only a shelf-model "product" box. */
export interface FoundItem { name: string | null; xyxy: [number, number, number, number] }

export const UNKNOWN_NAME = "สินค้าอื่น";
export const AUTO_MAX_PER_SLOT = 6; // more facings per slot and the edge products fall outside slotHasProduct's inner 80%
const AUTO_PAD = 0.04;              // slot = union of its boxes grown by this much of its own size on each side
const AUTO_MAX_GAP = 0.5;           // same-name neighbours further apart than this many box widths start a new slot
const AUTO_MAX_AREA = 0.4;          // a box covering more of the frame than this is not one product on a shelf

/** Named boxes keep their class; boxes of the shelf model (classId >= classes of the 110-class model) are unknown. */
export function toFoundItems(boxes: Box[], classes: number, width: number, height: number): FoundItem[] {
  return boxes
    .filter(({ xyxy: [x1, y1, x2, y2] }) => ((x2 - x1) * (y2 - y1)) / (width * height) <= AUTO_MAX_AREA)
    .map((b) => ({ name: b.classId < classes ? b.cls : null, xyxy: b.xyxy }));
}

/** Pixel rect [x, y, w, h] around a box grown by pad of its size on each side, clamped to the frame (for createImageBitmap). */
export function cropRect([x1, y1, x2, y2]: [number, number, number, number], width: number, height: number, pad = 0.15): [number, number, number, number] {
  const px = (x2 - x1) * pad, py = (y2 - y1) * pad;
  const l = Math.max(0, Math.floor(x1 - px)), t = Math.max(0, Math.floor(y1 - py));
  const r = Math.min(width, Math.ceil(x2 + px)), b = Math.min(height, Math.ceil(y2 + py));
  return [l, t, Math.max(1, r - l), Math.max(1, b - t)];
}

/** Name of the product in a crop around one box: the most confident named box centred in the crop, else null. */
export function cropLabel(boxes: Box[], classes: number, width: number, height: number): string | null {
  const hit = boxes
    .filter((b) => b.classId < classes)
    .filter(({ xyxy: [x1, y1, x2, y2] }) => {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
      return cx >= width * 0.25 && cx <= width * 0.75 && cy >= height * 0.25 && cy <= height * 0.75;
    })
    .sort((a, b) => b.conf - a.conf)[0];
  return hit?.cls ?? null;
}

/**
 * Turn the products seen on a full shelf into slots: boxes are split into shelf rows (vertical overlap),
 * neighbours in a row with the same name are joined into one slot, and a long run is split evenly so a
 * slot holds at most maxPerSlot facings. Slots come out top to bottom, left to right, with unique names.
 */
export function autoSlots(items: FoundItem[], width: number, height: number, maxPerSlot = AUTO_MAX_PER_SLOT): Array<{ name: string; rect: Rect }> {
  // 1. rows
  type Row = { items: FoundItem[]; y1: number; y2: number };
  const rows: Row[] = [];
  const byCy = [...items].sort((a, b) => a.xyxy[1] + a.xyxy[3] - (b.xyxy[1] + b.xyxy[3]));
  for (const it of byCy) {
    const [, y1, , y2] = it.xyxy;
    let best: Row | null = null, bestOverlap = 0;
    for (const r of rows) {
      const ov = Math.min(y2, r.y2) - Math.max(y1, r.y1);
      if (ov >= 0.5 * Math.min(y2 - y1, r.y2 - r.y1) && ov > bestOverlap) { best = r; bestOverlap = ov; }
    }
    if (best) {
      best.items.push(it);
      const n = best.items.length; // row band = mean top / bottom of its boxes
      best.y1 += (y1 - best.y1) / n;
      best.y2 += (y2 - best.y2) / n;
    } else rows.push({ items: [it], y1, y2 });
  }
  rows.sort((a, b) => a.y1 + a.y2 - (b.y1 + b.y2));

  // 2. runs of the same name inside each row, then split long runs evenly
  const groups: FoundItem[][] = [];
  for (const r of rows) {
    const xs = r.items.sort((a, b) => a.xyxy[0] + a.xyxy[2] - (b.xyxy[0] + b.xyxy[2]));
    let run: FoundItem[] = [];
    const flush = () => {
      const k = Math.ceil(run.length / maxPerSlot);
      for (let i = 0; i < k; i++) groups.push(run.slice(Math.round((i * run.length) / k), Math.round(((i + 1) * run.length) / k)));
      run = [];
    };
    for (const it of xs) {
      const prev = run[run.length - 1];
      const gap = prev ? it.xyxy[0] - prev.xyxy[2] : 0;
      const w = prev ? ((prev.xyxy[2] - prev.xyxy[0]) + (it.xyxy[2] - it.xyxy[0])) / 2 : 0;
      if (prev && (prev.name !== it.name || gap > AUTO_MAX_GAP * w)) flush();
      run.push(it);
    }
    if (run.length) flush();
  }

  // 3. rect + unique name
  const seen = new Map<string, number>();
  return groups.map((g) => {
    const x1 = Math.min(...g.map((i) => i.xyxy[0])), y1 = Math.min(...g.map((i) => i.xyxy[1]));
    const x2 = Math.max(...g.map((i) => i.xyxy[2])), y2 = Math.max(...g.map((i) => i.xyxy[3]));
    const px = (x2 - x1) * AUTO_PAD, py = (y2 - y1) * AUTO_PAD;
    const l = Math.max(0, x1 - px) / width, t = Math.max(0, y1 - py) / height;
    const r = Math.min(width, x2 + px) / width, b = Math.min(height, y2 + py) / height;
    const base = g[0].name ?? UNKNOWN_NAME;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { name: n === 1 ? base : `${base} ${n}`, rect: [l, t, r - l, b - t] as Rect };
  });
}

/** Status when a video file ends: slots that looked empty for less than the hold time never alerted, so name them. */
export function endMessage(slots: Slot[], tracks: Map<string, Track>, holdSec: number): string {
  const pending = slots.filter((s) => tracks.get(s.id)?.status === "checking").map((s) => s.name);
  return pending.length ? `วิดีโอจบแล้ว · ${pending.join(", ")} ว่างยังไม่ถึง ${holdSec} วินาทีจึงยังไม่เตือน` : "วิดีโอจบแล้ว";
}

export const STATUS_TH: Record<SlotStatus, string> = { waiting: "รอตรวจ", stocked: "มีของ", checking: "กำลังยืนยัน", out: "ของหมด" };

// ---------------------------------------------------------------- follow the view (camera zoom / pan)

/**
 * Where the reference picture (the one the slots were drawn on) is in the current frame, all in fractions of the
 * frame: a point p of the reference is at s * p + t now. Zoom and pan only: a shelf camera does not roll.
 */
export interface View { s: number; tx: number; ty: number }
export const IDENTITY: View = { s: 1, tx: 0, ty: 0 };
export type NBox = [number, number, number, number]; // x1, y1, x2, y2 as fractions of the frame

export const mapRect = ([x, y, w, h]: Rect, v: View): Rect => [v.s * x + v.tx, v.s * y + v.ty, v.s * w, v.s * h];
export const unmapRect = ([x, y, w, h]: Rect, v: View): Rect => [(x - v.tx) / v.s, (y - v.ty) / v.s, w / v.s, h / v.s];
const mapBox = ([x1, y1, x2, y2]: NBox, v: View): NBox => [v.s * x1 + v.tx, v.s * y1 + v.ty, v.s * x2 + v.tx, v.s * y2 + v.ty];

/** Share of a rect that is inside the frame (0 when it is all outside). */
export function visibleFraction([x, y, w, h]: Rect): number {
  const iw = Math.max(0, Math.min(1, x + w) - Math.max(0, x)), ih = Math.max(0, Math.min(1, y + h) - Math.max(0, y));
  return w > 0 && h > 0 ? (iw * ih) / (w * h) : 0;
}

/** The part of a rect inside the frame. */
export function clipRect([x, y, w, h]: Rect): Rect {
  const l = Math.max(0, x), t = Math.max(0, y);
  return [l, t, Math.max(0, Math.min(1, x + w) - l), Math.max(0, Math.min(1, y + h) - t)];
}

export const normBoxes = (boxes: Box[], width: number, height: number): NBox[] =>
  boxes.map(({ xyxy: [x1, y1, x2, y2] }) => [x1 / width, y1 / height, x2 / width, y2 / height]);

const area = ([x1, y1, x2, y2]: NBox) => Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
function iou(a: NBox, b: NBox): number {
  const i = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  return i > 0 ? i / (area(a) + area(b) - i) : 0;
}
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const FOLLOW_IOU = 0.4;     // a reference box moved by the view must overlap a box of this frame this much to count
const FOLLOW_MAX_BOXES = 40; // largest boxes only: keeps the search fast on a dense shelf
const FOLLOW_ZOOM = [0.33, 3] as const;

const EDGE = 0.01; // a box edge this close to the frame border is where the frame cuts the product, not its edge
const clip01 = ([x1, y1, x2, y2]: NBox): NBox => [Math.max(0, x1), Math.max(0, y1), Math.min(1, x2), Math.min(1, y2)];
const whole = (b: NBox) => b[0] > EDGE && b[1] > EDGE && b[2] < 1 - EDGE && b[3] < 1 - EDGE;

/** Reference boxes moved by the view (and cut by the frame, as the detector sees them) paired with a box of this frame. */
function matches(ref: NBox[], cur: NBox[], v: View): Array<[NBox, NBox]> {
  const out: Array<[NBox, NBox]> = [];
  for (const r of ref) {
    const m = clip01(mapBox(r, v));
    if (area(m) <= 0) continue;
    let best: NBox | null = null, bestIou = FOLLOW_IOU;
    for (const c of cur) { const o = iou(m, c); if (o >= bestIou) { best = c; bestIou = o; } }
    if (best) out.push([r, best]);
  }
  return out;
}

/**
 * Zoom + pan from matched pairs: every box edge that is a real product edge (not where the frame cuts the product)
 * says current = s * reference + t on its axis; least squares over all of them. Falls back to medians of the
 * whole boxes when the edges cannot fix the zoom.
 */
function solve(pairs: Array<[NBox, NBox]>): View {
  // normal equations for [s, tx, ty]; an x edge is the row [r, 1, 0] = c, a y edge [r, 0, 1] = c. Eliminating tx, ty:
  // s * (Σr² - (Σxr)²/nx - (Σyr)²/ny) = Σrc - Σxr·Σxc/nx - Σyr·Σyc/ny
  let rr = 0, rc = 0, xr = 0, xc = 0, nx = 0, yr = 0, yc = 0, ny = 0;
  const edge = (r: number, c: number, x: boolean) => {
    rr += r * r; rc += r * c;
    if (x) { xr += r; xc += c; nx++; } else { yr += r; yc += c; ny++; }
  };
  for (const [r, c] of pairs) {
    if (c[0] > EDGE) edge(r[0], c[0], true);
    if (c[2] < 1 - EDGE) edge(r[2], c[2], true);
    if (c[1] > EDGE) edge(r[1], c[1], false);
    if (c[3] < 1 - EDGE) edge(r[3], c[3], false);
  }
  const den = nx && ny ? rr - (xr * xr) / nx - (yr * yr) / ny : 0;
  if (den > 1e-6) {
    const s = (rc - (xr * xc) / nx - (yr * yc) / ny) / den;
    return { s, tx: (xc - s * xr) / nx, ty: (yc - s * yr) / ny };
  }
  const s = median(pairs.map(([r, c]) => Math.sqrt(area(c) / area(r))));
  return {
    s,
    tx: median(pairs.map(([r, c]) => (c[0] + c[2]) / 2 - s * (r[0] + r[2]) / 2)),
    ty: median(pairs.map(([r, c]) => (c[1] + c[3]) / 2 - s * (r[1] + r[3]) / 2)),
  };
}

const FOLLOW_MAX_VIEWS = 6; // candidate views handed to refineView

/**
 * Candidate views of this frame from the product boxes of the reference picture and of this frame, best first.
 * Products taken away (or new ones) just do not match; the rest agree on one zoom + pan. Every reference / current
 * pair is tried as a guess (guesses come from products whole in the frame, but products cut by the frame edge still
 * count as matches), as well as the last view.
 *
 * Boxes alone cannot always tell where the frame is: on a shelf of equal-sized products in a grid, zoomed so that
 * some columns are out of the frame, the view shifted by one column matches just as many boxes as the true one
 * (it brings the next column into the frame instead). So every view that matches nearly as many boxes as the best
 * one is returned, and refineView picks among them by the pictures. Equal matches: closest to the last view first.
 * Empty when fewer than 2 products (1 if there is only 1) agree.
 */
export function fitViews(ref: NBox[], cur: NBox[], prev: View): Array<{ view: View; matched: number }> {
  const big = (bs: NBox[]) => [...bs].filter((b) => area(b) > 0).sort((a, b) => area(b) - area(a)).slice(0, FOLLOW_MAX_BOXES);
  const R = big(ref), C = big(cur);
  const need = Math.min(2, R.length, C.length);
  if (need === 0) return [];
  const off = (v: View) => Math.abs(Math.log(v.s / prev.s)) + Math.abs(v.tx - prev.tx) + Math.abs(v.ty - prev.ty);
  const same = (a: View, b: View) => Math.abs(Math.log(a.s / b.s)) < 0.04 && Math.abs(a.tx - b.tx) < 0.03 && Math.abs(a.ty - b.ty) < 0.03;
  const guesses: Array<{ view: View; pairs: Array<[NBox, NBox]> }> = [{ view: prev, pairs: matches(R, C, prev) }];
  for (const r of R) for (const c of C.filter(whole)) { // a cut box has the wrong size: no guess from it
    const ar = (r[2] - r[0]) / (r[3] - r[1]), ac = (c[2] - c[0]) / (c[3] - c[1]);
    const s = Math.sqrt(area(c) / area(r));
    if (ar / ac > 1.33 || ac / ar > 1.33 || s < FOLLOW_ZOOM[0] || s > FOLLOW_ZOOM[1]) continue;
    const view = { s, tx: (c[0] + c[2]) / 2 - s * (r[0] + r[2]) / 2, ty: (c[1] + c[3]) / 2 - s * (r[1] + r[3]) / 2 };
    guesses.push({ view, pairs: matches(R, C, view) });
  }
  const top = Math.max(...guesses.map((g) => g.pairs.length));
  if (top < need) return [];
  const out: Array<{ view: View; matched: number }> = [];
  for (const g of guesses.filter((x) => x.pairs.length >= Math.max(need, top - 1))) {
    let pairs = g.pairs, view = solve(pairs);
    const again = matches(R, C, view);
    if (again.length >= pairs.length) { pairs = again; view = solve(again); }
    if (view.s < FOLLOW_ZOOM[0] || view.s > FOLLOW_ZOOM[1]) continue;
    const dup = out.find((o) => same(o.view, view));
    if (!dup) out.push({ view, matched: pairs.length });
    else if (pairs.length > dup.matched || (pairs.length === dup.matched && off(view) < off(dup.view))) Object.assign(dup, { view, matched: pairs.length });
  }
  return out.sort((a, b) => b.matched - a.matched || off(a.view) - off(b.view)).slice(0, FOLLOW_MAX_VIEWS);
}

/** The best of fitViews, or null. */
export function fitView(ref: NBox[], cur: NBox[], prev: View): { view: View; matched: number } | null {
  return fitViews(ref, cur, prev)[0] ?? null;
}

/** A small grayscale copy of a frame (see toGray), for refineView. */
export interface Gray { w: number; h: number; px: Uint8Array }

/** Half-size copy (2x2 mean). */
export function halve(g: Gray): Gray {
  const w = g.w >> 1, h = g.h >> 1, px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * g.w + 2 * x;
    px[y * w + x] = (g.px[i] + g.px[i + 1] + g.px[i + g.w] + g.px[i + g.w + 1] + 2) >> 2;
  }
  return { w, h, px };
}

const CAP = 1; // a pixel that differs by more than this (in spreads) costs no more: products taken away do not pull the match

/**
 * How well the reference picture, put where `v` says, matches the current one: 1 - mean capped difference over the
 * pixels both share (higher is better), or -1 when they share less than half of the current frame. Brightness is
 * brought to mean 0, spread 1 over the shared pixels only (so a camera that adjusts its exposure still matches): over
 * the whole pictures, the dark wall around a shelf seen whole would make the same shelf look brighter in the
 * reference than in a zoomed frame that is all shelf, and the best match would land beside the truth.
 */
export function viewScore(ref: Gray, cur: Gray, v: View): number {
  const col = new Int32Array(cur.w);
  for (let x = 0; x < cur.w; x++) {
    const q = ((x + 0.5) / cur.w - v.tx) / v.s;
    col[x] = q >= 0 && q < 1 ? Math.floor(q * ref.w) : -1;
  }
  const row = new Int32Array(cur.h);
  for (let y = 0; y < cur.h; y++) {
    const q = ((y + 0.5) / cur.h - v.ty) / v.s;
    row[y] = q >= 0 && q < 1 ? Math.floor(q * ref.h) * ref.w : -1;
  }
  let n = 0, sr = 0, srr = 0, sc = 0, scc = 0;
  for (let y = 0; y < cur.h; y++) {
    const ro = row[y], co = y * cur.w;
    if (ro < 0) continue;
    for (let x = 0; x < cur.w; x++) {
      if (col[x] < 0) continue;
      const a = ref.px[ro + col[x]], b = cur.px[co + x];
      n++; sr += a; srr += a * a; sc += b; scc += b * b;
    }
  }
  if (n < (cur.w * cur.h) / 2) return -1;
  const mr = sr / n, mc = sc / n;
  const kr = 1 / (Math.sqrt(Math.max(0, srr / n - mr * mr)) || 1), kc = 1 / (Math.sqrt(Math.max(0, scc / n - mc * mc)) || 1);
  let cost = 0;
  for (let y = 0; y < cur.h; y++) {
    const ro = row[y], co = y * cur.w;
    if (ro < 0) continue;
    for (let x = 0; x < cur.w; x++) {
      if (col[x] < 0) continue;
      cost += Math.min(CAP, Math.abs((cur.px[co + x] - mc) * kc - (ref.px[ro + col[x]] - mr) * kr));
    }
  }
  return 1 - cost / n;
}

/** Best view on a grid around v; `sharp` = how far the best stands above the average of the grid (a flat grid = no match). */
function bestAround(ref: Gray, cur: Gray, v: View, sSpan: number, sStep: number, tSpan: number, tStep: number): { view: View; score: number; sharp: number } {
  let best = { view: v, score: viewScore(ref, cur, v) }, sum = 0, n = 0;
  for (let ds = -sSpan; ds <= sSpan + 1e-9; ds += sStep) {
    const s = v.s * (1 + ds);
    if (s < FOLLOW_ZOOM[0] || s > FOLLOW_ZOOM[1]) continue;
    for (let dx = -tSpan; dx <= tSpan + 1e-9; dx += tStep) for (let dy = -tSpan; dy <= tSpan + 1e-9; dy += tStep) {
      const w = { s, tx: v.tx + dx, ty: v.ty + dy };
      const sc = viewScore(ref, cur, w);
      if (sc > -1) { sum += sc; n++; }
      if (sc > best.score) best = { view: w, score: sc };
    }
  }
  return { ...best, sharp: n ? best.score - sum / n : 0 };
}

/**
 * Fine-tune a view by the pictures themselves: product boxes are only a rough guide (a detector box is often loose
 * on one side, and products cut by the frame edge are boxed short), the shelf, the pegboard and the products left
 * on it line up exactly only at the right zoom + pan. Coarse search on half-size images, then fine on full size.
 * Each start (the candidates of fitViews and the last view) is searched and the best match wins: this is also what
 * tells a view shifted by one product from the true one, as the products differ even where their boxes do not.
 * With many starts, a quick look around each keeps the two best for the full search. The score alone says little
 * (a shelf with half its products gone matches badly everywhere), so `sharp` says how clearly the best view stands
 * out from the views around it on the coarse grid: near 0 means the picture no longer looks like the shelf.
 */
export function refineView(ref: Gray, cur: Gray, starts: View[]): { view: View; score: number; sharp: number } {
  const r2 = halve(ref), c2 = halve(cur);
  let cands = starts;
  if (starts.length > 2) {
    cands = starts.map((v) => ({ v, score: bestAround(r2, c2, v, 0.06, 0.03, 0.04, 0.02).score }))
      .sort((a, b) => b.score - a.score).slice(0, 2).map((x) => x.v);
  }
  let best = { view: cands[0], score: -2, sharp: 0 };
  for (const v of cands) {
    const coarse = bestAround(r2, c2, v, 0.15, 0.03, 0.12, 0.02);
    const fine = bestAround(ref, cur, coarse.view, 0.03, 0.01, 0.02, 0.005);
    if (fine.score > best.score) best = { view: fine.view, score: fine.score, sharp: coarse.sharp };
  }
  return best;
}
