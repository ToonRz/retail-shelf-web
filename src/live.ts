// Live camera detection (task I2): detect every frame the agent can keep up with and draw the boxes
// over the live <video>. Frames that arrive while one is still being detected are skipped, not queued.
import type { Agent, Box, DetectResult } from "./agent-contract";
import { classColor, errorMessage, prettyName } from "./ui/logic";
import { FpsMeter, FrameGate, hudText, MovingAverage } from "./ui/live-logic";

export interface LiveDeps {
  video: HTMLVideoElement;       // the camera preview (opened and closed by main.ts)
  overlay: HTMLCanvasElement;    // transparent canvas stacked on top of the video
  hud: HTMLElement;              // FPS / ms per frame badge
  button: HTMLButtonElement;     // "ตรวจต่อเนื่อง" / "หยุด"
  getAgent(): Agent | null;
  getConf(): number;
  onResult(r: DetectResult): void;           // updates the tally (counts via countByClass)
  onStatus(text: string, bad?: boolean): void;
}

export interface Live {
  start(): void;
  /** Stops the loop; resolves once a frame that is still being detected has finished. */
  stop(message?: string): Promise<void>;
  isRunning(): boolean;
}

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?(cb: () => void): number;
  cancelVideoFrameCallback?(handle: number): void;
};

/** Boxes only (no image): the live video shows through the transparent canvas. */
export function drawBoxes(ctx: CanvasRenderingContext2D, boxes: Box[], width: number) {
  const lw = Math.max(2, Math.round(width / 320));
  const fs = Math.max(12, Math.round(width / 40));
  ctx.lineWidth = lw;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  for (const b of [...boxes].reverse()) { // most confident drawn last = on top
    const [x1, y1, x2, y2] = b.xyxy;
    const color = classColor(b.classId);
    ctx.strokeStyle = color;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const label = `${prettyName(b.cls)} ${b.conf.toFixed(2)}`;
    const tw = ctx.measureText(label).width + 8, th = fs + 6;
    const ty = y1 - th >= 0 ? y1 - th : y1;
    ctx.fillStyle = color;
    ctx.fillRect(x1 - lw / 2, ty, tw, th);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x1 + 4, ty + 3);
  }
}

export function setupLive(d: LiveDeps): Live {
  const video = d.video as FrameVideo;
  const gate = new FrameGate();
  const fps = new FpsMeter(10);
  const frameMs = new MovingAverage(10);
  let running = false;
  let session = 0;        // bumped on every start/stop so a late result from an old run is dropped
  let handle = 0;
  let inFlight: Promise<void> = Promise.resolve();

  const label = () => { d.button.textContent = running ? "หยุด" : "ตรวจต่อเนื่อง"; };

  function schedule() {
    if (!running) return;
    // requestVideoFrameCallback fires once per new camera frame; rAF is the fallback (Firefox)
    handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  }

  function cancel() {
    if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
    else cancelAnimationFrame(handle);
  }

  function tick() {
    if (!running) return;
    schedule(); // ask for the next frame now, so frames that arrive while we are busy are counted as skipped
    const agent = d.getAgent();
    if (!agent || !video.videoWidth || !gate.tryStart()) return;
    const mine = session;
    inFlight = detectFrame(agent, mine).finally(() => gate.done());
  }

  async function detectFrame(agent: Agent, mine: number) {
    const t0 = performance.now();
    let r: DetectResult;
    try {
      const frame = await createImageBitmap(video);
      try {
        r = await agent.detect(frame, { conf: d.getConf() });
      } finally {
        frame.close();
      }
    } catch (e) {
      if (mine === session) void stop(`ตรวจต่อเนื่องไม่สำเร็จ: ${errorMessage(e)}`, true);
      return;
    }
    if (mine !== session) return; // stopped (or restarted) while this frame was being detected
    const c = d.overlay;
    if (c.width !== r.width || c.height !== r.height) { c.width = r.width; c.height = r.height; }
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    drawBoxes(ctx, r.boxes, r.width);
    const done = performance.now();
    d.hud.textContent = hudText(fps.tick(done), frameMs.push(done - t0), gate.skipped);
    d.onResult(r);
  }

  function start() {
    if (running || !d.getAgent() || !video.srcObject) return;
    running = true;
    session++;
    gate.reset();
    fps.reset();
    frameMs.reset();
    d.overlay.getContext("2d")!.clearRect(0, 0, d.overlay.width, d.overlay.height);
    d.overlay.hidden = d.hud.hidden = false;
    d.hud.textContent = hudText(null, null, 0);
    label();
    d.onStatus("กำลังตรวจต่อเนื่องจากกล้อง · กด \"หยุด\" เมื่อพอ");
    schedule();
  }

  async function stop(message = "หยุดตรวจต่อเนื่องแล้ว", bad = false) {
    if (running) {
      running = false;
      session++;
      cancel();
      d.overlay.hidden = d.hud.hidden = true;
      label();
      d.onStatus(message, bad);
    }
    await inFlight.catch(() => {});
  }

  d.button.addEventListener("click", () => (running ? void stop() : start()));
  // a hidden tab gets no camera frames anyway; stop so it does not burn battery when it comes back
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void stop("หยุดตรวจต่อเนื่องเพราะสลับแท็บหรือปิดหน้าจอ");
  });
  window.addEventListener("hashchange", () => void stop());
  label();

  return { start, stop: (m?: string) => stop(m), isRunning: () => running };
}

