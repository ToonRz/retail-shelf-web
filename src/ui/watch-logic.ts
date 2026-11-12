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

/**
 * Turn detected product boxes on the full frame into shelf slots (padded slightly so each slot crop
 * includes the product edges, sorted top-to-bottom then left-to-right).
 */
export function boxesToSlots(
  boxes: Box[],
  frameW: number,
  frameH: number,
  pad = 0.08,
  minSize = 0.03,
  makeId: () => string = () => crypto.randomUUID(),
): Slot[] {
  if (!(frameW > 0 && frameH > 0)) return [];
  const rects: Rect[] = [];
  for (const { xyxy: [x1, y1, x2, y2] } of boxes) {
    const bw = x2 - x1, bh = y2 - y1;
    const px = bw * pad, py = bh * pad;
    const r = dragToRect(
      Math.max(0, (x1 - px) / frameW),
      Math.max(0, (y1 - py) / frameH),
      Math.min(1, (x2 + px) / frameW),
      Math.min(1, (y2 + py) / frameH),
      minSize,
    );
    if (r) rects.push(r);
  }
  rects.sort((a, b) => {
    const cyA = a[1] + a[3] / 2, cyB = b[1] + b[3] / 2;
    const sameRow = Math.abs(cyA - cyB) < Math.min(a[3], b[3]) * 0.5;
    return sameRow ? a[0] - b[0] : cyA - cyB;
  });
  return rects.map((rect, i) => ({ id: makeId(), name: `ช่อง ${i + 1}`, rect }));
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

export const STATUS_TH: Record<SlotStatus, string> = { waiting: "รอตรวจ", stocked: "มีของ", checking: "กำลังยืนยัน", out: "ของหมด" };
