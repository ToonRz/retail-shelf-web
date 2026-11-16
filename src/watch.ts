// Shelf watch page: draw one box per product slot (or let "auto slots" find them on a full shelf),
// then get an alert when a slot stays empty. A picture or video file finds its slots as soon as it is opened.
// Each slot is cropped from the camera, a video file or a still picture and checked for any product box with the 1-class shelf model only (shelfOnly).
import type { Agent, Backend, DetectOptions, DetectResult } from "./agent-contract";
import { FlowView, type FlowStep, type HoldKind } from "./flow";
import { confirmVerdict, followVerdict, foundVerdict, nameVerdict, roundVerdict, slotVerdict, topNameConf } from "./ui/flow-logic";
import { loadAgent, SHELF_AGENT_VERSION } from "./agent";
import { errorMessage, formatMB } from "./ui/logic";
import { autoSlots, clipRect, composeView, relView, cropLabel, endMessage, fitViews, frameMotion, MIN_SHARP, pinView, type Gray, IDENTITY, mapRect, refineView, type NBox, normBoxes, unmapRect, type View, visibleFraction, cropRect, dragToRect, motionScore, newTrack, parseSlots, type Rect, type Slot, slotHasProduct, stageToFrame, STATUS_TH, stepTrack, toFoundItems, toGray, type Track } from "./ui/watch-logic";

const INTERVAL_MS = 1000;
const CLEAR_MS = 3000;
const MOTION_BLOCKED = 14; // mean gray change between checks (0-255) that means someone is in front of the slot
const THUMB = 32;
const SLOTS_KEY = "watchSlots";
const NAME_CONF = 0.5;  // a name from a crop below this is more often wrong than right: keep "สินค้าอื่น" instead
const MAX_NAME_CROPS = 60; // products named one by one on a crop (~0.3-0.7 s each on WASM)
const NAME_PADS = [0.15, 0.4]; // crop around a product box, grown by this much of its size on each side
const GRAY_W = 128, GRAY_H = 96; // the small copy of each frame the view is matched on
const LOST_REFIT = 2;     // rounds in a row without a clear move from the last frame before trying the reference alone
const MIN_VISIBLE = 0.4;   // a slot with less of it inside the frame (zoomed in) is not judged: its timers pause

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  stage: $("watchStage"), video: $<HTMLVideoElement>("watchVideo"), image: $<HTMLImageElement>("watchImage"), overlay: $<HTMLCanvasElement>("watchOverlay"), empty: $("watchEmpty"),
  camBtn: $<HTMLButtonElement>("watchCamBtn"), fileBtn: $<HTMLButtonElement>("watchFileBtn"), file: $<HTMLInputElement>("watchFile"),
  startBtn: $<HTMLButtonElement>("watchStartBtn"), autoBtn: $<HTMLButtonElement>("watchAutoBtn"), clearBtn: $<HTMLButtonElement>("watchClearBtn"),
  hold: $<HTMLInputElement>("watchHold"), holdVal: $("watchHoldVal"), conf: $<HTMLInputElement>("watchConf"), confVal: $("watchConfVal"),
  banner: $("watchBanner"), outCount: $("watchOutCount"), latency: $("watchLatency"), slots: $("watchSlots"), log: $("watchLog"),
  notifyBtn: $<HTMLButtonElement>("watchNotifyBtn"), sound: $<HTMLInputElement>("watchSound"), follow: $<HTMLInputElement>("watchFollow"), status: $("watchStatus"),
  progress: $<HTMLProgressElement>("watchProgress"), pill: $("watchPill"), backend: $<HTMLSelectElement>("backend"),
};

