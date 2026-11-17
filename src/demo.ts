// Presentation page (#demo): a 1–2 minute walk-through for a live audience. Each model runs live in this browser on
// the sample pictures, then the agent's merged result, then a screen recording of the shelf watch page in real use.
// Autoplay moves through DEMO_STEPS on its own; ←/→ (or the step bar) jump, Space pauses, F goes full screen.
import type { Agent, Backend, Box, DetectResult } from "./agent-contract";
import { AGENT_VERSION, loadAgent } from "./agent";
import { CHAPTERS, chapterAt, clock, DEMO_STEPS, distinctNames, jsonPreview, splitBoxes, totalMs, VIDEO_SECONDS } from "./ui/demo-logic";
import { classColor, errorMessage, formatMB, prettyName } from "./ui/logic";
import { autoSlots, cropLabel, cropRect, type FoundItem, type Rect, toFoundItems, UNKNOWN_NAME } from "./ui/watch-logic";

const SAMPLES = ["lays.jpg", "hanami.jpg", "pocky.jpg", "copp.jpg"];
const SHELF = "demo-shelf.jpg"; // first frame of samples/demo-shelf.mp4 (the clip the recording watches)
const CONF = 0.25;
const REVEAL_MS = 1100; // boxes appear one by one over this long when a slide opens
// Same as the "find slots" job of the watch page (watch.ts findSlots): a name from a crop below NAME_CONF is dropped,
// and a crop that gives no name is tried once more, wider.
const NAME_CONF = 0.5;
const NAME_PADS = [0.15, 0.4];

const sampleUrl = (f: string) => `${import.meta.env.BASE_URL}samples/${f}`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const root = $("pageDemo");
const ui = {
  play: $<HTMLButtonElement>("demoPlay"), prev: $<HTMLButtonElement>("demoPrev"), next: $<HTMLButtonElement>("demoNext"),
  clock: $("demoClock"), steps: $("demoSteps"), notes: $<HTMLInputElement>("demoNotes"), full: $<HTMLButtonElement>("demoFull"),
  video: $<HTMLVideoElement>("demoVideo"), cap: $("demoCap"), chapters: $("demoChapters"),
  primaryGrid: $("demoPrimaryGrid"), primaryMs: $("demoPrimaryMs"), primaryNote: $("demoPrimaryNote"),
  shelfCanvas: $<HTMLCanvasElement>("demoShelfCanvas"), shelfCap: $("demoShelfCap"), shelfMs: $("demoShelfMs"),
  agentCanvas: $<HTMLCanvasElement>("demoAgentCanvas"), json: $("demoJson"), chain: $("demoChain"), crops: $("demoCrops"),
  chainFound: $("demoChainFound"), chainCrop: $("demoChainCrop"), chainNamed: $("demoChainNamed"), chainSlots: $("demoChainSlots"),
  agentSummary: $("demoAgentSummary"), agentMs: $("demoAgentMs"), agentCalls: $("demoAgentCalls"),
  agentNamed: $("demoAgentNamed"), agentSlots: $("demoAgentSlots"), backend: $("demoBackend"),
  agentName: $("demoAgentName"), sumMs: $("demoSumMs"),
};
const slides = [...root.querySelectorAll<HTMLElement>(".slide")];

// ---------------------------------------------------------------- live results

interface Shot { img: ImageBitmap; r: DetectResult }
interface Named { item: FoundItem; crop: ImageBitmap; r: DetectResult }
interface FindJob { full: Shot; named: Named[]; slots: Array<{ name: string; rect: Rect }>; ms: number; calls: number }
let results: { primary: Shot[]; shelf: Shot; classes: number } | null = null;
let find: FindJob | null = null;
let loading: Promise<void> | null = null;

/** Canvas pixels per CSS pixel as shown, so labels read the same size on a small thumbnail and a big frame. */
function displayScale(c: HTMLCanvasElement): number {
  return c.clientWidth > 0 ? c.width / c.clientWidth : c.width / 640;
}

