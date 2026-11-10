// Minimal end-to-end wiring: pick an image -> agent.detect -> draw boxes + JSON.
// Task B replaces this with the real UI (see docs/agent-connection/TASKS.md).
import type { Agent } from "./agent-contract";
import { AGENT_VERSION, loadAgent } from "./agent";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $("status"), out = $("out"), canvas = $<HTMLCanvasElement>("canvas");
let agent: Agent | null = null;

async function init() {
  status.textContent = `กำลังโหลด agent ${AGENT_VERSION}…`;
  try {
    agent = await loadAgent("webgpu", (n, total) => {
      status.textContent = `กำลังโหลด model ${(n / 1e6).toFixed(1)}${total ? ` / ${(total / 1e6).toFixed(1)}` : ""} MB`;
    });
    status.textContent = `agent ${agent.manifest.version} · ${agent.manifest.model.name} · ${agent.backend}`;
  } catch (e) {
    const err = e as Error & { code?: string };
    status.textContent = `โหลด agent ไม่ได้ (${err.code ?? "error"}): ${err.message}`;
  }
}

$<HTMLInputElement>("file").addEventListener("change", async (ev) => {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file || !agent) return;
  const img = await createImageBitmap(file);
  const r = await agent.detect(img);
  canvas.width = r.width;
  canvas.height = r.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  ctx.lineWidth = Math.max(2, r.width / 300);
  ctx.strokeStyle = "#22c55e";
  ctx.font = `${Math.max(12, r.width / 50)}px sans-serif`;
  ctx.fillStyle = "#22c55e";
  for (const b of r.boxes) {
    const [x1, y1, x2, y2] = b.xyxy;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillText(`${b.cls} ${b.conf.toFixed(2)}`, x1 + 2, Math.max(12, y1 - 4));
  }
  out.textContent = JSON.stringify(r, null, 2);
});

init();
