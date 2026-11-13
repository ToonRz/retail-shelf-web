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

export const STATUS_TH: Record<SlotStatus, string> = { waiting: "รอตรวจ", stocked: "มีของ", checking: "กำลังยืนยัน", out: "ของหมด" };