let agent: Agent | null = null;
let slots: Slot[] = [];
let tracks = new Map<string, Track>();
let thumbs = new Map<string, Uint8Array>();
let stream: MediaStream | null = null;
let fileUrl: string | null = null;
let isImage = false; // the source is a still picture (ui.image) instead of ui.video
let running = false;
let finding = false; // auto slots in progress
let watchRound = 0;
// One owner at a time, even when an uncancellable model call is still settling.
let epoch = 0, sourceEpoch = 0, busy = false, wantsPlay = false;
let sourceLoad = new AbortController();
const cancelled = new Error("obsolete frame");
type Frame = { id: number; epoch: number; time: number; captured: number; detectMs: number; presenting: boolean };
let frameSerial = 0;
let active: Frame | null = null;
let snapshot: Frame | null = null;
const results = new Map<string, Frame>();
const assertCurrent = (f: Frame) => { if (f.epoch !== epoch) throw cancelled; };
const captureCanvas = document.createElement("canvas");
const snapshotCanvas = $<HTMLCanvasElement>("watchSnapshot");
function resetTimers() {
  tracks.clear(); thumbs.clear(); results.clear(); watchRound = 0;
  ui.latency.textContent = $("watchRoundLatency").textContent = "–";
  ui.log.replaceChildren(Object.assign(document.createElement("li"), { className: "muted placeholder", textContent: "ยังไม่มีการแจ้งเตือน" }));
}
function invalidate(keepSnapshot = false) {
  epoch++; active = null;
  if (!keepSnapshot) { snapshot = null; $("watchSnapshotBox").hidden = true; }
  flow.reset();
}
function capture(): { context: Frame; bitmap: Promise<ImageBitmap> } {
  const [width, height] = frameSize();
  captureCanvas.width = width; captureCanvas.height = height;
  const context = { id: ++frameSerial, epoch, time: now(), captured: performance.now(), detectMs: 0, presenting: !stream && flow.slow };
  // Copy pixels synchronously with the timestamp; decoding the bitmap may yield.
  captureCanvas.getContext("2d")!.drawImage(media(), 0, 0, width, height);
  snapshotCanvas.width = width; snapshotCanvas.height = height;
  snapshotCanvas.getContext("2d")!.drawImage(captureCanvas, 0, 0);
  active = snapshot = context;
  $("watchSnapshotBox").hidden = false;
  updateTimeline();
  drawOverlay();
  return { context, bitmap: createImageBitmap(captureCanvas) };
}
let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
let audio: AudioContext | null = null;
// Follow the view: slots are kept in the coordinates of a reference frame (the first watched frame after the slots
// changed) and moved by `view` (zoom + pan) found each round from the products the shelf model sees on the whole frame.
// Finding slots again every round would not work: an empty slot has no product to find, so it would just vanish.
let refBoxes: NBox[] | null = null;
let refGray: Gray | null = null;
let view: View = IDENTITY;
let lost = 0; // rounds in a row the view could not be found
let last: { gray: Gray; boxes: NBox[] } | null = null; // the frame of the last round the view was found on
const resetView = () => { refBoxes = refGray = null; last = null; view = IDENTITY; lost = 0; };
const grayCtx = Object.assign(document.createElement("canvas"), { width: GRAY_W, height: GRAY_H }).getContext("2d", { willReadFrequently: true })!;
const slotRect = (s: Slot) => mapRect(s.rect, view);
const isAway = (s: Slot) => visibleFraction(slotRect(s)) < MIN_VISIBLE; // zoomed / panned out of the frame
const thumbCtx = Object.assign(document.createElement("canvas"), { width: THUMB, height: THUMB }).getContext("2d", { willReadFrequently: true })!;

const setStatus = (text: string, bad = false) => { ui.status.textContent = text; ui.status.classList.toggle("bad", bad); };
/** Where a part of the frame (fractions) is drawn on the stage, in its pixels (the media is fitted with object-fit: contain). */
function onStage([x, y, w, h]: Rect): Rect | null {
  const [W, H] = frameSize(), sw = ui.stage.clientWidth, sh = ui.stage.clientHeight;
  if (!isImage || !W || !H || !sw || !sh || ui.overlay.hidden) return null;
  const k = Math.min(sw / W, sh / H), ox = (sw - W * k) / 2, oy = (sh - H * k) / 2;
  return [ox + x * W * k, oy + y * H * k, w * W * k, h * H * k];
}

const flow = new FlowView(onStage);

/** agent.detect, shown on the flow strip: the picture goes out, the models light up, the answer comes back. */
async function detectShown(image: ImageBitmap, options: DetectOptions, step: FlowStep, f: Frame): Promise<DetectResult> {
  assertCurrent(f);
  flow.send(step, image, options);
  await flow.nextPaint();
  try {
    assertCurrent(f);
    const started = performance.now();
    const r = await agent!.detect(image, options);
    assertCurrent(f);
    f.detectMs += performance.now() - started;
    flow.reply(r, options, { id: f.id, time: f.time });
    return r;
  } catch (e) {
    if (f.epoch === epoch) flow.fail(errorMessage(e));
    throw e;
  }
}

/** Shows what the web made of an answer; in presenter mode it then stays on screen for a moment. */
async function decide(v: Parameters<FlowView["decide"]>[0], kind: HoldKind, f: Frame) {
  assertCurrent(f);
  flow.decide(v);
  if (f.presenting) await flow.hold(kind);
  assertCurrent(f);
}

const media = () => (isImage ? ui.image : ui.video);
const frameSize = (): [number, number] => (isImage ? [ui.image.naturalWidth, ui.image.naturalHeight] : [ui.video.videoWidth, ui.video.videoHeight]);
const hasFrame = () => frameSize()[0] > 0;
const isVideoFile = () => !stream && !isImage; // has a timeline: it can be paused and it ends
const now = () => (isVideoFile() ? ui.video.currentTime * 1000 : performance.now());
/**
 * Hand the main thread back to the browser for a moment. The model runs on the main thread (WASM, one thread,
 * ~0.3-0.7 s per call), so without this a run of calls freezes the page: nothing repaints and clicks wait.
 */
const breathe = () => new Promise<void>((r) => setTimeout(r, 0));

