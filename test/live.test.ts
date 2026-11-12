// I2: pure logic of live camera detection.
import { describe, expect, it } from "vitest";
import { FpsMeter, FrameGate, hudText, MovingAverage } from "../src/ui/live-logic";

describe("FrameGate", () => {
  it("lets one frame through and skips the rest until done()", () => {
    const g = new FrameGate();
    expect(g.tryStart()).toBe(true);
    expect(g.tryStart()).toBe(false); // previous frame still detecting -> skip, do not queue
    expect(g.tryStart()).toBe(false);
    g.done();
    expect(g.tryStart()).toBe(true);
    expect([g.sent, g.skipped]).toEqual([2, 2]);
  });

  it("reset() clears the counters but keeps an in-flight frame blocking", () => {
    const g = new FrameGate();
    g.tryStart();
    g.tryStart();
    g.reset();
    expect([g.sent, g.skipped]).toEqual([0, 0]);
    expect(g.tryStart()).toBe(false); // the old frame has not called done() yet
    g.done();
    expect(g.tryStart()).toBe(true);
  });
});

describe("MovingAverage", () => {
  it("averages only the last `size` values", () => {
    const m = new MovingAverage(3);
    expect(m.value).toBeNull();
    expect(m.push(10)).toBe(10);
    expect(m.push(20)).toBe(15);
    expect(m.push(30)).toBe(20);
    expect(m.push(100)).toBe(50); // 10 dropped: (20 + 30 + 100) / 3
    m.reset();
    expect(m.value).toBeNull();
  });

  it("rejects a window smaller than 1", () => {
    expect(() => new MovingAverage(0)).toThrow();
  });
});

describe("FpsMeter", () => {
  it("needs two frames, then reports frames per second", () => {
    const f = new FpsMeter(10);
    expect(f.tick(0)).toBeNull();
    expect(f.tick(100)).toBeCloseTo(10);
    expect(f.tick(200)).toBeCloseTo(10);
  });

  it("is a moving average over the last `size` intervals", () => {
    const f = new FpsMeter(2);
    f.tick(0);
    f.tick(500); // slow start: 2 FPS
    f.tick(600);
    expect(f.fps).toBeCloseTo(2 / 0.6); // still sees the 500 ms interval
    f.tick(700);
    expect(f.fps).toBeCloseTo(10); // the slow interval has left the window
  });

  it("starts over after a long gap (tab hidden) instead of reporting a near-zero FPS", () => {
    const f = new FpsMeter(10, 3000);
    f.tick(0);
    f.tick(100);
    expect(f.tick(60_000)).toBeNull(); // only one frame since the gap
    expect(f.tick(60_250)).toBeCloseTo(4);
  });

  it("starts over when time goes backwards", () => {
    const f = new FpsMeter();
    f.tick(1000);
    f.tick(1100);
    expect(f.tick(50)).toBeNull();
  });
});

describe("hudText", () => {
  it("formats FPS, ms per frame and skipped frames", () => {
    expect(hudText(7.4567, 133.4, 12)).toBe("7.5 FPS · 133 ms/เฟรม · ข้าม 12");
    expect(hudText(null, null, 0)).toBe("– FPS · – ms/เฟรม · ข้าม 0");
  });
});

