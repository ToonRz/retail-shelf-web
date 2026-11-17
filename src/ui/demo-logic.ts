// Pure logic of the presentation page (#demo), unit-tested in test/demo.test.ts.
import type { Box } from "../agent-contract";

export type StepId = "overview" | "primary" | "shelf" | "agent" | "video" | "summary";

export interface DemoStep {
  id: StepId;
  /** Short label for the step bar. */
  label: string;
  /** How long autoplay stays on the step. The video step lasts as long as the clip (null). */
  ms: number | null;
}

export const DEMO_STEPS: DemoStep[] = [
  { id: "overview", label: "ภาพรวม", ms: 10_000 },
  { id: "primary", label: "Model ชื่อสินค้า", ms: 12_000 },
  { id: "shelf", label: "Model ชั้นวาง", ms: 12_000 },
  { id: "agent", label: "Agent", ms: 18_000 },
  { id: "video", label: "ใช้งานจริง", ms: null },
  { id: "summary", label: "สรุป", ms: 6_000 },
];

/** Length of public/samples/demo-usage.mp4 (s), used for the total before the clip's metadata loads. */
export const VIDEO_SECONDS = 52;

/** Whole presentation length in ms. */
export function totalMs(steps: DemoStep[] = DEMO_STEPS, videoSeconds = VIDEO_SECONDS): number {
  return steps.reduce((s, st) => s + (st.ms ?? videoSeconds * 1000), 0);
}

/** "1:52" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface Chapter {
  /** Seconds into demo-usage.mp4. */
  at: number;
  title: string;
  /** What the professor should look at. */
  note: string;
  tone: "info" | "good" | "bad";
}

// demo-usage.mp4 is a screen recording of #watch on samples/demo-shelf.mp4 (agent v0.3.2, WASM, conf 0.25, alert after 15 s).
// Setup is sped up 2× (0–11.5 s), watching 3×: clip time c of demo-shelf.mp4 is at 11.5 + c / 3 in the recording.
const at = (clipSeconds: number) => Math.round((11.5 + clipSeconds / 3) * 10) / 10;

export const CHAPTERS: Chapter[] = [
  { at: 0, title: "หาช่องอัตโนมัติ", note: "Agent รันทั้ง 2 model กับภาพแรก แล้วระบุชื่อสินค้าทีละชิ้น → ได้ 6 ช่องจาก 12 ชิ้น ชื่อถูกทุกช่อง", tone: "info" },
  { at: at(0), title: "เริ่มเฝ้า", note: "ทุกรอบ (~1 วินาที) ตรวจภาพเต็มด้วย model ชั้นวาง แล้วจับคู่กล่องกับช่อง ช่องที่ไม่ชัดค่อยครอปตรวจซ้ำ", tone: "info" },
  { at: at(20), title: "lays ถูกหยิบหมด", note: "ช่องขึ้น \"ว่าง x/15 วิ\" นับถอยหลังก่อนเตือน กันเตือนผิดตอนมีคนหยิบชั่วคราว", tone: "info" },
  { at: at(37.4), title: "แจ้งเตือน: lays ของหมด", note: "ว่างครบ 15 วินาที → แถบแดง + เสียง + notification", tone: "bad" },
  { at: at(62), title: "คนเดินผ่านหน้าชั้น", note: "ภาพในช่องเปลี่ยนมาก → ช่องนั้น \"ถูกบัง\" ไม่นับเวลาว่าง", tone: "info" },
  { at: at(67), title: "แจ้งเตือน: pocky ของหมด", note: "ช้ากว่าเวลาที่ตั้งเล็กน้อย เพราะช่วงที่ถูกบังไม่นับ", tone: "bad" },
  { at: at(81.5), title: "เติมของ lays แล้ว", note: "ของกลับมา 3 วินาที → ยกเลิกการเตือนของช่องนั้น", tone: "good" },
  { at: at(100), title: "hanami ถูกหยิบไป 1 จาก 2 ชิ้น", note: "ยังมีของเหลือ จึงไม่เตือน", tone: "good" },
  { at: at(109.5), title: "แจ้งเตือน: copp ของหมด", note: "จบคลิป: เตือนครบ 3 ช่องที่ของหมดจริง ไม่มีเตือนผิด", tone: "bad" },
];

/** Index of the chapter playing at time t (s). */
export function chapterAt(t: number, chapters: Chapter[] = CHAPTERS): number {
  let i = 0;
  for (let k = 0; k < chapters.length; k++) if (t >= chapters[k].at) i = k;
  return i;
}

/** Boxes the 110-class model named vs boxes only the shelf model found (agent v0.3.x: classId >= classes = "product"). */
export function splitBoxes(boxes: Box[], classes: number): { named: Box[]; unknown: Box[] } {
  const named: Box[] = [], unknown: Box[] = [];
  for (const b of boxes) (b.classId < classes ? named : unknown).push(b);
  return { named, unknown };
}

/** Number of distinct product names among the boxes. */
export function distinctNames(boxes: Box[]): number {
  return new Set(boxes.map((b) => b.cls)).size;
}

/** A short JSON view of a DetectResult for the slide: the first n boxes, rounded. */
export function jsonPreview(r: { version: string; backend: string; latency_ms: number; width: number; height: number; boxes: Box[] }, n = 2): string {
  const boxes = r.boxes.slice(0, n).map((b) => ({ cls: b.cls, classId: b.classId, conf: Number(b.conf.toFixed(2)), xyxy: b.xyxy.map((v) => Math.round(v)) }));
  const head = { version: r.version, backend: r.backend, latency_ms: Math.round(r.latency_ms), width: r.width, height: r.height };
  const lines = JSON.stringify(head, null, 2).split("\n");
  lines.pop(); // "}"
  lines[lines.length - 1] += ",";
  lines.push(`  "boxes": [ // ${r.boxes.length} กล่อง`);
  boxes.forEach((b, i) => lines.push(`    ${JSON.stringify(b)}${i < boxes.length - 1 || r.boxes.length > n ? "," : ""}`));
  if (r.boxes.length > n) lines.push("    …");
  lines.push("  ]", "}");
  return lines.join("\n");
}
