// Detection page (task B). Talks to the agent only through loadAgent() / the Agent interface.
import type { Agent, Backend, DetectResult } from "./agent-contract";
import { AGENT_VERSION, loadAgent } from "./agent";
import { classColor, countByClass, errorMessage, formatMB, prettyName, topBox } from "./ui/logic";

// Test-split images of the dataset (CC BY 4.0, see About). public/samples/
const SAMPLES = ["lays.jpg", "hanami.jpg", "pocky.jpg", "copp.jpg"];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  backend: $<HTMLSelectElement>("backend"), agentPill: $("agentPill"), backendPill: $("backendPill"),
  progress: $<HTMLProgressElement>("progress"), status: $("status"),
  drop: $("drop"), file: $<HTMLInputElement>("file"), sampleBtn: $<HTMLButtonElement>("sampleBtn"), samples: $("samples"),
  cameraBtn: $<HTMLButtonElement>("cameraBtn"), snapBtn: $<HTMLButtonElement>("snapBtn"), closeCamBtn: $<HTMLButtonElement>("closeCamBtn"),
  canvas: $<HTMLCanvasElement>("canvas"), video: $<HTMLVideoElement>("video"), empty: $("empty"),
  conf: $<HTMLInputElement>("conf"), confVal: $("confVal"),
  statTotal: $("statTotal"), statLatency: $("statLatency"), statBackend: $("statBackend"), topLine: $("topLine"),
  counts: $("counts"), json: $("json"), aboutAgent: $("aboutAgent"), footerVersion: $("footerVersion"),
};

let agent: Agent | null = null;
let image: ImageBitmap | null = null; // the picture currently shown (re-detected when conf changes)
let stream: MediaStream | null = null;
let busy = false;

function setStatus(text: string, bad = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("bad", bad);
}

function setReady(ready: boolean) {
  for (const el of [ui.sampleBtn, ui.cameraBtn, ui.conf]) el.disabled = !ready;
  ui.drop.setAttribute("aria-disabled", String(!ready));
  ui.drop.style.pointerEvents = ready ? "" : "none";
  ui.drop.style.opacity = ready ? "" : "0.5";
}

// ---------------------------------------------------------------- agent

async function initAgent(backend: Backend) {
  setReady(false);
  ui.backend.disabled = true;
  if (agent) { await agent.dispose(); agent = null; }
  ui.agentPill.textContent = `agent ${AGENT_VERSION}`;
  ui.backendPill.hidden = true;
  ui.progress.hidden = AGENT_VERSION === "mock";
  ui.progress.removeAttribute("value"); // indeterminate until the first byte arrives
  setStatus(`กำลังโหลด agent ${AGENT_VERSION}…`);
  try {
    agent = await loadAgent(backend, (loaded, total) => {
      if (total) { ui.progress.max = total; ui.progress.value = loaded; }
      setStatus(`กำลังโหลด model ${formatMB(loaded)}${total ? ` / ${formatMB(total)}` : ""} MB`);
    });
    const m = agent.manifest;
    ui.backendPill.textContent = agent.backend === "webgpu" ? "WebGPU" : "WASM";
    ui.backendPill.hidden = false;
    const fellBack = backend === "webgpu" && agent.backend !== "webgpu";
    setStatus(`พร้อมใช้ · ${m.model.name} (${m.model.classes} คลาส, ${m.model.dataset})${fellBack ? " · เครื่องนี้ไม่มี WebGPU จึงใช้ WASM แทน" : ""}`);
    ui.aboutAgent.textContent = `agent ${m.version} · model ${m.model.name} · ${m.model.classes} คลาส · backend ${agent.backend}`;
    ui.footerVersion.textContent = `agent ${m.version}`;
    setReady(true);
    if (image) await run();
  } catch (e) {
    setStatus(`โหลด agent ไม่ได้: ${errorMessage(e)}`, true);
  } finally {
    ui.progress.hidden = true;
    ui.backend.disabled = false;
  }
}

// ---------------------------------------------------------------- detect + draw

async function show(bitmap: ImageBitmap) {
  image?.close();
  image = bitmap;
  await run();
}