function drawShot(c: HTMLCanvasElement, s: Shot, boxes: Box[], style: (b: Box) => { color: string; label: string; dashed?: boolean }, upto = boxes.length) {
  c.width = s.r.width;
  c.height = s.r.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(s.img, 0, 0);
  const px = displayScale(c);
  const lw = Math.max(1.5, 2 * px);
  const fs = Math.round(13 * px);
  ctx.lineWidth = lw;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  for (const b of boxes.slice(0, upto)) {
    const [x1, y1, x2, y2] = b.xyxy;
    const { color, label, dashed } = style(b);
    ctx.setLineDash(dashed ? [lw * 3, lw * 2] : []);
    ctx.strokeStyle = color;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
    if (!label) continue;
    const tw = ctx.measureText(label).width + 8, th = fs + 6;
    const ty = y1 - th >= 0 ? y1 - th : y1;
    ctx.fillStyle = color;
    ctx.fillRect(x1 - lw / 2, ty, tw, th);
    ctx.fillStyle = dashed ? "#16181d" : "#fff";
    ctx.fillText(label, x1 + 4, ty + 3);
  }
}

const named = (b: Box) => ({ color: classColor(b.classId), label: `${prettyName(b.cls)} ${b.conf.toFixed(2)}` });
const shelfStyle = (b: Box) => ({ color: "#2f6fec", label: `product ${b.conf.toFixed(2)}` });

/** Draws the slide's results, boxes appearing one by one (left to right) so the audience sees what was found. */
let revealRaf = 0;
function reveal(draws: Array<(upto: number) => void>, counts: number[]) {
  cancelAnimationFrame(revealRaf);
  const t0 = performance.now();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const frame = () => {
    const k = reduce ? 1 : Math.min(1, (performance.now() - t0) / REVEAL_MS);
    draws.forEach((d, i) => d(Math.round(counts[i] * k)));
    if (k < 1) revealRaf = requestAnimationFrame(frame);
  };
  frame();
}

const byX = (a: Box, b: Box) => a.xyxy[1] - b.xyxy[1] > 40 ? 1 : b.xyxy[1] - a.xyxy[1] > 40 ? -1 : a.xyxy[0] - b.xyxy[0];

function showPrimary() {
  if (!results) return;
  const canvases = [...ui.primaryGrid.querySelectorAll("canvas")];
  const sets = results.primary.map((s) => splitBoxes(s.r.boxes, results!.classes).named.sort(byX));
  reveal(canvases.map((c, i) => (n: number) => drawShot(c, results!.primary[i], sets[i], named, n)), sets.map((s) => s.length));
}

function showShelf() {
  if (!results) return;
  const boxes = [...results.shelf.r.boxes].sort(byX);
  reveal([(n) => drawShot(ui.shelfCanvas, results!.shelf, boxes, shelfStyle, n)], [boxes.length]);
}

let chainTimers: number[] = [];
const SLOT_COLOR = "#ffd166";
const nameColor = (name: string | null) => (name ? classColor([...name].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 110) : "#c9ced6");

