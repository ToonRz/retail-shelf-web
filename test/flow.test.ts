import { describe, expect, it } from "vitest";
import { confirmVerdict, followVerdict, foundVerdict, modelsUsed, nameVerdict, roundVerdict, slotVerdict, topNameConf } from "../src/ui/flow-logic";
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