async function run() {
  if (!agent || !image || busy) return;
  busy = true;
  try {
    const r = await agent.detect(image, { conf: Number(ui.conf.value) });
    draw(image, r);
    render(r);
  } catch (e) {
    setStatus(`ตรวจไม่สำเร็จ: ${errorMessage(e)}`, true);
  } finally {
    busy = false;
  }
}

function draw(img: ImageBitmap, r: DetectResult) {
  const c = ui.canvas;
  c.width = r.width;
  c.height = r.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const lw = Math.max(2, Math.round(r.width / 320));
  const fs = Math.max(12, Math.round(r.width / 40));
  ctx.lineWidth = lw;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  for (const b of [...r.boxes].reverse()) { // most confident drawn last = on top
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
  c.hidden = false;
  ui.video.hidden = true;
  ui.empty.hidden = true;
}

function render(r: DetectResult) {
  ui.statTotal.textContent = String(r.boxes.length);
  ui.statLatency.textContent = r.latency_ms.toFixed(0);
  ui.statBackend.textContent = r.backend === "webgpu" ? "WebGPU" : "WASM";
  const top = topBox(r.boxes);
  ui.topLine.textContent = top ? `มั่นใจที่สุด: ${prettyName(top.cls)} (${(top.conf * 100).toFixed(1)}%)` : "ไม่เจอสินค้าที่มั่นใจเกินค่าที่ตั้งไว้";
  const rows = countByClass(r.boxes);
  ui.counts.replaceChildren(...(rows.length ? rows.map((row) => {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = classColor(row.classId);
    name.append(sw, prettyName(row.cls));
    const n = document.createElement("td"); n.className = "num"; n.textContent = String(row.count);
    const c = document.createElement("td"); c.className = "num"; c.textContent = row.maxConf.toFixed(2);
    tr.append(name, n, c);
    return tr;
  }) : [Object.assign(document.createElement("tr"), { innerHTML: '<td colspan="3" class="muted">ไม่เจอสินค้า</td>' })]));
  ui.json.textContent = JSON.stringify(r, null, 2);
}

// ---------------------------------------------------------------- inputs

async function fromFile(file: File | undefined) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { setStatus("ไฟล์นี้ไม่ใช่รูป", true); return; }
  try {
    await show(await createImageBitmap(file, { imageOrientation: "from-image" }));
  } catch (e) {
    setStatus(`เปิดรูปไม่ได้: ${errorMessage(e)}`, true);
  }
}

async function fromUrl(url: string) {
  const res = await fetch(url);
  await show(await createImageBitmap(await res.blob()));
}

ui.drop.addEventListener("click", () => ui.file.click());
ui.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ui.file.click(); } });
ui.file.addEventListener("change", () => { void fromFile(ui.file.files?.[0]); ui.file.value = ""; });
for (const ev of ["dragenter", "dragover"]) ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) ui.drop.addEventListener(ev, () => ui.drop.classList.remove("over"));
ui.drop.addEventListener("drop", (e) => { e.preventDefault(); void fromFile(e.dataTransfer?.files?.[0]); });
document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
  if (item && agent) void fromFile(item.getAsFile() ?? undefined);
});

const sampleUrl = (f: string) => `${import.meta.env.BASE_URL}samples/${f}`;
ui.samples.replaceChildren(...SAMPLES.map((f) => {
  const b = document.createElement("button");
  b.type = "button";
  b.title = f;
  b.innerHTML = `<img alt="รูปตัวอย่าง ${f}" loading="lazy">`;
  (b.firstChild as HTMLImageElement).src = sampleUrl(f);
  b.addEventListener("click", () => { if (agent) void fromUrl(sampleUrl(f)); });
  return b;
}));
ui.sampleBtn.addEventListener("click", () => {
  ui.samples.hidden = false;
  void fromUrl(sampleUrl(SAMPLES[Math.floor(Math.random() * SAMPLES.length)]));
});

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { setStatus("browser นี้ใช้กล้องไม่ได้ (ต้องเปิดผ่าน https)", true); return; }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 } }, audio: false });
  } catch (e) {
    setStatus(`เปิดกล้องไม่ได้: ${(e as Error).name === "NotAllowedError" ? "ไม่ได้รับอนุญาตให้ใช้กล้อง" : (e as Error).message}`, true);
    return;
  }
  ui.video.srcObject = stream;
  await ui.video.play();
  ui.video.hidden = false;
  ui.canvas.hidden = true;
  ui.empty.hidden = true;
  ui.snapBtn.hidden = ui.closeCamBtn.hidden = false;
  ui.cameraBtn.hidden = true;
}

function closeCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  ui.video.srcObject = null;
  ui.video.hidden = true;
  ui.snapBtn.hidden = ui.closeCamBtn.hidden = true;
  ui.cameraBtn.hidden = false;
  if (ui.canvas.hidden) ui.empty.hidden = false;
}

ui.cameraBtn.addEventListener("click", () => void openCamera());
ui.closeCamBtn.addEventListener("click", closeCamera);
ui.snapBtn.addEventListener("click", async () => {
  if (!ui.video.videoWidth) return;
  const frame = await createImageBitmap(ui.video);
  closeCamera();
  await show(frame);
});

let confTimer = 0;
ui.conf.addEventListener("input", () => {
  ui.confVal.textContent = Number(ui.conf.value).toFixed(2);
  clearTimeout(confTimer);
  confTimer = window.setTimeout(() => void run(), 120);
});

ui.backend.addEventListener("change", () => {
  try { localStorage.setItem("backend", ui.backend.value); } catch { /* private mode */ }
  void initAgent(ui.backend.value as Backend);
});

// ---------------------------------------------------------------- bench (A5)

const benchBtn = $<HTMLButtonElement>("benchBtn");
benchBtn.disabled = false;
benchBtn.addEventListener("click", async () => {
  benchBtn.disabled = true;
  const body = $("bench");
  body.innerHTML = '<tr><td colspan="5" class="muted">กำลังวัด…</td></tr>';
  $("benchUa").textContent = navigator.userAgent;
  const imgs = await Promise.all(SAMPLES.map(async (f) => createImageBitmap(await (await fetch(sampleUrl(f))).blob())));
  const rows: string[] = [];
  for (const want of ["webgpu", "wasm"] as Backend[]) {
    try {
      const t0 = performance.now();
      const a = await loadAgent(want);
      const loadMs = performance.now() - t0;
      if (a.backend !== want) {
        rows.push(`<tr><td>${want}</td><td colspan="4" class="muted">เครื่องนี้ไม่มี (ใช้ ${a.backend} แทน)</td></tr>`);
        await a.dispose();
        continue;
      }
      await a.detect(imgs[0]); // warm-up (shader compile / first-run allocation)
      const ms: number[] = [];
      for (let i = 0; i < 20; i++) ms.push((await a.detect(imgs[i % imgs.length])).latency_ms);
      await a.dispose();
      ms.sort((x, y) => x - y);
      const avg = ms.reduce((s, v) => s + v, 0) / ms.length;
      rows.push(`<tr><td>${want === "webgpu" ? "WebGPU" : "WASM"}</td><td class="num">${avg.toFixed(1)}</td><td class="num">${ms[10].toFixed(1)}</td><td class="num">${ms[17].toFixed(1)}</td><td class="num">${loadMs.toFixed(0)}</td></tr>`);
    } catch (e) {
      rows.push(`<tr><td>${want}</td><td colspan="4" class="bad">${errorMessage(e)}</td></tr>`);
    }
    body.innerHTML = rows.join("");
  }
  imgs.forEach((i) => i.close());
  benchBtn.disabled = false;
});

// ---------------------------------------------------------------- pages (#detect / #about)

function route() {
  const about = location.hash === "#about";
  $("pageDetect").hidden = about;
  $("pageAbout").hidden = !about;
  $("navDetect").toggleAttribute("aria-current", !about);
  $("navAbout").toggleAttribute("aria-current", about);
  if (about) $("navAbout").setAttribute("aria-current", "page"); else $("navDetect").setAttribute("aria-current", "page");
}
window.addEventListener("hashchange", route);
route();

let saved: string | null = null;
try { saved = localStorage.getItem("backend"); } catch { /* private mode */ }
if (saved === "wasm" || saved === "webgpu") ui.backend.value = saved;
void initAgent(ui.backend.value as Backend);