/** Agent slide: the find-slots job of the watch page step by step: boxes → crops → names → slots. */
function showAgent() {
  chainTimers.forEach(clearTimeout);
  const items = [...ui.chain.children] as HTMLElement[];
  items.forEach((li) => li.classList.remove("on", "seen"));
  if (!find) return;
  const job = find;
  const thumbs = [...ui.crops.children] as HTMLElement[];
  thumbs.forEach((t) => t.classList.remove("on"));
  const boxes = job.named.map((n) => n.item);
  const draw = (stage: number, upto: number) => {
    // stage 0: unnamed boxes · 2: names up to `upto` · 3: + slots
    drawShot(ui.agentCanvas, job.full, boxes.slice(0, stage === 0 ? upto : boxes.length).map((it) => ({ cls: it.name ?? "product", classId: 0, conf: 1, xyxy: it.xyxy })), (b) => {
      const k = boxes.findIndex((it) => it.xyxy === b.xyxy);
      const shown = stage >= 2 && k < upto && boxes[k].name;
      if (stage >= 3) return { color: shown ? nameColor(boxes[k].name) : "#c9ced6", label: "", dashed: !shown }; // slot labels take over
      return shown ? { color: nameColor(boxes[k].name), label: prettyName(boxes[k].name!) } : { color: "#c9ced6", label: `${k + 1}`, dashed: true };
    });
    if (stage < 3) return;
    const ctx = ui.agentCanvas.getContext("2d")!;
    const { width: w, height: h } = job.full.r;
    const px = displayScale(ui.agentCanvas);
    const fs = Math.round(14 * px);
    ctx.lineWidth = 3 * px;
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    for (const s of job.slots.slice(0, upto)) {
      const [x, y, sw, sh] = s.rect;
      ctx.strokeStyle = SLOT_COLOR;
      ctx.strokeRect(x * w, y * h, sw * w, sh * h);
      const label = `ช่อง: ${prettyName(s.name)}`;
      const tw = ctx.measureText(label).width + 10, th = fs + 8;
      ctx.fillStyle = SLOT_COLOR;
      ctx.fillRect(x * w, y * h + sh * h - th, tw, th);
      ctx.fillStyle = "#16181d";
      ctx.fillText(label, x * w + 5, y * h + sh * h - th + 4);
    }
  };
  const anim = (ms: number, n: number, f: (upto: number) => void) => {
    cancelAnimationFrame(revealRaf);
    const t0 = performance.now();
    const frame = () => {
      const k = matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : Math.min(1, (performance.now() - t0) / ms);
      f(Math.round(n * k));
      if (k < 1) revealRaf = requestAnimationFrame(frame);
    };
    frame();
  };
  draw(0, 0);
  const at = (ms: number, f: () => void) => chainTimers.push(window.setTimeout(f, ms));
  const light = (i: number) => items.forEach((o, k) => { o.classList.toggle("on", k === i); o.classList.toggle("seen", k < i); });
  at(300, () => { light(0); anim(900, boxes.length, (n) => draw(0, n)); });
  at(2200, () => { light(1); anim(1400, thumbs.length, (n) => thumbs.forEach((t, k) => t.classList.toggle("on", k < n))); });
  at(4200, () => { light(2); anim(2400, boxes.length, (n) => draw(2, n)); });
  at(7200, () => { light(3); anim(1200, job.slots.length, (n) => draw(3, n)); });
  at(9400, () => light(4));
}

function renderNumbers() {
  if (!results) return;
  const { primary, shelf, classes } = results;
  const avg = primary.reduce((s, x) => s + x.r.latency_ms, 0) / primary.length;
  ui.primaryMs.textContent = avg.toFixed(0);
  const names = primary.map((s) => {
    const n = splitBoxes(s.r.boxes, classes).named;
    return n.length ? `${prettyName(n[0].cls)} ×${n.length}` : "ไม่เจอ";
  });
  ui.primaryNote.textContent = `ผล: ${names.join(" · ")} · กรอบสีตามชนิดสินค้า ตัวเลขคือความมั่นใจ`;
  ui.shelfMs.textContent = shelf.r.latency_ms.toFixed(0);
  ui.shelfCap.textContent = `เจอสินค้า ${shelf.r.boxes.length} ชิ้น · ${shelf.r.latency_ms.toFixed(0)} ms · ทุกกล่องเป็น "product"`;
  ui.sumMs.textContent = shelf.r.latency_ms.toFixed(0);
  ui.backend.textContent = shelf.r.backend === "webgpu" ? "WebGPU" : "WASM";
}