function saveSlots() {
  try { localStorage.setItem(SLOTS_KEY, JSON.stringify(slots)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- draw

function drawOverlay() {
  const c = ui.overlay, [W, H] = frameSize();
  if (!W) return;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  const lw = Math.max(3, W / 300), fs = Math.max(14, W / 50);
  ctx.lineWidth = lw;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  const COLOR = { waiting: "#9aa1ad", stocked: "#2fa45a", checking: "#e0a100", out: "#e03b3b" };
  for (const s of slots) {
    if (!isImage && (running || finding || (isVideoFile() && !ui.video.paused))) continue;
    const rect = slotRect(s), status = isImage ? tracks.get(s.id)?.status ?? "waiting" : "waiting";
    const away = isAway(s);
    const [x, y, w, h] = away ? clipRect(rect) : rect;
    if (w <= 0 || h <= 0) continue;
    ctx.strokeStyle = ctx.fillStyle = COLOR[away ? "waiting" : status];
    if (away) ctx.setLineDash([lw * 3, lw * 2]);
    ctx.strokeRect(x * W, y * H, w * W, h * H);
    ctx.setLineDash([]);
    const label = away ? `${s.name} · นอกภาพ` : status === "waiting" ? s.name : `${s.name} · ${STATUS_TH[status]}`;
    ctx.fillRect(x * W, y * H, ctx.measureText(label).width + 12, fs + 8);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x * W + 6, y * H + 4);
  }
  if (snapshot) {
    const sc = snapshotCanvas.getContext("2d")!;
    sc.clearRect(0, 0, W, H); sc.drawImage(captureCanvas, 0, 0);
    sc.lineWidth = lw; sc.font = `600 ${fs}px system-ui`;
    for (const s of slots) {
      const [x, y, w, h] = clipRect(slotRect(s));
      const result = results.get(s.id);
      sc.strokeStyle = sc.fillStyle = COLOR[result?.id === snapshot.id ? tracks.get(s.id)?.status ?? "waiting" : "waiting"];
      sc.strokeRect(x * W, y * H, w * W, h * H); sc.fillText(s.name, x * W + 4, y * H + fs);
    }
  }
  if (drag) {
    const r = dragToRect(drag.x0, drag.y0, drag.x1, drag.y1, 0);
    if (r) { ctx.strokeStyle = "#6c9bff"; ctx.setLineDash([lw * 3, lw * 2]); ctx.strokeRect(r[0] * W, r[1] * H, r[2] * W, r[3] * H); ctx.setLineDash([]); }
  }
}

function renderSlots() {
  ui.slots.replaceChildren(...(slots.length ? slots.map((s) => {
    const tr = document.createElement("tr");
    const result = results.get(s.id);
    if (result) { tr.dataset.frameId = String(result.id); tr.dataset.frameTime = String(result.time); tr.dataset.captured = String(result.captured); tr.title = `Frame #${result.id} · ${(result.time / 1000).toFixed(2)} s`; }
    const nameTd = document.createElement("td");
    const input = Object.assign(document.createElement("input"), { value: s.name, className: "slot-name", type: "text" });
    input.setAttribute("aria-label", "ชื่อสินค้าในช่องนี้");
    input.addEventListener("change", () => { s.name = input.value.trim() || s.name; input.value = s.name; saveSlots(); drawOverlay(); });
    nameTd.append(input);
    const status = tracks.get(s.id)?.status ?? "waiting", away = isAway(s);
    const st = Object.assign(document.createElement("td"), { textContent: away ? "นอกภาพ" : STATUS_TH[status], className: `slot-${away ? "waiting" : status}` });
    if (result) st.append(Object.assign(document.createElement("small"), { className: "frame-stamp", textContent: `#${result.id} · ${(result.time / 1000).toFixed(2)} s` }));
    const del = document.createElement("td");
    del.className = "num";
    const btn = Object.assign(document.createElement("button"), { type: "button", textContent: "ลบ", className: "link" });
    btn.disabled = running || finding;
    btn.addEventListener("click", () => { slots = slots.filter((x) => x !== s); saveSlots(); renderSlots(); drawOverlay(); updateControls(); });
    del.append(btn);
    tr.append(nameTd, st, del);
    return tr;
  }) : [Object.assign(document.createElement("tr"), { innerHTML: '<td colspan="3" class="muted">ยังไม่มีช่อง กดหาช่องอัตโนมัติตอนชั้นเต็ม หรือลากกรอบบนภาพรอบสินค้าแต่ละชนิด</td>' })]));
  const out = slots.filter((s) => tracks.get(s.id)?.status === "out");
  ui.outCount.textContent = String(out.length);
  ui.banner.hidden = out.length === 0;
  ui.banner.textContent = out.length ? `ของหมด: ${out.map((s) => s.name).join(", ")}` : "";
}

function updateControls() {
  ui.startBtn.disabled = !agent || !hasFrame() || slots.length === 0 || finding;
  ui.startBtn.textContent = running ? "หยุดเฝ้า" : "เริ่มเฝ้า";
  ui.autoBtn.disabled = !agent || !hasFrame() || running || finding;
  ui.autoBtn.textContent = finding ? "กำลังหาช่อง…" : "หาช่องอัตโนมัติ";
  ui.clearBtn.disabled = running || finding || slots.length === 0;
  ui.overlay.classList.toggle("drawable", !running && !finding);
  ui.stage.classList.toggle("busy", finding);
}

ui.overlay.addEventListener("pointerdown", (e) => {
  if (running || finding || !hasFrame()) return;
  const b = ui.overlay.getBoundingClientRect();
  const [x, y] = stageToFrame(e.clientX - b.left, e.clientY - b.top, b.width, b.height, ...frameSize());
  drag = { x0: x, y0: y, x1: x, y1: y };
  ui.overlay.setPointerCapture(e.pointerId);
});
ui.overlay.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const b = ui.overlay.getBoundingClientRect();
  [drag.x1, drag.y1] = stageToFrame(e.clientX - b.left, e.clientY - b.top, b.width, b.height, ...frameSize());
  drawOverlay();
});
ui.overlay.addEventListener("pointerup", () => {
  if (!drag) return;
  const r: Rect | null = dragToRect(drag.x0, drag.y0, drag.x1, drag.y1);
  drag = null;
  if (r) {
    slots.push({ id: crypto.randomUUID(), name: `ช่อง ${slots.length + 1}`, rect: unmapRect(r, view) }); // drawn on the view as it is now
    saveSlots();
    renderSlots();
    updateControls();
  }
  drawOverlay();
});

