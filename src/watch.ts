// Shelf watch page: draw one box per product slot (or let "auto slots" find them on a full shelf),
// then get an alert when a slot stays empty.
// Each slot is cropped from the camera or a video file and checked for any product box with the 1-class shelf model only (shelfOnly).
import type { Agent, Backend } from "./agent-contract";
import { loadAgent, SHELF_AGENT_VERSION } from "./agent";
import { errorMessage, formatMB } from "./ui/logic";
import { autoSlots, cropLabel, cropRect, dragToRect, motionScore, newTrack, parseSlots, type Rect, type Slot, slotHasProduct, stageToFrame, STATUS_TH, stepTrack, toFoundItems, toGray, type Track } from "./ui/watch-logic";

const INTERVAL_MS = 1000;
const CLEAR_MS = 3000;
const MOTION_BLOCKED = 14; // mean gray change between checks (0-255) that means someone is in front of the slot
const THUMB = 32;
const SLOTS_KEY = "watchSlots";
const NAME_CONF = 0.5;  // a name from a crop below this is more often wrong than right: keep "สินค้าอื่น" instead
const MAX_NAME_CROPS = 60; // unnamed boxes looked at one by one (~0.7 s each on WASM)

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  stage: $("watchStage"), video: $<HTMLVideoElement>("watchVideo"), overlay: $<HTMLCanvasElement>("watchOverlay"), empty: $("watchEmpty"),
  camBtn: $<HTMLButtonElement>("watchCamBtn"), fileBtn: $<HTMLButtonElement>("watchFileBtn"), file: $<HTMLInputElement>("watchFile"),
  startBtn: $<HTMLButtonElement>("watchStartBtn"), autoBtn: $<HTMLButtonElement>("watchAutoBtn"), clearBtn: $<HTMLButtonElement>("watchClearBtn"),
  hold: $<HTMLInputElement>("watchHold"), holdVal: $("watchHoldVal"), conf: $<HTMLInputElement>("watchConf"), confVal: $("watchConfVal"),
  banner: $("watchBanner"), outCount: $("watchOutCount"), latency: $("watchLatency"), slots: $("watchSlots"), log: $("watchLog"),
  notifyBtn: $<HTMLButtonElement>("watchNotifyBtn"), sound: $<HTMLInputElement>("watchSound"), status: $("watchStatus"),
  progress: $<HTMLProgressElement>("watchProgress"), pill: $("watchPill"), backend: $<HTMLSelectElement>("backend"),
};

let agent: Agent | null = null;
let slots: Slot[] = [];
let tracks = new Map<string, Track>();
let thumbs = new Map<string, Uint8Array>();
let stream: MediaStream | null = null;
let fileUrl: string | null = null;
let running = false;
let finding = false; // auto slots in progress
let drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
let audio: AudioContext | null = null;
const thumbCtx = Object.assign(document.createElement("canvas"), { width: THUMB, height: THUMB }).getContext("2d", { willReadFrequently: true })!;

const setStatus = (text: string, bad = false) => { ui.status.textContent = text; ui.status.classList.toggle("bad", bad); };
const hasFrame = () => ui.video.videoWidth > 0;
const now = () => (stream ? performance.now() : ui.video.currentTime * 1000);

