// Pure helpers for the UI (task B), unit-tested in test/ui.test.ts.
import type { AgentErrorCode, Box } from "../agent-contract";

/** Thai message for every AgentErrorCode (B3). */
export const ERROR_TH: Record<AgentErrorCode, string> = {
  fetch_failed: "ดาวน์โหลดไฟล์ของ agent ไม่ได้ ลองเช็กอินเทอร์เน็ตแล้วรีเฟรชหน้า",
  manifest_invalid: "ไฟล์ manifest.json ของ agent ไม่ถูกต้อง",
  version_mismatch: "เวอร์ชัน agent ไม่ตรงกับที่เว็บ pin ไว้",
  contract_mismatch: "agent รุ่นนี้ใช้ API (contract) ที่เว็บนี้ไม่รองรับ",
  model_sha256_mismatch: "ไฟล์ model เสียหรือถูกแก้ไข (sha256 ไม่ตรงกับ manifest)",
  labels_mismatch: "รายชื่อสินค้า (labels.json) ไม่ครบตามจำนวนคลาสของ model",
  backend_unavailable: "browser นี้รัน model ไม่ได้ (ใช้ไม่ได้ทั้ง WebGPU และ WASM)",
  not_implemented: "agent รุ่นนี้ยังตรวจจับไม่ได้",
};

export function errorMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code && code in ERROR_TH) return `${ERROR_TH[code as AgentErrorCode]} (${code})`;
  return `เกิดข้อผิดพลาด: ${(e as Error)?.message ?? String(e)}`;
}

/** A stable, distinct colour per class id (golden-angle hue steps). */
export function classColor(classId: number): string {
  const hue = Math.round((classId * 137.508) % 360);
  return `hsl(${hue} 80% 45%)`;
}

export interface CountRow { cls: string; classId: number; count: number; maxConf: number }

/** Count boxes per product, most frequent first (ties: higher confidence first). */
export function countByClass(boxes: Box[]): CountRow[] {
  const m = new Map<number, CountRow>();
  for (const b of boxes) {
    const r = m.get(b.classId) ?? { cls: b.cls, classId: b.classId, count: 0, maxConf: 0 };
    r.count++;
    r.maxConf = Math.max(r.maxConf, b.conf);
    m.set(b.classId, r);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || b.maxConf - a.maxConf);
}

/** The single most confident box, or null. */
export function topBox(boxes: Box[]): Box | null {
  return boxes.reduce<Box | null>((best, b) => (!best || b.conf > best.conf ? b : best), null);
}

/** "lays-nori-seaweed" -> "lays nori seaweed" for display. */
export function prettyName(cls: string): string {
  return cls.replace(/[-_]+/g, " ").trim();
}

export function formatMB(bytes: number): string {
  return (bytes / 1e6).toFixed(1);
}