ui.clearBtn.addEventListener("click", () => { slots = []; tracks = new Map(); resetView(); saveSlots(); renderSlots(); drawOverlay(); updateControls(); });

// ---------------------------------------------------------------- auto slots

/**
 * One pass on the current frame (shelf should be full): both models on the whole frame find the products, then every
 * product is cropped and named by the 110-class model on its crop alone, because that model only recognises a
 * product that fills most of the picture (its names on the whole frame are often wrong). Same-name neighbours
 * become one slot (autoSlots). Replaces the current slots.
 */
async function findSlots(ask = true) {
  if (!agent || running || finding || busy || !hasFrame()) return;
  if (ask && slots.length && !confirm(`แทนที่ ${slots.length} ช่องเดิมด้วยช่องที่หาอัตโนมัติ?`)) return;
  finding = busy = true;
  const jobEpoch = epoch;
  updateControls();
  renderSlots();
  // A video file is held on the frame the slots come from: it would otherwise play on (stock being taken
  // away, or the end of the file) while slots are found and checked, before watching has even started.
  if (isVideoFile()) { wantsPlay = false; ui.video.pause(); updateTimeline(); }
  ui.progress.hidden = false;
  const step = async (text: string, done: number, total: number) => {
    setStatus(text);
    ui.progress.max = total;
    ui.progress.value = done;
    await breathe();
    if (jobEpoch !== epoch) throw cancelled;
  };
  let frame: ImageBitmap | null = null;
  try {
    const captured = capture(), f = captured.context;
    frame = await captured.bitmap;
    assertCurrent(f);
    flow.round(null);
    await step("กำลังหาสินค้าในภาพ…", 0, 1);
    const conf = Number(ui.conf.value);
    const classes = agent.manifest.model.classes;
    // no shelfOnly: names from the 110-class model + "product" boxes of the shelf model
    const r = await detectShown(frame, { conf }, { phase: "find", step: 0, title: "หาสินค้าทุกชิ้นในภาพ", target: "ภาพเต็ม", area: [0, 0, 1, 1], full: true }, f);
    const items = toFoundItems(r.boxes, classes, r.width, r.height);
    await decide(foundVerdict(items.length), "full", f);
    const toName = items.slice(0, MAX_NAME_CROPS);
    for (const [k, it] of toName.entries()) {
      await step(`กำลังระบุชื่อสินค้า ${k + 1} / ${toName.length}…`, k, toName.length);
      for (const [p, pad] of NAME_PADS.entries()) { // a wider crop when the first one gives no confident name
        const cr = cropRect(it.xyxy, r.width, r.height, pad);
        const crop = await createImageBitmap(frame!, ...cr);
        try {
          const area: Rect = [cr[0] / r.width, cr[1] / r.height, cr[2] / r.width, cr[3] / r.height];
          const c = await detectShown(crop, { conf: Math.max(conf, NAME_CONF) }, { phase: "find", step: 1, title: `ระบุชื่อสินค้า ชิ้นที่ ${k + 1} / ${toName.length}`, target: p ? "ครอปกว้างขึ้น" : "ครอปรอบสินค้า", area }, f);
          it.name = cropLabel(c.boxes, classes, c.width, c.height);
          await decide(nameVerdict(it.name, topNameConf(c.boxes, classes), p === NAME_PADS.length - 1), "name", f);
        } finally {
          crop.close();
        }
        if (it.name) break;
      }
    }
    // The shelf is full now, so a slot the watch loop would already call empty (a stray box in the
    // background, a product cut by the frame edge) would only raise a false alarm: drop it.
    const found = [];
    const candidates = autoSlots(items, r.width, r.height);
    for (const [k, candidate] of candidates.entries()) {
      await step(`กำลังตรวจช่อง ${k + 1} / ${candidates.length}…`, k, candidates.length);
      const crop = await cropSlot(frame!, candidate.rect);
      try {
        const c = await detectShown(crop, { conf, shelfOnly: true }, { phase: "find", step: 2, title: `ยืนยันช่อง “${candidate.name}” (${k + 1} / ${candidates.length})`, target: "ครอปช่อง", area: candidate.rect }, f);
        const has = slotHasProduct(c.boxes, c.width, c.height);
        if (has) found.push(candidate);
        await decide(confirmVerdict(has), "confirm", f);
      } finally {
        crop.close();
      }
    }
    if (!found.length) {
      setStatus("ไม่เจอสินค้าในภาพ ลองตอนชั้นเต็ม ลดความมั่นใจขั้นต่ำ หรือลากกรอบเอง", true);
      flow.idle("หาช่องไม่เจอ", "ลองตอนชั้นเต็ม ลดความมั่นใจขั้นต่ำ หรือลากกรอบเอง");
      return;
    }
    slots = found.map((f) => ({ id: crypto.randomUUID(), ...f }));
    tracks = new Map();
    resetView();
    saveSlots();
    const named = items.filter((i) => i.name !== null).length;
    const dropped = candidates.length - found.length;
    setStatus(`เจอ ${found.length} ช่อง จากสินค้า ${items.length} ชิ้น (รู้ชื่อ ${named} ชิ้น)${dropped ? ` · ตัด ${dropped} ช่องที่ตอนนี้ก็ดูว่างอยู่แล้ว` : ""} · ตรวจกรอบ แก้ชื่อ ลบ หรือลากเพิ่มได้ แล้วกดเริ่มเฝ้า${isVideoFile() ? " (วิดีโอหยุดรอที่ภาพนี้)" : ""}`);
    flow.idle(`ได้ ${found.length} ช่อง`, "พร้อมเฝ้า · กด “เริ่มเฝ้า”");
  } catch (e) {
    if (jobEpoch !== epoch) return;
    setStatus(`หาช่องไม่สำเร็จ: ${errorMessage(e)}`, true);
    flow.idle("หาช่องไม่สำเร็จ", errorMessage(e));
  } finally {
    frame?.close();
    finding = busy = false;
    active = null;
    ui.progress.hidden = true;
    renderSlots();
    drawOverlay();
    updateControls();
    if (jobEpoch === epoch && wantsPlay && isVideoFile()) void playFile();
  }
}