function saveSlots() {
  try { localStorage.setItem(SLOTS_KEY, JSON.stringify(slots)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- draw

function drawOverlay() {
  const c = ui.overlay, W = ui.video.videoWidth, H = ui.video.videoHeight;
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
    const [x, y, w, h] = s.rect, status = tracks.get(s.id)?.status ?? "waiting";
    ctx.strokeStyle = ctx.fillStyle = COLOR[status];
    ctx.strokeRect(x * W, y * H, w * W, h * H);
    const label = status === "waiting" ? s.name : `${s.name} · ${STATUS_TH[status]}`;
    ctx.fillRect(x * W, y * H, ctx.measureText(label).width + 12, fs + 8);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, x * W + 6, y * H + 4);
  }
  if (drag) {
    const r = dragToRect(drag.x0, drag.y0, drag.x1, drag.y1, 0);
    if (r) { ctx.strokeStyle = "#6c9bff"; ctx.setLineDash([lw * 3, lw * 2]); ctx.strokeRect(r[0] * W, r[1] * H, r[2] * W, r[3] * H); ctx.setLineDash([]); }
  }
}

function renderSlots() {
  ui.slots.replaceChildren(...(slots.length ? slots.map((s) => {
    const tr = document.createElement("tr");
    const nameTd = document.createElement("td");
    const input = Object.assign(document.createElement("input"), { value: s.name, className: "slot-name", type: "text" });
    input.setAttribute("aria-label", "ชื่อสินค้าในช่องนี้");
    input.addEventListener("change", () => { s.name = input.value.trim() || s.name; input.value = s.name; saveSlots(); drawOverlay(); });
    nameTd.append(input);
    const status = tracks.get(s.id)?.status ?? "waiting";
    const st = Object.assign(document.createElement("td"), { textContent: STATUS_TH[status], className: `slot-${status}` });
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
}

ui.overlay.addEventListener("pointerdown", (e) => {
  if (running || finding || !hasFrame()) return;
  const b = ui.overlay.getBoundingClientRect();
  const [x, y] = stageToFrame(e.clientX - b.left, e.clientY - b.top, b.width, b.height, ui.video.videoWidth, ui.video.videoHeight);
  drag = { x0: x, y0: y, x1: x, y1: y };
  ui.overlay.setPointerCapture(e.pointerId);
});
ui.overlay.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const b = ui.overlay.getBoundingClientRect();
  [drag.x1, drag.y1] = stageToFrame(e.clientX - b.left, e.clientY - b.top, b.width, b.height, ui.video.videoWidth, ui.video.videoHeight);
  drawOverlay();
});
ui.overlay.addEventListener("pointerup", () => {
  if (!drag) return;
  const r: Rect | null = dragToRect(drag.x0, drag.y0, drag.x1, drag.y1);
  drag = null;
  if (r) {
    slots.push({ id: crypto.randomUUID(), name: `ช่อง ${slots.length + 1}`, rect: r });
    saveSlots();
    renderSlots();
    updateControls();
  }
  drawOverlay();
});

ui.clearBtn.addEventListener("click", () => { slots = []; tracks = new Map(); saveSlots(); renderSlots(); drawOverlay(); updateControls(); });

// ---------------------------------------------------------------- auto slots

/**
 * One pass on the current frame (shelf should be full): both models on the whole frame, then every box the
 * 110-class model could not name is cropped and run again, because that model only recognises a product that
 * fills most of the picture. Same-name neighbours become one slot (autoSlots). Replaces the current slots.
 */
async function findSlots() {
  if (!agent || running || finding || !hasFrame()) return;
  if (slots.length && !confirm(`แทนที่ ${slots.length} ช่องเดิมด้วยช่องที่หาอัตโนมัติ?`)) return;
  finding = true;
  updateControls();
  renderSlots();
  const frame = await createImageBitmap(ui.video);
  try {
    setStatus("กำลังหาสินค้าในภาพ…");
    const conf = Number(ui.conf.value);
    const classes = agent.manifest.model.classes;
    const r = await agent.detect(frame, { conf }); // no shelfOnly: names from the 110-class model + "product" boxes of the shelf model
    const items = toFoundItems(r.boxes, classes, r.width, r.height);
    const unnamed = items.filter((i) => i.name === null).slice(0, MAX_NAME_CROPS);
    for (const [k, it] of unnamed.entries()) {
      setStatus(`กำลังระบุชื่อสินค้า ${k + 1} / ${unnamed.length}…`);
      const crop = await createImageBitmap(frame, ...cropRect(it.xyxy, r.width, r.height));
      try {
        const c = await agent.detect(crop, { conf: Math.max(conf, NAME_CONF) });
        it.name = cropLabel(c.boxes, classes, c.width, c.height);
      } finally {
        crop.close();
      }
    }
    // The shelf is full now, so a slot the watch loop would already call empty (a stray box in the
    // background, a product cut by the frame edge) would only raise a false alarm: drop it.
    const found = [];
    const candidates = autoSlots(items, r.width, r.height);
    for (const [k, f] of candidates.entries()) {
      setStatus(`กำลังตรวจช่อง ${k + 1} / ${candidates.length}…`);
      const crop = await cropSlot(frame, f.rect);
      try {
        const c = await agent.detect(crop, { conf, shelfOnly: true });
        if (slotHasProduct(c.boxes, c.width, c.height)) found.push(f);
      } finally {
        crop.close();
      }
    }
    if (!found.length) { setStatus("ไม่เจอสินค้าในภาพ ลองตอนชั้นเต็ม ลดความมั่นใจขั้นต่ำ หรือลากกรอบเอง", true); return; }
    slots = found.map((f) => ({ id: crypto.randomUUID(), ...f }));
    tracks = new Map();
    saveSlots();
    const named = items.filter((i) => i.name !== null).length;
    const dropped = candidates.length - found.length;
    setStatus(`เจอ ${found.length} ช่อง จากสินค้า ${items.length} ชิ้น (รู้ชื่อ ${named} ชิ้น)${dropped ? ` · ตัด ${dropped} ช่องที่ตอนนี้ก็ดูว่างอยู่แล้ว` : ""} · ตรวจกรอบ แก้ชื่อ ลบ หรือลากเพิ่มได้ แล้วกดเริ่มเฝ้า`);
  } catch (e) {
    setStatus(`หาช่องไม่สำเร็จ: ${errorMessage(e)}`, true);
  } finally {
    frame.close();
    finding = false;
    renderSlots();
    drawOverlay();
    updateControls();
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

function logEvent(slot: Slot, event: "out" | "restocked") {
  const li = document.createElement("li");
  const when = stream ? new Date().toLocaleTimeString("th-TH") : `วินาทีที่ ${ui.video.currentTime.toFixed(0)}`;
  li.textContent = `${when} · ${slot.name} ${event === "out" ? "ของหมด" : "เติมของแล้ว"}`;
  li.dataset.event = event;
  if (event === "out") li.className = "bad";
  ui.log.querySelector(".placeholder")?.remove();
  ui.log.prepend(li);
  if (event === "out") {
    beep();
    if ("Notification" in window && Notification.permission === "granted") new Notification("ของหมดบนชั้นวาง", { body: slot.name });
  }
}

ui.notifyBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) { setStatus("browser นี้ไม่รองรับการแจ้งเตือน", true); return; }
  const p = await Notification.requestPermission();
  ui.notifyBtn.textContent = p === "granted" ? "เปิดแจ้งเตือนแล้ว" : "ยังไม่ได้รับอนุญาต";
  ui.notifyBtn.disabled = p === "granted";
});

// ---------------------------------------------------------------- watch loop

/** The part of a frame (video or a still of it) inside a slot. */
function cropSlot(src: HTMLVideoElement | ImageBitmap, [x, y, w, h]: Rect): Promise<ImageBitmap> {
  const W = src instanceof HTMLVideoElement ? src.videoWidth : src.width, H = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
  return createImageBitmap(src, Math.round(x * W), Math.round(y * H), Math.max(1, Math.round(w * W)), Math.max(1, Math.round(h * H)));
}

async function checkSlot(s: Slot, conf: number, cfg: { holdMs: number; clearMs: number }): Promise<number> {
  const crop = await cropSlot(ui.video, s.rect);
  try {
    thumbCtx.drawImage(crop, 0, 0, THUMB, THUMB);
    const gray = toGray(thumbCtx.getImageData(0, 0, THUMB, THUMB).data);
    const prev = thumbs.get(s.id);
    thumbs.set(s.id, gray);
    const r = await agent!.detect(crop, { conf, shelfOnly: true }); // only "is there a box" matters here: skip the 110-class model
    const has = slotHasProduct(r.boxes, r.width, r.height);
    const { track, event } = stepTrack(tracks.get(s.id) ?? newTrack(), has, prev !== undefined && motionScore(prev, gray) > MOTION_BLOCKED, now(), cfg);
    tracks.set(s.id, track);
    if (event) logEvent(s, event);
    return r.latency_ms;
  } finally {
    crop.close();
  }
}

async function loop() {
  while (running) {
    if (ui.video.ended) { stop("วิดีโอจบแล้ว"); break; }
    const t0 = performance.now();
    const cfg = { holdMs: Number(ui.hold.value) * 1000, clearMs: CLEAR_MS };
    const conf = Number(ui.conf.value);
    try {
      let total = 0;
      for (const s of slots) total += await checkSlot(s, conf, cfg);
      ui.latency.textContent = total.toFixed(0);
    } catch (e) {
      stop(`ตรวจไม่สำเร็จ: ${errorMessage(e)}`, true);
      break;
    }
    renderSlots();
    drawOverlay();
    await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - (performance.now() - t0))));
  }
}

