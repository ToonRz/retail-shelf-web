// Pure helpers for live camera detection (task I2), unit-tested in test/live.test.ts.

/**
 * Lets one frame through at a time: while a frame is being detected, new frames are
 * skipped (counted, never queued), so the overlay never falls further and further behind.
 */
export class FrameGate {
  busy = false;
  sent = 0;
  skipped = 0;

  /** true = go ahead and detect this frame (call done() afterwards); false = skip it. */
  tryStart(): boolean {
    if (this.busy) { this.skipped++; return false; }
    this.busy = true;
    this.sent++;
    return true;
  }

  done(): void {
    this.busy = false;
  }

  reset(): void {
    this.sent = this.skipped = 0; // `busy` is left alone: a frame may still be in flight
  }
}

/** Mean of the last `size` values. */
export class MovingAverage {
  private values: number[] = [];
  constructor(readonly size = 10) {
    if (!(size >= 1)) throw new Error(`size must be >= 1, got ${size}`);
  }

  push(v: number): number {
    this.values.push(v);
    if (this.values.length > this.size) this.values.shift();
    return this.value!;
  }

  get value(): number | null {
    return this.values.length ? this.values.reduce((s, v) => s + v, 0) / this.values.length : null;
  }

  reset(): void {
    this.values = [];
  }
}

/**
 * Frames per second over the last `size` intervals between finished frames.
 * A gap longer than `maxGapMs` (tab was hidden, camera stalled) starts over instead of dragging the average down.
 */
export class FpsMeter {
  private times: number[] = [];
  constructor(readonly size = 10, readonly maxGapMs = 3000) {}

  /** Record a finished frame at `nowMs`; returns the current FPS, or null until two frames are in. */
  tick(nowMs: number): number | null {
    const last = this.times.at(-1);
    if (last !== undefined && (nowMs - last > this.maxGapMs || nowMs < last)) this.times = [];
    this.times.push(nowMs);
    if (this.times.length > this.size + 1) this.times.shift();
    return this.fps;
  }

  get fps(): number | null {
    if (this.times.length < 2) return null;
    const span = this.times.at(-1)! - this.times[0];
    return span > 0 ? (1000 * (this.times.length - 1)) / span : null;
  }

  reset(): void {
    this.times = [];
  }
}

/** Text of the overlay in the corner of the video, e.g. "7.5 FPS · 133 ms/เฟรม · ข้าม 12". */
export function hudText(fps: number | null, msPerFrame: number | null, skipped: number): string {
  const f = fps === null ? "–" : fps.toFixed(1);
  const ms = msPerFrame === null ? "–" : msPerFrame.toFixed(0);
  return `${f} FPS · ${ms} ms/เฟรม · ข้าม ${skipped}`;
}