ui.autoBtn.addEventListener("click", () => void findSlots());

// ---------------------------------------------------------------- alerts

function beep() {
  if (!ui.sound.checked) return;
  audio ??= new AudioContext();
  const o = audio.createOscillator(), g = audio.createGain();
  o.frequency.value = 880;
  g.gain.value = 0.15;
  o.connect(g).connect(audio.destination);
  o.start();
  o.stop(audio.currentTime + 0.35);
}

function logEvent(slot: Slot, event: "out" | "restocked", f: Frame) {
  const li = document.createElement("li");
  const when = !isVideoFile() ? new Date().toLocaleTimeString("th-TH") : `วินาทีที่ ${(f.time / 1000).toFixed(2)}`;
  li.textContent = `${when} · ${slot.name} ${event === "out" ? "ของหมด" : "เติมของแล้ว"}`;
  li.dataset.event = event;
  li.dataset.frameId = String(f.id);
  li.dataset.frameTime = String(f.time);
  if (event === "out") li.className = "bad";
  ui.log.querySelector(".placeholder")?.remove();
  ui.log.prepend(li);
  if (event === "out") {
    beep();
    if ("Notification" in window && Notification.permission === "granted") new Notification("ของหมดบนชั้นวาง", { body: slot.name });
  }
}

function syncNotifyBtn() {
  if (!("Notification" in window)) return;
  const p = Notification.permission;
  ui.notifyBtn.textContent = p === "granted" ? "เปิดแจ้งเตือนแล้ว" : p === "denied" ? "browser บล็อกการแจ้งเตือนไว้" : "เปิดแจ้งเตือนของ browser";
  ui.notifyBtn.disabled = p !== "default";
}

/** Must run inside a click: browsers only show the permission prompt for a user gesture. */
async function askNotify() {
  if (!("Notification" in window)) { setStatus("browser นี้ไม่รองรับการแจ้งเตือน", true); return; }
  if (Notification.permission === "default") await Notification.requestPermission();
  syncNotifyBtn();
}

ui.notifyBtn.addEventListener("click", () => void askNotify());

// ---------------------------------------------------------------- watch loop

/** The part of a frame (video or a still of it) inside a slot. */
function cropSlot(src: HTMLVideoElement | HTMLImageElement | ImageBitmap, [x, y, w, h]: Rect): Promise<ImageBitmap> {
  const [W, H] = src instanceof HTMLVideoElement ? [src.videoWidth, src.videoHeight] : src instanceof HTMLImageElement ? [src.naturalWidth, src.naturalHeight] : [src.width, src.height];
  return createImageBitmap(src, Math.round(x * W), Math.round(y * H), Math.max(1, Math.round(w * W)), Math.max(1, Math.round(h * H)));
}

async function checkSlot(frame: ImageBitmap, s: Slot, conf: number, cfg: { holdMs: number; clearMs: number }, k: number, f: Frame): Promise<number> {
  const rect = slotRect(s);
  if (isAway(s)) { // zoomed or panned away: says nothing about the stock, like a blocked slot
    tracks.set(s.id, stepTrack(tracks.get(s.id) ?? newTrack(), false, true, f.time, cfg).track);
    thumbs.delete(s.id);
    results.set(s.id, f);
    return 0;
  }
  const crop = await cropSlot(frame, clipRect(rect));
  try {
    assertCurrent(f);
    thumbCtx.drawImage(crop, 0, 0, THUMB, THUMB);
    const gray = toGray(thumbCtx.getImageData(0, 0, THUMB, THUMB).data);
    const prev = thumbs.get(s.id);
    thumbs.set(s.id, gray);
    // only "is there a box" matters here: skip the 110-class model
    const r = await detectShown(crop, { conf, shelfOnly: true }, { phase: "watch", step: 1, title: `ตรวจช่อง “${s.name}” (${k + 1} / ${slots.length})`, target: "ครอปช่อง", area: clipRect(rect) }, f);
    const has = slotHasProduct(r.boxes, r.width, r.height);
    const blocked = prev !== undefined && motionScore(prev, gray) > MOTION_BLOCKED;
    const before = tracks.get(s.id)?.status;
    const { track, event } = stepTrack(tracks.get(s.id) ?? newTrack(), has, blocked, f.time, cfg);
    tracks.set(s.id, track);
    results.set(s.id, f);
    if (event) logEvent(s, event, f);
    if (track.status !== before) { renderSlots(); drawOverlay(); } // the screen follows each answer, not only the end of the round
    await decide(slotVerdict(track, has, blocked, event, f.time, cfg.holdMs), "slot", f);
    return r.latency_ms;
  } finally {
    crop.close();
  }
}