function start() {
  tracks = new Map();
  thumbs = new Map();
  ui.log.replaceChildren(Object.assign(document.createElement("li"), { className: "muted placeholder", textContent: "ยังไม่มีการแจ้งเตือน" }));
  running = true;
  audio?.resume();
  renderSlots();
  updateControls();
  setStatus("กำลังเฝ้าชั้นวาง · เปิดแท็บนี้ค้างไว้");
  if (ui.video.paused) void ui.video.play();
  void loop();
}

function stop(message = "หยุดเฝ้าแล้ว", bad = false) {
  running = false;
  renderSlots();
  updateControls();
  setStatus(message, bad);
}

ui.startBtn.addEventListener("click", () => (running ? stop() : start()));

// ---------------------------------------------------------------- sources

function closeSource() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (fileUrl) URL.revokeObjectURL(fileUrl);
  fileUrl = null;
  ui.video.removeAttribute("src");
  ui.video.srcObject = null;
}

async function showSource() {
  await new Promise<void>((res) => (ui.video.readyState >= 1 ? res() : ui.video.addEventListener("loadedmetadata", () => res(), { once: true })));
  await ui.video.play();
  ui.video.hidden = ui.overlay.hidden = false;
  ui.empty.hidden = true;
  drawOverlay();
  updateControls();
  setStatus("กดหาช่องอัตโนมัติตอนชั้นเต็ม หรือลากกรอบรอบสินค้าแต่ละชนิด แล้วกดเริ่มเฝ้า");
}

