// Plain-language verdicts for the "what is the agent doing" strip on the shelf watch page. Pure: no DOM.
import type { Box } from "../agent-contract";
import type { SlotEvent, SlotStatus, Track } from "./watch-logic";

export type Tone = "good" | "warn" | "bad" | "info";
export interface Verdict { tone: Tone; text: string; sub: string }

export type Phase = "find" | "watch";
/** Who does a step: the agent (one detect() call or more) or the web page itself. */
export type By = "agent" | "web";
export interface StepDef { title: string; by: By; shelfOnly?: boolean }

/**
 * The steps of each job, one card each on the strip, in the order watch.ts runs them. An agent step names the
 * detect() option it is called with, so the card can say which model(s) run (modelsUsed) before the first call.
 */
export const PHASES: Record<Phase, StepDef[]> = {
  find: [
    { title: "หาสินค้าทั้งภาพ", by: "agent", shelfOnly: false },
    { title: "ระบุชื่อทีละชิ้น", by: "agent", shelfOnly: false },
    { title: "รวมเป็นช่อง + ยืนยันว่ามีของ", by: "agent", shelfOnly: true },
  ],
  watch: [
    { title: "ตรวจภาพเต็ม", by: "agent", shelfOnly: true },
    { title: "ตามกล้อง + จับคู่กล่องกับช่อง", by: "web" },
    { title: "ครอปเช็กช่องที่ยังไม่ชัด", by: "agent", shelfOnly: true },
    { title: "สรุป + จับเวลาว่าง", by: "web" },
  ],
};

/** "3 calls · 92 ms" under an agent step (latency_ms is per call: a call running both models is not split). */
export function callStats(calls: number, ms: number): string {
  return calls ? `${calls} call${calls > 1 ? "s" : ""} · ${Math.round(ms)} ms` : "";
}

/** Which of the agent's two models a detect call runs (shelfOnly skips the 110-class one). */
export function modelsUsed(shelfOnly: boolean | undefined, hasShelfModel: boolean): Array<"primary" | "shelf"> {
  if (!hasShelfModel) return ["primary"];
  return shelfOnly ? ["shelf"] : ["primary", "shelf"];
}

/** Highest confidence among boxes of the 110-class model (class ids below `classes`), or null. */
export function topNameConf(boxes: Box[], classes: number): number | null {
  const named = boxes.filter((b) => b.classId < classes);
  return named.length ? Math.max(...named.map((b) => b.conf)) : null;
}

export function foundVerdict(count: number): Verdict {
  return count
    ? { tone: "info", text: `เจอ ${count} ชิ้น`, sub: "" }
    : { tone: "warn", text: "ไม่เจอสินค้า", sub: "ลองตอนชั้นเต็ม หรือลดความมั่นใจขั้นต่ำ" };
}

export function nameVerdict(name: string | null, conf: number | null, lastTry: boolean): Verdict {
  if (name) return { tone: "good", text: name, sub: conf === null ? "รู้ชื่อแล้ว" : `ความมั่นใจ ${conf.toFixed(2)}` };
  return lastTry
    ? { tone: "warn", text: "ไม่แน่ใจ", sub: "ตั้งชื่อเป็น “สินค้าอื่น” ไว้ก่อน" }
    : { tone: "warn", text: "ยังไม่แน่ใจ", sub: "ลองครอปให้กว้างขึ้นอีกรอบ" };
}

export function confirmVerdict(has: boolean): Verdict {
  return has
    ? { tone: "good", text: "มีสินค้า ✓", sub: "เก็บเป็นช่องที่จะเฝ้า" }
    : { tone: "warn", text: "ดูว่าง", sub: "ตัดช่องนี้ทิ้ง กันแจ้งเตือนผิด" };
}

/** End of naming: `tried` products cropped, `named` got a confident name, `widened` needed the wider crop. */
export function namedVerdict(tried: number, named: number, widened: number, skipped: number): Verdict {
  const sub = [widened ? `ครอปกว้างขึ้นอีกรอบ ${widened} ชิ้น` : "", tried - named ? `ไม่แน่ใจ ${tried - named} ชิ้น จัดกลุ่มตามหน้าตา` : "", skipped ? `ไม่ได้ระบุ ${skipped} ชิ้น (เกิน ${tried})` : ""].filter(Boolean).join(" · ");
  if (!tried) return { tone: "warn", text: "ไม่มีชิ้นให้ระบุ", sub };
  return { tone: named ? "good" : "warn", text: `รู้ชื่อ ${named} / ${tried} ชิ้น`, sub };
}

/** End of auto slots: candidate slots checked on their crop, `kept` of them still show a product. */
export function keptVerdict(candidates: number, kept: number): Verdict {
  if (!kept) return { tone: "warn", text: "ไม่เหลือช่อง", sub: candidates ? `ทั้ง ${candidates} ช่องดูว่าง` : "ไม่มีช่องให้ยืนยัน" };
  return { tone: "good", text: `ได้ ${kept} ช่อง`, sub: candidates > kept ? `ตัด ${candidates - kept} ช่องที่ตอนนี้ก็ดูว่างอยู่แล้ว` : "" };
}