/**
 * Where the reference frame is in this frame now (zoom + pan). Each round first measures how the frame moved since
 * the last round (frameMotion, trying the moves the boxes of the last frame and of the reference allow): not at all =
 * the view stays as it is (taking products away can never move the frames); a move = the last view carried over by
 * it, pinned to the reference close by (pinView). Only when the move
 * is unclear for a few rounds in a row is the reference searched alone: every view the product boxes allow
 * (fitViews), the pictures pick one (refineView).
 */
async function followView(frame: ImageBitmap, conf: number, f: Frame): Promise<number> {
  const r = await detectShown(frame, { conf, shelfOnly: true }, { phase: "watch", step: 0, title: "เช็กว่ากล้องขยับไหม", target: "ภาพเต็ม", area: [0, 0, 1, 1], full: true }, f);
  const before = view;
  const boxes = normBoxes(r.boxes, r.width, r.height);
  grayCtx.drawImage(frame, 0, 0, GRAY_W, GRAY_H);
  const gray: Gray = { w: GRAY_W, h: GRAY_H, px: toGray(grayCtx.getImageData(0, 0, GRAY_W, GRAY_H).data) };
  if (!refBoxes || !refGray) {
    refBoxes = boxes; refGray = gray; view = IDENTITY; lost = 0;
    last = { gray, boxes };
  } else {
    // moves from the boxes of the last frame, and those implied by the reference (fitViews) given the current view
    const viaRef = fitViews(refBoxes, boxes, view).map((f) => relView(f.view, view));
    const mv = last ? frameMotion(last.gray, gray, last.boxes, boxes, viaRef) : null;
    await breathe();
    assertCurrent(f);
    if (mv) {
      if (!mv.still) view = pinView(refGray, gray, composeView(mv.view, view));
      lost = 0;
      last = { gray, boxes };
    } else if (++lost >= LOST_REFIT) {
      const m = refineView(refGray, gray, [...fitViews(refBoxes, boxes, view).map((f) => f.view), view]);
      if (m.sharp >= MIN_SHARP) { view = m.view; lost = 0; last = { gray, boxes }; }
    }
  }
  setStatus(watchStatus());
  await decide(followVerdict(r.boxes.length, view.s, view !== before, lost > 0), "follow", f);
  return r.latency_ms;
}

function watchStatus(): string {
  const zoomed = Math.abs(view.s - 1) > 0.03 || Math.abs(view.tx) > 0.02 || Math.abs(view.ty) > 0.02;
  return `กำลังเฝ้าชั้นวาง · เปิดแท็บนี้ค้างไว้${lost >= 2 ? " · หาตำแหน่งชั้นในภาพไม่เจอ ใช้ตำแหน่งล่าสุด" : zoomed ? ` · ภาพขยับ (ซูม ×${view.s.toFixed(2)}) กรอบตามไปแล้ว` : ""}`;
}

async function loop() {
  if (busy || !running) return;
  busy = true;
  try {
    while (running) {
      if (isVideoFile() && (ui.video.ended || !wantsPlay || ui.video.seeking)) break;
      const held = isVideoFile() && flow.slow;
      if (held) ui.video.pause();
      const t0 = performance.now();
      const captured = capture(), f = captured.context;
      let frame: ImageBitmap | null = null;
      flow.round(++watchRound);
      try {
        frame = await captured.bitmap;
        assertCurrent(f);
        const cfg = { holdMs: Number(ui.hold.value) * 1000, clearMs: CLEAR_MS };
        const conf = Number(ui.conf.value);
        if (ui.follow.checked) { await followView(frame, conf, f); assertCurrent(f); }
        for (const [k, s] of slots.entries()) {
          assertCurrent(f);
          await checkSlot(frame, s, conf, cfg, k, f);
          await breathe();
        }
        assertCurrent(f);
        renderSlots(); drawOverlay();
        flow.roundDone(roundVerdict(slots.filter((s) => !isAway(s)).map((s) => tracks.get(s.id)?.status ?? "waiting"), slots.filter(isAway).length));
        if (f.presenting) await flow.hold("round");
        assertCurrent(f);
        active = null;
        if (held && wantsPlay && running && !ui.video.ended) await ui.video.play();
        await new Promise(r => setTimeout(r, INTERVAL_MS));
        assertCurrent(f);
        ui.latency.textContent = f.detectMs.toFixed(0);
        $("watchRoundLatency").textContent = (performance.now() - t0).toFixed(0);
      } catch (e) {
        if (f.epoch === epoch) stop(`ตรวจไม่สำเร็จ: ${errorMessage(e)}`, true);
        break;
      } finally { frame?.close(); }
    }
  } catch (e) {
    stop(`ตรวจไม่สำเร็จ: ${errorMessage(e)}`, true);
  } finally {
    busy = false;
    active = null;
    if (running && (!isVideoFile() || (wantsPlay && !ui.video.ended && !ui.video.seeking))) void loop();
  }
}

