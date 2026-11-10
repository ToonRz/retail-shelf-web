// B: pure UI helpers.
import { describe, expect, it } from "vitest";
import type { AgentErrorCode, Box } from "../src/agent-contract";
import { classColor, countByClass, ERROR_TH, errorMessage, prettyName, topBox } from "../src/ui/logic";

const box = (classId: number, cls: string, conf: number): Box => ({ classId, cls, conf, xyxy: [0, 0, 1, 1] });

describe("ui logic", () => {
  it("has a Thai message for every AgentErrorCode", () => {
    const codes: AgentErrorCode[] = ["fetch_failed", "manifest_invalid", "version_mismatch", "contract_mismatch",
      "model_sha256_mismatch", "labels_mismatch", "backend_unavailable", "not_implemented"];
    for (const c of codes) expect(ERROR_TH[c]).toMatch(/[฀-๿]/);
    expect(errorMessage({ code: "version_mismatch", message: "x" })).toBe("เวอร์ชัน agent ไม่ตรงกับที่เว็บ pin ไว้ (version_mismatch)");
    expect(errorMessage(new Error("boom"))).toContain("boom");
  });

  it("counts products, most frequent first", () => {
    const rows = countByClass([box(2, "pepsi", 0.9), box(5, "lays", 0.95), box(2, "pepsi", 0.8)]);
    expect(rows.map((r) => [r.cls, r.count, r.maxConf])).toEqual([["pepsi", 2, 0.9], ["lays", 1, 0.95]]);
    expect(countByClass([])).toEqual([]);
  });

  it("finds the most confident box", () => {
    expect(topBox([box(1, "a", 0.5), box(2, "b", 0.7)])?.cls).toBe("b");
    expect(topBox([])).toBeNull();
  });

  it("gives each class a stable colour that differs from its neighbours", () => {
    expect(classColor(3)).toBe(classColor(3));
    const hues = Array.from({ length: 110 }, (_, i) => classColor(i));
    expect(new Set(hues).size).toBeGreaterThan(100);
    expect(prettyName("lays-nori_seaweed")).toBe("lays nori seaweed");
  });
});