function renderFind() {
  if (!find) return;
  const { named, slots, ms, calls, full } = find;
  const ok = named.filter((n) => n.item.name).length;
  const { named: fullNamed } = splitBoxes(full.r.boxes, results?.classes ?? 110);
  ui.chainFound.textContent = `เจอ ${named.length} ชิ้น · ${full.r.latency_ms.toFixed(0)} ms`;
  ui.chainCrop.textContent = `${named.length} ครอป ขยายขอบ 15%`;
  ui.chainNamed.textContent = `ได้ชื่อ ${ok} / ${named.length} ชิ้น (${distinctNames(named.filter((n) => n.item.name).map((n) => ({ cls: n.item.name!, classId: 0, conf: 1, xyxy: n.item.xyxy })))} ชนิด)`;
  ui.chainSlots.textContent = `${slots.length} ช่อง: ${slots.map((s) => prettyName(s.name)).join(", ")}`;
  ui.agentSummary.textContent = `ภาพเต็มได้ชื่อแค่ ${fullNamed.length} กล่อง ครอปแล้วได้ชื่อ ${ok} / ${named.length} ชิ้น`;
  ui.agentNamed.textContent = `${ok} / ${named.length}`;
  ui.agentSlots.textContent = String(slots.length);
  ui.agentMs.textContent = ms.toFixed(0);
  ui.agentCalls.textContent = String(calls);
  ui.json.textContent = `// detect(ครอปชิ้นที่ 1)\n${jsonPreview(named[0]?.r ?? full.r)}`;
  ui.crops.replaceChildren(...named.map((n, i) => {
    const f = document.createElement("figure");
    const c = document.createElement("canvas");
    c.width = n.crop.width; c.height = n.crop.height;
    c.getContext("2d")!.drawImage(n.crop, 0, 0);
    const cap = document.createElement("figcaption");
    cap.textContent = `${i + 1}. ${n.item.name ? prettyName(n.item.name) : UNKNOWN_NAME}`;
    cap.style.color = n.item.name ? "" : "#ef6b6b";
    f.append(c, cap);
    return f;
  }));
}

/** What the watch page's "หาช่องอัตโนมัติ" does (watch.ts findSlots), minus the per-slot confirm: full frame → crops → names → slots. */
async function findSlots(agent: Agent, img: ImageBitmap, classes: number): Promise<FindJob> {
  const t0 = performance.now();
  let calls = 1;
  const r = await agent.detect(img, { conf: CONF });
  const items = toFoundItems(r.boxes, classes, r.width, r.height);
  const named: Named[] = [];
  for (const [k, item] of items.entries()) {
    ui.chainNamed.textContent = `กำลังตั้งชื่อ ${k + 1} / ${items.length}…`;
    let first: Named | null = null;
    for (const pad of NAME_PADS) {
      const crop = await createImageBitmap(img, ...cropRect(item.xyxy, r.width, r.height, pad));
      const c = await agent.detect(crop, { conf: Math.max(CONF, NAME_CONF) });
      calls++;
      item.name = cropLabel(c.boxes, classes, c.width, c.height);
      if (!first || item.name) { first?.crop.close(); first = { item, crop, r: c }; } else crop.close();
      if (item.name) break;
    }
    named.push(first!);
  }
  named.sort((a, b) => byX({ xyxy: a.item.xyxy } as Box, { xyxy: b.item.xyxy } as Box));
  return { full: { img, r }, named, slots: autoSlots(items, r.width, r.height), ms: performance.now() - t0, calls };
}