function start() {
  if (running) return;
  invalidate();
  resetTimers();
  running = true;
  audio?.resume();
  if ("Notification" in window && Notification.permission === "default") void askNotify(); // the start click is the gesture
  renderSlots();
  updateControls();
  setStatus(watchStatus());
  if (isVideoFile()) { wantsPlay = true; void playFile(); }
  else void loop();
}

function stop(message = "หยุดเฝ้าแล้ว", bad = false) {
  running = false;
  wantsPlay = false;
  invalidate(true);
  if (isVideoFile()) ui.video.pause();
  renderSlots();
  updateControls();
  setStatus(message, bad);
  if (!bad) flow.idle("หยุดเฝ้าแล้ว", message === "หยุดเฝ้าแล้ว" ? "กด “เริ่มเฝ้า” เพื่อเฝ้าต่อ" : message);
}

ui.startBtn.addEventListener("click", () => (running ? stop() : start()));

// Controls live outside the stage, so drawing and scan overlays cannot intercept them.
async function playFile() {
  const token = epoch;
  try {
    if (!active) await ui.video.play();
    if (token === epoch && wantsPlay) void loop();
    else if (!wantsPlay && isVideoFile()) ui.video.pause();
  } catch (e) { if (token === epoch) { wantsPlay = false; setStatus(errorMessage(e), true); } }
  updateTimeline();
}
function updateTimeline() {
  const seek = $<HTMLInputElement>("watchSeek");
  seek.max = String(Number.isFinite(ui.video.duration) ? ui.video.duration : 0);
  seek.value = String(ui.video.currentTime);
  const fmt = (s: number) => Number.isFinite(s) ? `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}` : "–";
  $("watchTime").textContent = `${fmt(ui.video.currentTime)} / ${fmt(ui.video.duration)}`;
  $("watchPlay").textContent = wantsPlay ? "พัก" : "เล่น";
  ui.slots.querySelectorAll<HTMLElement>("tr[data-frame-id]").forEach(row => {
    const stamp = row.querySelector(".frame-stamp");
    if (stamp) stamp.textContent = `#${row.dataset.frameId} · ${(Number(row.dataset.frameTime) / 1000).toFixed(2)} s · อายุ ${((performance.now() - Number(row.dataset.captured)) / 1000).toFixed(1)} s`;
  });
  if (snapshot) $("watchFrameInfo").textContent = `Snapshot #${snapshot.id} · ${isVideoFile() ? "เวลาวิดีโอ" : "เวลา monotonic"} ${(snapshot.time / 1000).toFixed(2)} s · อายุภาพ/ผล ${((performance.now() - snapshot.captured) / 1000).toFixed(1)} s${active ? " · กำลังตรวจ" : ""}`;
}
$("watchPlay").addEventListener("click", () => {
  if (!isVideoFile()) return;
  wantsPlay = !wantsPlay;
  if (wantsPlay) void playFile();
  else { invalidate(true); ui.video.pause(); flow.idle("พัก", running ? "กดเล่นเพื่อเฝ้าต่อ" : "พักวิดีโอ"); }
  updateTimeline(); drawOverlay();
});
$("watchSeek").addEventListener("input", () => {
  invalidate(); resetTimers();
  ui.video.currentTime = Number($<HTMLInputElement>("watchSeek").value);
});
ui.video.addEventListener("seeking", () => {
  invalidate(); resetTimers(); renderSlots(); drawOverlay();
});
ui.video.addEventListener("seeked", () => { if (wantsPlay) void playFile(); });
ui.video.addEventListener("ended", () => { if (isVideoFile()) stop(endMessage(slots, tracks, Number(ui.hold.value))); });
$("watchSpeed").addEventListener("change", () => { ui.video.playbackRate = Number($<HTMLSelectElement>("watchSpeed").value); });
ui.video.addEventListener("timeupdate", updateTimeline);
setInterval(updateTimeline, 250);

// ---------------------------------------------------------------- sources

function closeSource() {
  sourceEpoch++;
  sourceLoad.abort(); sourceLoad = new AbortController();
  stop();
  invalidate();
  resetTimers();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = null;
  ui.video.removeAttribute("src");
  ui.video.srcObject = null;
  ui.video.load(); // drop the old frame, so videoWidth is 0 until the new source is ready
  isImage = false;
  $("watchTransport").hidden = true;
  flow.reset();
  flow.idle("รอภาพ", "เลือกรูป / วิดีโอ หรือเปิดกล้อง");
  resetView();
  slots = []; saveSlots(); renderSlots();
  ui.image.removeAttribute("src");
  ui.video.hidden = ui.image.hidden = ui.overlay.hidden = true;
  ui.empty.hidden = false;
  updateControls();
}

