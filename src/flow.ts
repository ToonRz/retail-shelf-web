// The "what is the agent doing" strip of the shelf watch page, and the reticle on the stage that shows where the
// model is looking. Made to be read from a projector: one headline, the picture the web sends, which model is
// working, and what the web decided from the answer.
//
// Smoothness: keep the strip lightweight so it can update without delaying or holding a detection round.
import type { Agent, DetectOptions, DetectResult } from "./agent-contract";
import { modelsUsed, PHASES, type Phase, type Verdict } from "./ui/flow-logic";

type Rect = [number, number, number, number]; // x, y, w, h

export interface FlowStep {
  phase: Phase;
  step: number;            // index into PHASES[phase]
  title: string;           // headline: what the agent is doing now
  target: string;          // caption under the picture sent
  area: Rect | null;       // where on the frame (fractions of it), for the reticle
  full?: boolean;          // the whole frame is sent (not a crop)
}

const LOG_LIMIT = 30;
const THUMB_W = 360, THUMB_H = 200;
const CORNER = 22;
const SHOW_KEY = "watchFlowShow";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export class FlowView {
  private el = {
    root: $("watchFlow"), title: $("flowTitle"), kicker: $("flowKicker"), phases: $("flowPhases"), round: $("flowRound"),
    show: $<HTMLInputElement>("watchFlowShow"),
    thumb: $<HTMLCanvasElement>("flowThumb"), target: $("flowTarget"), call: $("flowCall"),
    release: $("flowRelease"), reply: $("flowReply"), wireOut: $("flowWireOut"),
    result: $("flowResult"), verdict: $("flowVerdict"), verdictSub: $("flowVerdictSub"),
    log: $("flowLog"), logBox: $<HTMLDetailsElement>("flowLogBox"), json: $("flowJson"), jsonBox: $<HTMLDetailsElement>("flowJsonBox"),
    scan: $("watchScan"), scanFill: $("watchScanFill"), scanTag: $("watchScanTag"),
    corners: ["tl", "tr", "bl", "br"].map((c) => $(`watchScan-${c}`)),
  };
  private models = new Map<"primary" | "shelf", { card: HTMLElement; state: HTMLElement }>();
  private ctx = this.el.thumb.getContext("2d")!;
  private fit = { x: 0, y: 0, k: 1 }; // where the last picture sent was drawn on the thumbnail
  // The last whole frame sent, as drawn on the thumbnail. A crop sent after it is shown as a box on this frame
  // (the crop alone would replace the whole frame within a few ms, and it would look as if only crops are sent).
  private fullThumb: HTMLCanvasElement | null = null;
  private fullFit = { x: 0, y: 0, k: 1, w: 0, h: 0 };
  private cropOn: { x: number; y: number; kx: number; ky: number } | null = null; // crop pixels -> thumbnail
  private agent: Agent | null = null;
  private calls = 0;
  private phase: Phase | null = null;
  private area: Rect | null = null;
  private lastResult: DetectResult | null = null;

  /** `place` maps fractions of the frame to pixels of the stage (null while there is no picture). */
  constructor(private place: (area: Rect) => Rect | null) {
    for (const key of ["primary", "shelf"] as const) {
      const card = $(`flowModel-${key}`);
      this.models.set(key, { card, state: card.querySelector<HTMLElement>(".fm-state")! });
    }
    this.el.thumb.width = THUMB_W;
    this.el.thumb.height = THUMB_H;
    try { this.el.show.checked = localStorage.getItem(SHOW_KEY) !== "0"; } catch { /* private mode */ }
    this.el.show.addEventListener("change", () => {
      try { localStorage.setItem(SHOW_KEY, this.el.show.checked ? "1" : "0"); } catch { /* private mode */ }
      this.syncShown();
    });
    this.el.jsonBox.addEventListener("toggle", () => this.renderJson());
    new ResizeObserver(() => this.moveScan(this.area, false)).observe(this.el.scan.parentElement!);
    this.syncShown();
    this.clearThumb();
  }

  get shown() { return this.el.show.checked; }
  private syncShown() {
    this.el.root.hidden = !this.shown;
    if (!this.shown) this.moveScan(null);
  }

  // ------------------------------------------------------------ states

  ready(agent: Agent) {
    this.agent = agent;
    this.el.release.textContent = `${agent.manifest.version} · ${agent.backend === "webgpu" ? "WebGPU" : "WASM"}`;
    const { model, shelfModel } = agent.manifest;
    const fill = (key: "primary" | "shelf", info: { name: string; classes: number; dataset: string; sha256?: string } | undefined) => {
      const m = this.models.get(key)!;
      m.card.hidden = !info;
      if (!info) return;
      m.card.querySelector(".fm-meta")!.textContent = `${info.name} · ${info.classes} คลาส`;
      m.card.title = `${info.name} · ${info.dataset} · ${info.classes} classes${info.sha256 ? `\nsha256 ${info.sha256}` : ""}`;
    };
    fill("primary", model);
    fill("shelf", shelfModel);
    this.idle("พร้อมแล้ว", "เลือกรูป / วิดีโอ หรือเปิดกล้อง");
  }

  /** Nothing in flight: a headline, no active model, no reticle. */
  idle(kicker: string, title: string) {
    delete this.el.root.dataset.busy;
    this.el.kicker.textContent = kicker;
    this.el.title.textContent = title;
    this.setModels([], "");
    this.moveScan(null);
  }

  /** A new source: forget the last picture and answer. */
  reset() {
    this.lastResult = null;
    this.el.log.replaceChildren();
    this.el.json.textContent = "–";
    this.idle("รอภาพ", "รอรอบตรวจถัดไป");
    this.phase = null;
    this.renderPhases(null, -1);
    this.el.round.textContent = "";
    this.fullThumb = null;
    this.cropOn = null;
    this.clearThumb();
    this.el.target.textContent = "—";
    this.el.call.textContent = "detect()";
    this.el.reply.textContent = "—";
    this.setVerdict(null);
  }

  round(n: number | null) { this.el.round.textContent = n === null ? "" : `รอบ #${String(n).padStart(4, "0")}`; }

  /** The web hands a picture to the agent. Draws it, lights the models the call runs, moves the reticle. */
  send(step: FlowStep, image: ImageBitmap, options: DetectOptions) {
    if (!this.shown) return;
    this.el.root.dataset.busy = "1";
    this.el.kicker.textContent = "Agent กำลัง";
    this.el.title.textContent = step.title;
    this.renderPhases(step.phase, step.step);
    const onFull = this.drawThumb(image, step);
    this.el.target.textContent = `${step.target}${onFull ? " (กรอบส้มในภาพเต็ม)" : ""} · ${image.width}×${image.height} px`;
    const used = modelsUsed(options.shelfOnly, !!this.agent?.manifest.shelfModel);
    this.el.call.textContent = `${step.full ? "ภาพเต็ม" : "ครอป"}${options.shelfOnly ? " · shelfOnly" : ""}`;
    this.el.reply.textContent = "…";
    this.setModels(used, "กำลังดูภาพ…");
    this.el.result.dataset.wait = "1";
    this.el.scanTag.textContent = used.length === 2 ? "AI ทั้ง 2 model กำลังดู" : used[0] === "shelf" ? "Model ชั้นวาง กำลังดู" : "Model ชื่อสินค้า กำลังดู";
    this.el.scan.dataset.tone = "";
    this.moveScan(step.area);
  }

  /** The agent answered: its boxes go on the picture, the models report their time. */
  reply(result: DetectResult, options: DetectOptions, frame?: { id: number; time: number }) {
    this.lastResult = result;
    this.log(result, options, frame);
    if (!this.shown) return;
    const used = modelsUsed(options.shelfOnly, !!this.agent?.manifest.shelfModel);
    this.setModels(used, `✓ ${Math.round(result.latency_ms)} ms`, true);
    const n = result.boxes.length;
    this.el.reply.textContent = `${n} กล่อง · ${Math.round(result.latency_ms)} ms`;
    this.drawBoxes(result);
    this.pulse(this.el.wireOut.querySelector(".wire-line i") as HTMLElement);
    if (this.el.jsonBox.open) this.renderJson();
  }

  /** What the web made of the answer. */
  decide(v: Verdict) {
    if (!this.shown) return;
    this.setVerdict(v);
    this.el.scan.dataset.tone = v.tone;
  }

  fail(message: string) {
    delete this.el.root.dataset.busy;
    this.setModels([], "");
    this.setVerdict({ tone: "bad", text: "ตรวจไม่สำเร็จ", sub: message });
    this.moveScan(null);
  }

  /** End of a watch round: the summary, with the reticle off. */
  roundDone(v: Verdict) {
    if (!this.shown) return;
    delete this.el.root.dataset.busy;
    this.el.kicker.textContent = "เว็บสรุปรอบ";
    this.el.title.textContent = "อัปเดตสถานะทุกช่องบนจอ";
    this.renderPhases("watch", 2);
    this.setModels([], "");
    this.setVerdict(v);
    this.moveScan(null);
  }

  // ------------------------------------------------------------ parts

  private renderPhases(phase: Phase | null, step: number) {
    if (phase !== this.phase) {
      this.phase = phase;
      this.el.phases.replaceChildren(...(phase ? PHASES[phase].map((label, i) => {
        const li = document.createElement("li");
        const n = document.createElement("span");
        n.className = "ph-n";
        n.textContent = String(i + 1);
        li.append(n, label);
        return li;
      }) : []));
    }
    [...this.el.phases.children].forEach((li, i) => {
      li.classList.toggle("on", i === step);
      li.classList.toggle("done", i < step);
    });
  }

  private setModels(active: Array<"primary" | "shelf">, text: string, done = false) {
    for (const [key, m] of this.models) {
      const on = active.includes(key);
      m.card.classList.toggle("on", on && !done);
      m.card.classList.toggle("done", on && done);
      m.card.classList.toggle("off", active.length > 0 && !on);
      m.state.textContent = on ? text : active.length ? "พักรอบนี้" : "";
    }
  }

  private setVerdict(v: Verdict | null) {
    delete this.el.result.dataset.wait;
    this.el.result.dataset.tone = v?.tone ?? "";
    const text = v?.text ?? "—", sub = v?.sub ?? "";
    if (this.el.verdict.textContent === text && this.el.verdictSub.textContent === sub) return;
    this.el.verdict.textContent = text;
    this.el.verdictSub.textContent = sub;
    if (v && !reduceMotion()) {
      this.el.verdict.animate([{ opacity: 0.5, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
  }

  private clearThumb() {
    this.ctx.fillStyle = "#0d0f13";
    this.ctx.fillRect(0, 0, THUMB_W, THUMB_H);
  }

  /** Draws the picture sent. A crop with a known place on the last whole frame is drawn as that frame with the
   *  crop boxed and the rest dimmed; returns true then. */
  private drawThumb(image: ImageBitmap, step: FlowStep): boolean {
    this.clearThumb();
    this.cropOn = null;
    if (!step.full && step.area && this.fullThumb) {
      const { x, y, w, h } = this.fullFit;
      this.ctx.drawImage(this.fullThumb, 0, 0);
      const [ax, ay, aw, ah] = step.area;
      const rx = x + ax * w, ry = y + ay * h, rw = Math.max(2, aw * w), rh = Math.max(2, ah * h);
      this.ctx.save();
      this.ctx.fillStyle = "rgba(13, 15, 19, 0.55)";
      this.ctx.beginPath();
      this.ctx.rect(0, 0, THUMB_W, THUMB_H);
      this.ctx.rect(rx, ry, rw, rh);
      this.ctx.fill("evenodd");
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = "#ffb020";
      this.ctx.strokeRect(rx, ry, rw, rh);
      this.ctx.restore();
      this.cropOn = { x: rx, y: ry, kx: rw / image.width, ky: rh / image.height };
      return true;
    }
    const k = Math.min(THUMB_W / image.width, THUMB_H / image.height);
    const w = image.width * k, h = image.height * k;
    this.fit = { x: (THUMB_W - w) / 2, y: (THUMB_H - h) / 2, k };
    this.ctx.drawImage(image, this.fit.x, this.fit.y, w, h);
    if (step.full) {
      this.fullThumb ??= Object.assign(document.createElement("canvas"), { width: THUMB_W, height: THUMB_H });
      const c = this.fullThumb.getContext("2d")!;
      c.clearRect(0, 0, THUMB_W, THUMB_H);
      c.drawImage(this.el.thumb, 0, 0);
      this.fullFit = { x: this.fit.x, y: this.fit.y, k, w, h };
    }
    return false;
  }

  /** Boxes of the 110-class model in blue, boxes of the shelf model in green, on the picture that was sent. */
  private drawBoxes(r: DetectResult) {
    const classes = this.agent?.manifest.model.classes ?? Infinity;
    const k = Math.min(THUMB_W / r.width, THUMB_H / r.height);
    const map = this.cropOn ?? { x: this.fit.x, y: this.fit.y, kx: k, ky: k };
    this.ctx.lineWidth = 2;
    for (const b of r.boxes) {
      const [x1, y1, x2, y2] = b.xyxy;
      this.ctx.strokeStyle = b.classId < classes ? "#6c9bff" : "#3ccf7a";
      this.ctx.strokeRect(map.x + x1 * map.kx, map.y + y1 * map.ky, (x2 - x1) * map.kx, (y2 - y1) * map.ky);
    }
  }

  /** The reticle glides to `area` (transform only, so it keeps moving during a detect call), or fades out. */
  private moveScan(area: Rect | null, animate = true) {
    this.area = area;
    const px = area && this.shown ? this.place(area) : null;
    const scan = this.el.scan;
    scan.classList.toggle("on", !!px);
    if (!px) return;
    scan.classList.toggle("instant", !animate || reduceMotion());
    const [x, y, w, h] = px;
    const c = Math.min(CORNER, w / 2, h / 2);
    const pos = [[x, y], [x + w - c, y], [x, y + h - c], [x + w - c, y + h - c]];
    this.el.corners.forEach((el, i) => { el.style.transform = `translate(${pos[i][0]}px, ${pos[i][1]}px) scale(${c / CORNER})`; });
    this.el.scanFill.style.transform = `translate(${x}px, ${y}px) scale(${w / 100}, ${h / 100})`;
    this.el.scanTag.style.transform = `translate(${x}px, ${y >= 30 ? y - 30 : y + 6}px)`;
  }

  /** One dot along a wire, once (Web Animations on transform: compositor). */
  private pulse(dot: HTMLElement | null) {
    if (!dot || reduceMotion()) return;
    dot.animate([{ transform: "translateX(0)", opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.85 }, { transform: "translateX(100%)", opacity: 0 }], { duration: 420, easing: "ease-in-out" });
  }

  private log(r: DetectResult, options: DetectOptions, frame?: { id: number; time: number }) {
    this.calls++;
    const li = document.createElement("li");
    const opts = JSON.stringify({ conf: options.conf, ...(options.shelfOnly ? { shelfOnly: true } : {}) });
    li.textContent = `#${this.calls}${frame ? ` [frame ${frame.id} @ ${(frame.time / 1000).toFixed(2)} s]` : ""} detect(${r.width}×${r.height}, ${opts}) → ${r.boxes.length} box · ${Math.round(r.latency_ms)} ms · ${r.backend}`;
    li.title = `model_sha256 ${r.model_sha256}`;
    this.el.log.querySelector(".muted")?.remove();
    this.el.log.prepend(li);
    while (this.el.log.children.length > LOG_LIMIT) this.el.log.lastElementChild!.remove();
  }

  private renderJson() {
    if (this.el.jsonBox.open) this.el.json.textContent = this.lastResult ? JSON.stringify(this.lastResult, null, 2) : "–";
  }
}