async function loadImage(f: string): Promise<ImageBitmap> {
  const res = await fetch(sampleUrl(f));
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

function loadResults(): Promise<void> {
  loading ??= (async () => {
    let agent: Agent | null = null;
    const say = (t: string) => { ui.shelfCap.textContent = t; ui.json.textContent = t; const p = ui.primaryGrid.querySelector("p"); if (p) p.textContent = t; };
    try {
      const backend = (($("backend") as HTMLSelectElement | null)?.value ?? "webgpu") as Backend;
      const imgsP = Promise.all([...SAMPLES, SHELF].map(loadImage));
      agent = await loadAgent(backend, (loaded, total) => say(`กำลังโหลด model ${formatMB(loaded)}${total ? ` / ${formatMB(total)}` : ""} MB`));
      ui.agentName.textContent = `shelf-agent.js ${agent.manifest.version}`;
      const imgs = await imgsP;
      say("กำลังตรวจ…");
      await agent.detect(imgs[0], { conf: CONF }); // warm-up: the first call compiles shaders / allocates
      const primary: Shot[] = [];
      for (const img of imgs.slice(0, SAMPLES.length)) primary.push({ img, r: await agent.detect(img, { conf: CONF }) });
      const shelfImg = imgs[SAMPLES.length];
      const shelf = { img: shelfImg, r: await agent.detect(shelfImg, { conf: CONF, shelfOnly: true }) };
      const classes = agent.manifest.model.classes;
      results = { primary, shelf, classes };
      ui.primaryGrid.replaceChildren(...primary.map((_, i) => {
        const c = document.createElement("canvas");
        c.setAttribute("aria-label", `ผลของ model ชื่อสินค้า รูปที่ ${i + 1}`);
        return c;
      }));
      renderNumbers();
      enter(index, false); // draw whatever slide is showing
      ui.json.textContent = "กำลังหาช่อง: ครอปตั้งชื่อทีละชิ้น…";
      find = await findSlots(agent, shelfImg, classes);
      renderFind();
      if (DEMO_STEPS[index].id === "agent") enter(index, false);
    } catch (e) {
      say(`โหลด / ตรวจไม่สำเร็จ: ${errorMessage(e)}`);
      loading = null; // let the next visit try again
    } finally {
      await agent?.dispose();
    }
  })();
  return loading;
}

// ---------------------------------------------------------------- slides + autoplay

let index = 0;
let playing = false;
let stepElapsed = 0;   // ms spent on the current step while playing
let lastTick = 0;
let raf = 0;
const videoMs = () => (Number.isFinite(ui.video.duration) && ui.video.duration > 0 ? ui.video.duration : VIDEO_SECONDS) * 1000;
const stepMs = (i: number) => DEMO_STEPS[i].ms ?? videoMs();

const stepButtons = DEMO_STEPS.map((st, i) => {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.innerHTML = `<span>${i + 1}. ${st.label}</span><span class="track"><span class="fill"></span></span>`;
  b.addEventListener("click", () => go(i));
  li.append(b);
  ui.steps.append(li);
  return b;
});

ui.chapters.replaceChildren(...CHAPTERS.map((ch) => {
  const li = document.createElement("li");
  const b = document.createElement("button");
  b.type = "button";
  b.className = ch.tone;
  b.innerHTML = `<time>${clock(ch.at * 1000)}</time><span><span class="t"></span><small></small></span>`;
  b.querySelector(".t")!.textContent = ch.title;
  b.querySelector("small")!.textContent = ch.note;
  b.addEventListener("click", () => { ui.video.currentTime = ch.at + 0.05; void ui.video.play(); });
  li.append(b);
  return li;
}));
const chapterButtons = [...ui.chapters.querySelectorAll("button")];

function showChapter() {
  const i = chapterAt(ui.video.currentTime);
  chapterButtons.forEach((b, k) => b.toggleAttribute("aria-current", k === i));
  const ch = CHAPTERS[i];
  if (ui.cap.textContent !== ch.title) { ui.cap.textContent = ch.title; ui.cap.dataset.tone = ch.tone; }
}
ui.video.addEventListener("timeupdate", showChapter);
ui.video.addEventListener("seeked", showChapter);
ui.video.addEventListener("loadedmetadata", paintBar);
ui.video.addEventListener("ended", () => { if (playing && DEMO_STEPS[index].id === "video") go(index + 1); });

function paintBar() {
  const cur = DEMO_STEPS[index].id === "video" ? ui.video.currentTime * 1000 : stepElapsed;
  stepButtons.forEach((b, i) => {
    b.toggleAttribute("aria-current", i === index);
    b.parentElement!.classList.toggle("done", i < index);
    const fill = b.querySelector<HTMLElement>(".fill")!;
    fill.style.transform = `scaleX(${i < index ? 1 : i > index ? 0 : Math.min(1, cur / stepMs(i))})`;
  });
  const before = DEMO_STEPS.slice(0, index).reduce((s, _, i) => s + stepMs(i), 0);
  ui.clock.textContent = `${clock(before + Math.min(cur, stepMs(index)))} / ${clock(totalMs(DEMO_STEPS, videoMs() / 1000))}`;
  ui.prev.disabled = index === 0;
  ui.next.disabled = index === DEMO_STEPS.length - 1;
}

function enter(i: number, restart = true) {
  const id = DEMO_STEPS[i].id;
  slides.forEach((s) => { s.hidden = s.dataset.step !== id; });
  const slide = slides.find((s) => s.dataset.step === id)!;
  if (restart) { slide.classList.remove("play"); void slide.offsetWidth; } // restart the CSS entrance
  slide.classList.add("play");
  if (id === "primary") showPrimary();
  else if (id === "shelf") showShelf();
  else if (id === "agent") showAgent();
  if (id === "video") {
    if (restart && playing) { ui.video.currentTime = 0; void ui.video.play().catch(() => undefined); }
    showChapter();
  } else if (!ui.video.paused) ui.video.pause();
}

function go(i: number) {
  if (i < 0) i = 0;
  if (i >= DEMO_STEPS.length) { i = DEMO_STEPS.length - 1; setPlaying(false); }
  index = i;
  stepElapsed = 0;
  enter(i);
  paintBar();
}

function tick(now: number) {
  if (playing && DEMO_STEPS[index].id !== "video") {
    stepElapsed += now - lastTick;
    if (stepElapsed >= stepMs(index)) {
      if (index === DEMO_STEPS.length - 1) { stepElapsed = stepMs(index); setPlaying(false); }
      else go(index + 1);
    }
  }
  lastTick = now;
  paintBar();
  if (playing || !ui.video.paused) raf = requestAnimationFrame(tick);
}

function setPlaying(on: boolean) {
  playing = on;
  const ended = index === DEMO_STEPS.length - 1 && stepElapsed >= stepMs(index);
  ui.play.textContent = on ? "❚❚ หยุดชั่วคราว" : ended ? "↺ เริ่มใหม่" : stepElapsed > 0 || index > 0 ? "▶ เล่นต่อ" : "▶ เริ่มนำเสนอ";
  cancelAnimationFrame(raf);
  if (DEMO_STEPS[index].id === "video") { if (on) void ui.video.play().catch(() => undefined); else ui.video.pause(); }
  lastTick = performance.now();
  if (on) raf = requestAnimationFrame(tick);
}
ui.video.addEventListener("play", () => { cancelAnimationFrame(raf); lastTick = performance.now(); raf = requestAnimationFrame(tick); });

ui.play.addEventListener("click", () => {
  if (!playing && index === DEMO_STEPS.length - 1 && stepElapsed >= stepMs(index)) go(0); // finished: start over
  setPlaying(!playing);
});
ui.prev.addEventListener("click", () => go(index - 1));
ui.next.addEventListener("click", () => go(index + 1));
ui.notes.addEventListener("change", () => root.classList.toggle("no-notes", !ui.notes.checked));
ui.full.addEventListener("click", toggleFull);

function toggleFull() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void root.requestFullscreen?.().catch(() => undefined);
}
document.addEventListener("fullscreenchange", () => { ui.full.textContent = document.fullscreenElement ? "ออกจากเต็มจอ" : "เต็มจอ"; });

document.addEventListener("keydown", (e) => {
  if (root.hidden || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target as HTMLElement;
  if (t.matches("input, select, textarea, video") || (t.matches("button") && (e.key === " " || e.key === "Enter"))) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") go(index + 1);
  else if (e.key === "ArrowLeft" || e.key === "PageUp") go(index - 1);
  else if (e.key === " ") setPlaying(!playing);
  else if (e.key === "f" || e.key === "F") toggleFull();
  else return;
  e.preventDefault();
});

// ---------------------------------------------------------------- page lifecycle (called by main.ts route())

let opened = false;
export function openDemo() {
  if (!opened) {
    opened = true;
    ui.video.poster = sampleUrl("demo-usage.jpg");
    ui.video.src = sampleUrl("demo-usage.mp4");
    ui.video.preload = "auto";
    ui.agentName.textContent = `shelf-agent.js ${AGENT_VERSION}`;
    go(0);
  }
  void loadResults();
}

export function closeDemo() {
  if (!opened) return;
  if (playing) setPlaying(false);
  ui.video.pause();
}