async function showSource(token: number) {
  if (isImage) {
    await ui.image.decode();
  } else {
    const signal = sourceLoad.signal;
    await new Promise<void>((res, rej) => {
      if (ui.video.readyState >= 2) return res();
      const loaded = () => { cleanup(); res(); };
      const failed = () => { cleanup(); rej(new Error("video")); };
      const cleanup = () => { ui.video.removeEventListener("loadeddata", loaded); ui.video.removeEventListener("error", failed); signal.removeEventListener("abort", failed); };
      ui.video.addEventListener("loadeddata", loaded, { once: true });
      ui.video.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", failed, { once: true });
    });
    if (token !== sourceEpoch) throw cancelled;
    if (stream) await ui.video.play();
  }
  if (token !== sourceEpoch) throw cancelled;
  wantsPlay = !!stream;
  $("watchTransport").hidden = !isVideoFile();
  ui.video.hidden = isImage;
  ui.image.hidden = !isImage;
  ui.overlay.hidden = false;
  ui.empty.hidden = true;
  drawOverlay();
  updateControls();
  setStatus("กดหาช่องอัตโนมัติตอนชั้นเต็ม หรือลากกรอบรอบสินค้าแต่ละชนิด แล้วกดเริ่มเฝ้า");
  flow.idle("ภาพพร้อม", "กดหาช่องอัตโนมัติ หรือลากกรอบรอบสินค้าเอง");
}

ui.camBtn.addEventListener("click", async () => {
  if (running) stop();
  if (!navigator.mediaDevices?.getUserMedia) { setStatus("browser นี้ใช้กล้องไม่ได้ (ต้องเปิดผ่าน https)", true); return; }
  closeSource();
  const token = sourceEpoch;
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false });
    if (token !== sourceEpoch) { acquired.getTracks().forEach(t => t.stop()); return; }
    stream = acquired;
  } catch (e) {
    if (token !== sourceEpoch) return;
    setStatus(`เปิดกล้องไม่ได้: ${(e as Error).name === "NotAllowedError" ? "ไม่ได้รับอนุญาตให้ใช้กล้อง" : (e as Error).message}`, true);
    return;
  }
  ui.video.srcObject = stream;
  try { await showSource(token); } catch (e) { if (token === sourceEpoch) setStatus(errorMessage(e), true); }
});

/** A picture or video file: shown, then its slots are found right away (they replace the slots of the last picture). */
async function openFile(f: File) {
  if (!agent) return;
  const image = f.type.startsWith("image/");
  if (!image && !f.type.startsWith("video/")) { setStatus("เลือกได้เฉพาะไฟล์รูปหรือวิดีโอ", true); return; }
  if (running) stop();
  closeSource();
  const token = sourceEpoch;
  fileUrl = URL.createObjectURL(f);
  isImage = image;
  if (image) ui.image.src = fileUrl; else ui.video.src = fileUrl;
  try {
    await showSource(token);
  } catch {
    if (token !== sourceEpoch) return;
    closeSource();
    updateControls();
    setStatus(`เปิดไฟล์ ${f.name} ไม่ได้ (browser นี้อาจไม่รองรับไฟล์ชนิดนี้)`, true);
    return;
  }
  slots = []; // they were drawn on another picture
  tracks = new Map();
  saveSlots();
  renderSlots();
  while (busy && token === sourceEpoch) await new Promise(r => setTimeout(r, 20));
  if (token === sourceEpoch) await findSlots(false);
}

ui.fileBtn.addEventListener("click", () => ui.file.click());
ui.file.addEventListener("change", () => {
  const f = ui.file.files?.[0];
  ui.file.value = "";
  if (f) void openFile(f);
});
ui.stage.addEventListener("dragover", (e) => { if (!ui.fileBtn.disabled) e.preventDefault(); });
ui.stage.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f && !ui.fileBtn.disabled) void openFile(f);
});

const syncLabels = () => { ui.holdVal.textContent = ui.hold.value; ui.confVal.textContent = Number(ui.conf.value).toFixed(2); };
ui.hold.addEventListener("input", syncLabels);
ui.conf.addEventListener("input", syncLabels);

// ---------------------------------------------------------------- start

let opened = false;

/** Runs the first time the page is opened, so the second model is only downloaded when it is needed. */
export async function openWatch() {
  if (opened) return;
  opened = true;
  try { slots = parseSlots(localStorage.getItem(SLOTS_KEY)); } catch { /* private mode */ }
  syncLabels();
  syncNotifyBtn();
  renderSlots();
  ui.pill.textContent = `agent ${SHELF_AGENT_VERSION}`;
  ui.progress.hidden = SHELF_AGENT_VERSION === "mock";
  setStatus("กำลังโหลด model สำหรับเฝ้าชั้นวาง…");
  try {
    agent = await loadAgent(ui.backend.value as Backend, (loaded, total) => {
      if (total) { ui.progress.max = total; ui.progress.value = loaded; }
      setStatus(`กำลังโหลด model ${formatMB(loaded)}${total ? ` / ${formatMB(total)}` : ""} MB`);
    }, SHELF_AGENT_VERSION);
    flow.ready(agent);
    ui.pill.textContent = `agent ${agent.manifest.version} · ${agent.backend === "webgpu" ? "WebGPU" : "WASM"}`;
    ui.camBtn.disabled = ui.fileBtn.disabled = false;
    setStatus("พร้อมใช้ · เปิดกล้อง หรือเลือก / ลากรูปหรือวิดีโอตอนชั้นเต็มมาวาง (หาช่องให้อัตโนมัติ)");
    updateControls();
  } catch (e) {
    opened = false;
    setStatus(`โหลด agent ไม่ได้: ${errorMessage(e)}`, true);
    flow.idle("โหลด agent ไม่ได้", errorMessage(e));
  } finally {
    ui.progress.hidden = true;
  }
}
