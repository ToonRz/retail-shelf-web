// The "what is the agent doing" strip of the shelf watch page, and the reticle on the stage that shows where the
// model is looking. One card per step of the job (PHASES), in the order watch.ts runs them, each saying who does it
// (the agent and which model, or the web itself) and what came out of it.
//
// Readability: a crop takes ~30 ms on WebGPU, so anything redrawn per detect() call flickers. Only the step in
// progress changes while a round runs; a finished step keeps its summary, and a step not reached yet keeps last
// round's summary (dimmed) until it starts, so a steady shelf gives a steady strip.
// Smoothness: keep the strip lightweight so it can update without delaying or holding a detection round.
import type { Agent, DetectOptions, DetectResult } from "./agent-contract";
import { callStats, modelsUsed, PHASES, type Phase, type Verdict } from "./ui/flow-logic";

type Rect = [number, number, number, number]; // x, y, w, h
type ModelKey = "primary" | "shelf";

export interface FlowStep {
  phase: Phase;
  step: number;                 // index into PHASES[phase]
  title: string;                // what this call does, shown on the step's card while it runs
  area: Rect | null;            // where on the frame (fractions of it), for the reticle
  full?: boolean;               // the whole frame is sent (not a crop)
  progress?: [number, number];  // n of total, for steps made of many calls
}

export interface FlowJob {
  phase: Phase;
  kicker: string;
  title: string;
  mode: string;                 // how the job runs, as a chip in the head
  meta?: string;                // left as it is when omitted
}

type StepState = "wait" | "on" | "done" | "skip" | "bad";
interface Card { li: HTMLElement; text: HTMLElement; sub: HTMLElement; stats: HTMLElement; bar: HTMLElement; calls: number; ms: number }

const LOG_LIMIT = 30;
const CORNER = 22;
const SHOW_KEY = "watchFlowShow";
const MODEL_LABEL: Record<ModelKey, string> = { shelf: "▢ model ชั้นวาง", primary: "Aa model ชื่อสินค้า" };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const span = (className: string, text = "") => Object.assign(document.createElement("span"), { className, textContent: text });

export class FlowView {
  private el = {
    root: $("watchFlow"), title: $("flowTitle"), kicker: $("flowKicker"), meta: $("flowMeta"), mode: $("flowMode"),
    release: $("flowRelease"), steps: $("flowSteps"), show: $<HTMLInputElement>("watchFlowShow"),
    log: $("flowLog"), json: $("flowJson"), jsonBox: $<HTMLDetailsElement>("flowJsonBox"),
    scan: $("watchScan"), scanFill: $("watchScanFill"), scanTag: $("watchScanTag"),
    corners: ["tl", "tr", "bl", "br"].map((c) => $(`watchScan-${c}`)),
  };
  private models = new Map<ModelKey, { row: HTMLElement; state: HTMLElement; calls: number }>();
  private agent: Agent | null = null;
  private phase: Phase | null = null;
  private cards: Card[] = [];
  private started = new Set<number>(); // steps that have run in the current job
  private current: number | null = null;
  private calls = 0;
  private area: Rect | null = null;
  private lastResult: DetectResult | null = null;

  /** `place` maps fractions of the frame to pixels of the stage (null while there is no picture). */
  constructor(private place: (area: Rect) => Rect | null) {
    for (const key of ["primary", "shelf"] as const) {
      const row = $(`flowModel-${key}`);
      this.models.set(key, { row, state: row.querySelector<HTMLElement>(".fm-state")!, calls: 0 });
    }
    try { this.el.show.checked = localStorage.getItem(SHOW_KEY) !== "0"; } catch { /* private mode */ }
    this.el.show.addEventListener("change", () => {
      try { localStorage.setItem(SHOW_KEY, this.el.show.checked ? "1" : "0"); } catch { /* private mode */ }
      this.syncShown();
    });
    this.el.jsonBox.addEventListener("toggle", () => this.renderJson());
    new ResizeObserver(() => this.moveScan(this.area, false)).observe(this.el.scan.parentElement!);
    this.syncShown();
  }

  get shown() { return this.el.show.checked; }
  private syncShown() {
    this.el.root.hidden = !this.shown;
    if (!this.shown) this.moveScan(null);
  }

  // ------------------------------------------------------------ states

