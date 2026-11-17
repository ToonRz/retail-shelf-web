import { describe, expect, it } from "vitest";
import { boxesVerdict, callStats, confirmVerdict, cropVerdict, followVerdict, foundVerdict, keptVerdict, matchVerdict, modelsUsed, namedVerdict, nameVerdict, PHASES, roundVerdict, slotVerdict, topNameConf } from "../src/ui/flow-logic";
import { newTrack, type Track } from "../src/ui/watch-logic";

const box = (classId: number, conf: number) => ({ cls: "x", classId, conf, xyxy: [0, 0, 1, 1] as [number, number, number, number] });

describe("modelsUsed", () => {
  it("shelfOnly runs only the shelf model", () => expect(modelsUsed(true, true)).toEqual(["shelf"]));
  it("a full call runs both", () => expect(modelsUsed(false, true)).toEqual(["primary", "shelf"]));
  it("a release without a shelf model has only the primary one", () => expect(modelsUsed(true, false)).toEqual(["primary"]));
});

describe("verdicts", () => {
  it("topNameConf ignores the shelf model's boxes", () => {
    expect(topNameConf([box(3, 0.6), box(110, 0.99), box(5, 0.8)], 110)).toBe(0.8);
    expect(topNameConf([box(110, 0.99)], 110)).toBeNull();
  });
  it("found / name / confirm", () => {
    expect(foundVerdict(8)).toMatchObject({ tone: "info", text: "เจอ 8 ชิ้น" });
    expect(foundVerdict(0).tone).toBe("warn");
    expect(nameVerdict("pepsi", 0.912, false)).toMatchObject({ tone: "good", text: "pepsi", sub: "ความมั่นใจ 0.91" });
    expect(nameVerdict(null, null, false).sub).toContain("กว้างขึ้น");
    expect(nameVerdict(null, null, true).sub).toContain("สินค้าอื่น");
    expect(confirmVerdict(true).tone).toBe("good");
    expect(confirmVerdict(false).tone).toBe("warn");
  });
  it("follow view", () => {
    expect(followVerdict(12, 1, false, false)).toMatchObject({ tone: "good", text: "กล้องนิ่ง" });
    expect(followVerdict(12, 1.234, true, false).sub).toContain("×1.23");
    expect(followVerdict(0, 1, false, true).tone).toBe("warn");
  });
});

describe("slotVerdict", () => {
  const hold = 15000;
  const t = (o: Partial<Track>): Track => ({ ...newTrack(), ...o });
  it("events win", () => {
    expect(slotVerdict(t({ status: "out" }), false, false, "out", 0, hold)).toMatchObject({ tone: "bad", text: "ของหมด!" });
    expect(slotVerdict(t({ status: "stocked" }), true, false, "restocked", 0, hold).tone).toBe("good");
  });
  it("blocked pauses", () => expect(slotVerdict(t({ status: "checking" }), false, true, null, 0, hold).tone).toBe("info"));
  it("stocked", () => expect(slotVerdict(t({ status: "stocked" }), true, false, null, 0, hold)).toMatchObject({ tone: "good" }));
  it("empty counts up to the alert", () => {
    expect(slotVerdict(t({ status: "checking", emptySince: 1000 }), false, false, null, 8400, hold).sub).toBe("ว่างมา 7 / 15 วิ ก่อนแจ้งเตือน");
  });
  it("an out slot stays out until it clears", () => {
    expect(slotVerdict(t({ status: "out" }), true, false, null, 0, hold).sub).toContain("รอให้เห็นต่อเนื่อง");
    expect(slotVerdict(t({ status: "out" }), false, false, null, 0, hold).tone).toBe("bad");
  });
});

describe("roundVerdict", () => {
  it("the worst status leads", () => {
    expect(roundVerdict(["stocked", "out", "checking"], 0)).toMatchObject({ tone: "bad", text: "ของหมด 1 ช่อง" });
    expect(roundVerdict(["stocked", "checking"], 0)).toMatchObject({ tone: "warn", text: "ว่าง 1 ช่อง" });
    expect(roundVerdict(["stocked", "stocked"], 1)).toMatchObject({ tone: "good", sub: "มีของ 2 · กำลังนับ 0 · หมด 0 · นอกภาพ 1" });
  });
});

describe("steps", () => {
  it("watch steps follow loop(): full frame, match, crops, summary", () => {
    expect(PHASES.watch.map((s) => s.by)).toEqual(["agent", "web", "agent", "web"]);
    expect(PHASES.watch.filter((s) => s.by === "agent").every((s) => s.shelfOnly)).toBe(true); // watching never runs the 110-class model
    expect(modelsUsed(PHASES.find[1].shelfOnly, true)).toEqual(["primary", "shelf"]); // naming crops run both models today
  });
  it("callStats", () => {
    expect(callStats(0, 0)).toBe("");
    expect(callStats(1, 41.4)).toBe("1 call · 41 ms");
    expect(callStats(3, 91.6)).toBe("3 calls · 92 ms");
  });
});

describe("step summaries", () => {
  it("auto slots", () => {
    expect(foundVerdict(54)).toEqual({ tone: "info", text: "เจอ 54 ชิ้น", sub: "" });
    expect(namedVerdict(46, 31, 9, 0)).toEqual({ tone: "good", text: "รู้ชื่อ 31 / 46 ชิ้น", sub: "ครอปกว้างขึ้นอีกรอบ 9 ชิ้น · ไม่แน่ใจ 15 ชิ้น จัดกลุ่มตามหน้าตา" });
    expect(namedVerdict(60, 60, 0, 4).sub).toBe("ไม่ได้ระบุ 4 ชิ้น (เกิน 60)");
    expect(namedVerdict(0, 0, 0, 0).tone).toBe("warn");
    expect(keptVerdict(19, 18)).toEqual({ tone: "good", text: "ได้ 18 ช่อง", sub: "ตัด 1 ช่องที่ตอนนี้ก็ดูว่างอยู่แล้ว" });
    expect(keptVerdict(3, 0).tone).toBe("warn");
  });
  it("watch round", () => {
    expect(boxesVerdict(41).text).toBe("เจอ 41 กล่อง");
    expect(boxesVerdict(0).tone).toBe("warn");
    const still = followVerdict(41, 1, false, false);
    expect(matchVerdict(14, 18, 4, 1, 0, still)).toEqual({ tone: "info", text: "ชัดจากภาพเต็ม 14 / 18 ช่อง", sub: "กล้องนิ่ง · ต้องครอป 4 · ถูกบัง 1" });
    expect(matchVerdict(18, 18, 0, 0, 2, null)).toEqual({ tone: "good", text: "ชัดจากภาพเต็ม 18 / 18 ช่อง", sub: "นอกภาพ 2" });
    expect(matchVerdict(10, 18, 8, 0, 0, followVerdict(0, 1, false, true)).tone).toBe("warn");
    expect(cropVerdict(0, 0)).toMatchObject({ tone: "good", text: "ไม่ต้องครอป" });
    expect(cropVerdict(3, 4)).toEqual({ tone: "warn", text: "ครอป 3 / 4 ช่อง", sub: "เหลือ 1 ช่องไปรอบหน้า (หมดเวลาของรอบ)" });
    expect(cropVerdict(4, 4)).toMatchObject({ tone: "good", text: "ครอปครบ 4 ช่อง" });
    expect(cropVerdict(18, 18, true).sub).toContain("วิธีเดิม");
  });
});
