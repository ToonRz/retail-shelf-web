// Plain-language verdicts for the "what is the agent doing" strip on the shelf watch page. Pure: no DOM.
import type { Box } from "../agent-contract";
import type { SlotEvent, SlotStatus, Track } from "./watch-logic";

export type Tone = "good" | "warn" | "bad" | "info";
export interface Verdict { tone: Tone; text: string; sub: string }

/** Steps shown above the strip, per job. */
export const PHASES = {
  find: ["หาสินค้าทั้งภาพ", "ระบุชื่อทีละชิ้น", "ยืนยันช่อง"],
  watch: ["เช็กว่ากล้องขยับไหม", "ตรวจทีละช่อง", "สรุปสถานะ"],
} as const;
export type Phase = keyof typeof PHASES;

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
    ? { tone: "info", text: `เจอ ${count} ชิ้น`, sub: "ต่อไป: ครอปทีละชิ้นเพื่อระบุชื่อ" }
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
  const parts = [`มีของ ${stocked}`, `กำลังยืนยัน ${checking}`, `หมด ${out}`, ...(away ? [`นอกภาพ ${away}`] : [])].join(" · ");
  if (out) return { tone: "bad", text: `ของหมด ${out} ช่อง`, sub: parts };
  if (checking) return { tone: "warn", text: `ว่าง ${checking} ช่อง`, sub: parts };
  return { tone: "good", text: "ของครบทุกช่อง", sub: parts };
}