ui.camBtn.addEventListener("click", async () => {
  if (finding) return;
  if (running) stop();
  if (!navigator.mediaDevices?.getUserMedia) { setStatus("browser นี้ใช้กล้องไม่ได้ (ต้องเปิดผ่าน https)", true); return; }
  closeSource();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } }, audio: false });
  } catch (e) {
    setStatus(`เปิดกล้องไม่ได้: ${(e as Error).name === "NotAllowedError" ? "ไม่ได้รับอนุญาตให้ใช้กล้อง" : (e as Error).message}`, true);
    return;
  }
  ui.video.srcObject = stream;
  await showSource();
});

ui.fileBtn.addEventListener("click", () => ui.file.click());
ui.file.addEventListener("change", async () => {
  const f = ui.file.files?.[0];
  ui.file.value = "";
  if (!f || finding) return;
  if (running) stop();
  closeSource();
  fileUrl = URL.createObjectURL(f);
  ui.video.src = fileUrl;
  await showSource();
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
  renderSlots();
  ui.pill.textContent = `agent ${SHELF_AGENT_VERSION}`;
  ui.progress.hidden = SHELF_AGENT_VERSION === "mock";
  setStatus("กำลังโหลด model สำหรับเฝ้าชั้นวาง…");
  try {
    agent = await loadAgent(ui.backend.value as Backend, (loaded, total) => {
      if (total) { ui.progress.max = total; ui.progress.value = loaded; }
      setStatus(`กำลังโหลด model ${formatMB(loaded)}${total ? ` / ${formatMB(total)}` : ""} MB`);
    }, SHELF_AGENT_VERSION);
    ui.pill.textContent = `agent ${agent.manifest.version} · ${agent.backend === "webgpu" ? "WebGPU" : "WASM"}`;
    ui.camBtn.disabled = ui.fileBtn.disabled = false;
    setStatus("พร้อมใช้ · เปิดกล้องหรือเลือกวิดีโอ");
    updateControls();
  } catch (e) {
    opened = false;
    setStatus(`โหลด agent ไม่ได้: ${errorMessage(e)}`, true);
  } finally {
    ui.progress.hidden = true;
  }
}