  ready(agent: Agent) {
    this.agent = agent;
    this.el.release.textContent = `agent ${agent.manifest.version} · ${agent.backend === "webgpu" ? "WebGPU" : "WASM"}`;
    const { model, shelfModel } = agent.manifest;
    const fill = (key: ModelKey, info: { name: string; classes: number; dataset: string; sha256?: string } | undefined) => {
      const m = this.models.get(key)!;
      m.row.hidden = !info;
      if (!info) return;
      m.row.querySelector(".fm-meta")!.textContent = `${info.classes} คลาส`;
      m.row.title = `${info.name} · ${info.dataset} · ${info.classes} classes${info.sha256 ? `\nsha256 ${info.sha256}` : ""}`;
    };
    fill("primary", model);
    fill("shelf", shelfModel);
    this.idle("พร้อมแล้ว", "เลือกรูป / วิดีโอ หรือเปิดกล้อง");
  }

  /** Nothing in flight: a headline, no reticle. The step cards keep the last job's results. */
  idle(kicker: string, title: string, meta?: string) {
    delete this.el.root.dataset.busy;
    this.el.kicker.textContent = kicker;
    this.el.title.textContent = title;
    if (meta !== undefined) this.el.meta.textContent = meta;
    if (this.current !== null && this.cards[this.current]?.li.dataset.state === "on") this.setState(this.current, "wait");
    this.current = null;
    this.lightModels([]);
    this.moveScan(null);
  }

  /** A new source: forget the last job and answer. */
  reset() {
    this.lastResult = null;
    this.el.log.replaceChildren();
    this.el.json.textContent = "–";
    this.phase = null;
    this.cards = [];
    this.el.steps.replaceChildren();
    this.el.mode.hidden = true;
    for (const m of this.models.values()) { m.calls = 0; m.state.textContent = ""; m.row.classList.remove("idle", "on"); }
    this.idle("รอภาพ", "รอรอบตรวจถัดไป", "");
  }

  /** A job (auto slots, or one watch round) starts: every step waits, still showing what it found last time. */
  start(job: FlowJob) {
    this.el.root.dataset.busy = "1";
    this.el.kicker.textContent = job.kicker;
    this.el.title.textContent = job.title;
    if (job.meta !== undefined) this.el.meta.textContent = job.meta;
    this.el.mode.hidden = false;
    this.el.mode.textContent = job.mode;
    if (job.phase !== this.phase) this.buildCards(job.phase);
    this.started.clear();
    this.current = null;
    this.cards.forEach((_, k) => this.setState(k, "wait"));
    for (const m of this.models.values()) m.calls = 0;
    this.lightModels([]);
  }

  /** The web hands a picture to the agent: the step's card shows what it is doing, the reticle moves there. */
  send(step: FlowStep, image: ImageBitmap, options: DetectOptions) {
    if (!this.shown) return;
    if (step.phase !== this.phase) this.buildCards(step.phase);
    const card = this.cards[step.step];
    if (!card) return;
    this.el.root.dataset.busy = "1";
    if (!this.started.has(step.step)) { this.started.add(step.step); card.calls = 0; card.ms = 0; card.stats.textContent = ""; }
    this.current = step.step;
    this.setState(step.step, "on");
    card.text.textContent = step.title;
    card.text.className = "fs-text";
    card.sub.textContent = `${step.full ? "ภาพเต็ม" : "ครอป"} ${image.width}×${image.height} px`;
    card.bar.style.width = step.progress ? `${Math.round((step.progress[0] / Math.max(1, step.progress[1])) * 100)}%` : "";
    card.bar.classList.toggle("indeterminate", !step.progress);
    const used = this.used(options);
    this.lightModels(used);
    this.el.scanTag.textContent = used.length === 2 ? "AI ทั้ง 2 model กำลังดู" : used[0] === "shelf" ? "Model ชั้นวาง กำลังดู" : "Model ชื่อสินค้า กำลังดู";
    this.el.scan.dataset.tone = "";
    this.moveScan(step.area);
  }

  /** The agent answered: the call is counted on its step and its model(s), and logged. */
  reply(result: DetectResult, options: DetectOptions, frame?: { id: number; time: number }) {
    this.lastResult = result;
    this.log(result, options, frame);
    if (!this.shown) return;
    const used = this.used(options);
    for (const key of used) this.models.get(key)!.calls++;
    this.lightModels([]);
    const card = this.current === null ? null : this.cards[this.current];
    if (card) {
      card.calls++;
      card.ms += result.latency_ms;
      card.stats.textContent = callStats(card.calls, card.ms);
    }
    if (this.el.jsonBox.open) this.renderJson();
  }