/** The shelf model on the whole frame. */
export function boxesVerdict(boxes: number): Verdict {
  return boxes ? { tone: "info", text: `เจอ ${boxes} กล่อง`, sub: "" } : { tone: "warn", text: "ไม่เจอกล่อง", sub: "ทุกช่องต้องครอปเช็ก" };
}

/** The web matched the full-frame boxes to the slots: `clear` slots are settled, `unclear` need a crop. */
export function matchVerdict(clear: number, visible: number, unclear: number, blocked: number, away: number, camera: Verdict | null): Verdict {
  const sub = [camera?.text ?? "", unclear ? `ต้องครอป ${unclear}` : "", blocked ? `ถูกบัง ${blocked}` : "", away ? `นอกภาพ ${away}` : ""].filter(Boolean).join(" · ");
  return { tone: camera?.tone === "warn" ? "warn" : unclear ? "info" : "good", text: `ชัดจากภาพเต็ม ${clear} / ${visible} ช่อง`, sub };
}

/** Crops of the slots left unclear: `checked` of `unclear` fit in the round, the rest wait for the next one. */
export function cropVerdict(checked: number, unclear: number, every = false): Verdict {
  if (every) return { tone: "info", text: `ครอปครบ ${checked} ช่อง`, sub: "วิธีเดิม · ครอปทุกช่อง" };
  if (!unclear) return { tone: "good", text: "ไม่ต้องครอป", sub: "ทุกช่องชัดจากภาพเต็ม" };
  if (checked < unclear) return { tone: "warn", text: `ครอป ${checked} / ${unclear} ช่อง`, sub: `เหลือ ${unclear - checked} ช่องไปรอบหน้า (หมดเวลาของรอบ)` };
  return { tone: "good", text: `ครอปครบ ${checked} ช่อง`, sub: "" };
}

/** Result of the full-frame pass that keeps the slot frames on the shelf when the camera zooms or pans. */
export function followVerdict(boxes: number, scale: number, moved: boolean, lost: boolean): Verdict {
  if (lost) return { tone: "warn", text: "หาตำแหน่งไม่เจอ", sub: "ใช้ตำแหน่งกรอบล่าสุดไปก่อน" };
  if (moved) return { tone: "info", text: "กล้องขยับ", sub: `ย้ายกรอบทุกช่องตามแล้ว (ซูม ×${scale.toFixed(2)})` };
  return { tone: "good", text: "กล้องนิ่ง", sub: `เจอสินค้า ${boxes} กล่อง · กรอบอยู่ที่เดิม` };
}

/** What one check of a slot means, after the web's timers (stepTrack) have seen it. Times in ms. */
export function slotVerdict(track: Track, has: boolean, blocked: boolean, event: SlotEvent, now: number, holdMs: number): Verdict {
  if (event === "out") return { tone: "bad", text: "ของหมด!", sub: "ว่างครบเวลาแล้ว · แจ้งเตือน" };
  if (event === "restocked") return { tone: "good", text: "เติมของแล้ว", sub: "ยกเลิกการแจ้งเตือน" };
  if (blocked) return { tone: "info", text: "มีอะไรบังอยู่", sub: "ภาพเปลี่ยนมาก · พักตัวนับเวลา" };
  if (track.status === "out") return has
    ? { tone: "bad", text: "ของหมด", sub: "เห็นของแล้ว · รอให้เห็นต่อเนื่องก่อนยกเลิก" }
    : { tone: "bad", text: "ของหมด", sub: "ยังว่างอยู่" };
  if (has) return { tone: "good", text: "มีของ ✓", sub: "เจอสินค้าในช่อง" };
  const empty = track.emptySince === null ? 0 : Math.max(0, now - track.emptySince);
  return { tone: "warn", text: "ว่าง", sub: `ว่างมา ${Math.floor(empty / 1000)} / ${Math.round(holdMs / 1000)} วิ ก่อนแจ้งเตือน` };
}

/** One line for the end of a watch round. `away` counts slots outside the frame (zoomed in). */
export function roundVerdict(statuses: SlotStatus[], away: number): Verdict {
  const n = (s: SlotStatus) => statuses.filter((x) => x === s).length;
  const out = n("out"), checking = n("checking"), stocked = n("stocked");
  const parts = [`มีของ ${stocked}`, `กำลังนับ ${checking}`, `หมด ${out}`, ...(away ? [`นอกภาพ ${away}`] : [])].join(" · ");
  if (out) return { tone: "bad", text: `ของหมด ${out} ช่อง`, sub: parts };
  if (checking) return { tone: "warn", text: `ว่าง ${checking} ช่อง`, sub: parts };
  return { tone: "good", text: "ของครบทุกช่อง", sub: parts };
}