  /** What the web made of one answer: tints the reticle only (the card waits for the step's summary). */
  decide(v: Verdict) {
    if (!this.shown) return;
    this.el.scan.dataset.tone = v.tone;
  }

  /** A step is over: its card keeps this summary until the step runs again. */
  stepDone(step: number, v: Verdict) {
    if (!this.shown) return;
    const card = this.cards[step];
    if (!card) return;
    if (!this.started.has(step)) { this.started.add(step); card.calls = 0; card.ms = 0; card.stats.textContent = ""; }
    this.setState(step, "done");
    this.setResult(card, v);
    if (this.current === step) { this.current = null; this.moveScan(null); }
  }

  /** A step that does not run in this job (e.g. no full frame with the old method). */
  skip(step: number, why: string) {
    if (!this.shown) return;
    const card = this.cards[step];
    if (!card) return;
    this.started.add(step);
    this.setState(step, "skip");
    card.calls = 0; card.ms = 0;
    this.setResult(card, { tone: "info", text: "ข้าม", sub: why });
    card.text.className = "fs-text";
    card.stats.textContent = "";
  }

  fail(message: string) {
    delete this.el.root.dataset.busy;
    const card = this.current === null ? null : this.cards[this.current];
    if (card) {
      this.setState(this.current!, "bad");
      this.setResult(card, { tone: "bad", text: "ตรวจไม่สำเร็จ", sub: message });
    }
    this.current = null;
    this.lightModels([]);
    this.moveScan(null);
  }

  /** End of a watch round: the last step's summary, the round's numbers in the head, the reticle off. */
  roundDone(v: Verdict, title: string, meta: string) {
    if (!this.shown) return;
    if (this.phase) this.stepDone(PHASES[this.phase].length - 1, v);
    this.idle("กำลังเฝ้า", title, meta);
  }

  // ------------------------------------------------------------ parts

  private used(options: DetectOptions): ModelKey[] {
    return modelsUsed(options.shelfOnly, !!this.agent?.manifest.shelfModel);
  }

  private buildCards(phase: Phase) {
    this.phase = phase;
    const hasShelf = !!this.agent?.manifest.shelfModel;
    this.cards = PHASES[phase].map((def, k) => {
      const li = document.createElement("li");
      li.className = "flow-step";
      const top = document.createElement("div");
      top.className = "fs-top";
      top.append(span("fs-n", String(k + 1)), span("fs-title", def.title));
      const who = document.createElement("div");
      who.className = "fs-who";
      if (def.by === "web") who.append(span("fs-web", "เว็บ"));
      else who.append(span("fs-agent", "Agent"), ...modelsUsed(def.shelfOnly, hasShelf).map((m) => span("fs-model", MODEL_LABEL[m])));
      const result = document.createElement("p");
      result.className = "fs-result";
      const text = span("fs-text", "รอ…"), sub = span("fs-sub");
      result.append(text, " ", sub);
      const stats = Object.assign(document.createElement("p"), { className: "fs-stats" });
      const track = span("fs-bar"), bar = document.createElement("i");
      track.append(bar);
      li.append(top, who, result, stats, track);
      return { li, text, sub, stats, bar, calls: 0, ms: 0 };
    });
    this.el.steps.style.setProperty("--steps", String(this.cards.length));
    this.el.steps.replaceChildren(...this.cards.map((c) => c.li));
  }

  private setState(step: number, state: StepState) {
    const card = this.cards[step];
    if (card && card.li.dataset.state !== state) card.li.dataset.state = state;
  }

  private setResult(card: Card, v: Verdict) {
    if (card.text.textContent !== v.text) card.text.textContent = v.text;
    card.text.className = `fs-text tone-${v.tone}`;
    if (card.sub.textContent !== v.sub) card.sub.textContent = v.sub;
    card.bar.classList.remove("indeterminate");
    card.bar.style.width = "";
  }

  /** Models of the call in flight are lit; each row counts this job's calls. */
  private lightModels(active: ModelKey[]) {
    for (const [key, m] of this.models) {
      m.row.classList.toggle("on", active.includes(key));
      m.row.classList.toggle("idle", m.calls === 0 && !active.includes(key));
      const text = m.calls ? `${m.calls} call${m.calls > 1 ? "s" : ""}` : this.phase === "watch" && key === "primary" ? "ไม่ใช้ระหว่างเฝ้า (ใช้ตอนหาช่อง)" : this.phase ? "ไม่ได้ใช้" : "";
      if (m.state.textContent !== text) m.state.textContent = text;
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
