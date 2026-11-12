// Batch detection logic and UI (ตรวจหลายรูปพร้อมกัน + โชว์รูปภาพ + ดาวน์โหลด CSV)
import type { Agent, Box } from "./agent-contract";
import { classColor, type CountRow, countByClass, errorMessage, prettyName, topBox } from "./ui/logic";

export interface BatchRow {
  file: string;
  product: string;
  count: number;
  max_conf: number;
}

export interface BatchItemResult {
  fileName: string;
  counts: CountRow[];
  top: Box | null;
  error?: string;
  boxes?: Box[];
}

/**
 * Escape a CSV field value according to RFC 4180:
 * Fields containing commas, double quotes, or newlines must be enclosed in double quotes.
 * Existing double quotes inside the field are escaped by doubling them ("").
 */
export function escapeCsvField(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generate CSV string from rows.
 * Required columns: file, product, count, max_conf
 */
export function generateCsv(rows: BatchRow[]): string {
  const header = "file,product,count,max_conf";
  const lines = rows.map((r) => {
    const confStr = typeof r.max_conf === "number" ? r.max_conf.toFixed(2) : String(r.max_conf);
    return `${escapeCsvField(r.file)},${escapeCsvField(r.product)},${r.count},${confStr}`;
  });
  return [header, ...lines].join("\r\n");
}

/**
 * Convert batch detection items into CSV rows.
 * Handles multiple products per file and files with zero detections.
 */
export function batchItemsToCsvRows(items: BatchItemResult[]): BatchRow[] {
  const rows: BatchRow[] = [];
  for (const item of items) {
    if (item.error) {
      rows.push({
        file: item.fileName,
        product: `(error: ${item.error})`,
        count: 0,
        max_conf: 0,
      });
    } else if (item.counts.length === 0) {
      rows.push({
        file: item.fileName,
        product: "(none)",
        count: 0,
        max_conf: 0,
      });
    } else {
      for (const c of item.counts) {
        rows.push({
          file: item.fileName,
          product: prettyName(c.cls),
          count: c.count,
          max_conf: Number(c.maxConf.toFixed(2)),
        });
      }
    }
  }
  return rows;
}

/**
 * Format product counts into a readable summary string for the table:
 * e.g. "lays nori: 3, pocky: 2"
 */
export function formatCountsSummary(counts: CountRow[]): string {
  if (!counts || counts.length === 0) return "ไม่พบสินค้า";
  return counts.map((c) => `${prettyName(c.cls)}: ${c.count}`).join(", ");
}

/**
 * Format top-1 product display:
 * e.g. "lays nori (95.0%)" or "–"
 */
export function formatTop1(top: Box | null): string {
  if (!top) return "–";
  return `${prettyName(top.cls)} (${(top.conf * 100).toFixed(1)}%)`;
}

/**
 * Draw image with detected bounding boxes on a canvas.
 * Can be used for both small thumbnails and full-size preview.
 */
export function drawBoxesOnCanvas(
  canvas: HTMLCanvasElement,
  img: ImageBitmap,
  boxes: Box[],
  targetWidth?: number,
  targetHeight?: number
) {
  const w = targetWidth ?? img.width;
  const h = targetHeight ?? img.height;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const scaleX = w / img.width;
  const scaleY = h / img.height;

  ctx.drawImage(img, 0, 0, w, h);

  const isThumb = w <= 100;
  const lw = isThumb ? 1.5 : Math.max(2, Math.round(w / 320));
  const fs = Math.max(11, Math.round(w / 40));
  ctx.lineWidth = lw;
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textBaseline = "top";

  for (const b of [...boxes].reverse()) {
    const [x1, y1, x2, y2] = b.xyxy;
    const color = classColor(b.classId);
    ctx.strokeStyle = color;
    const bx = x1 * scaleX;
    const by = y1 * scaleY;
    const bw = (x2 - x1) * scaleX;
    const bh = (y2 - y1) * scaleY;
    ctx.strokeRect(bx, by, bw, bh);

    if (!isThumb) {
      const label = `${prettyName(b.cls)} ${b.conf.toFixed(2)}`;
      const tw = ctx.measureText(label).width + 8;
      const th = fs + 6;
      const ty = by - th >= 0 ? by - th : by;
      ctx.fillStyle = color;
      ctx.fillRect(bx - lw / 2, ty, tw, th);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, bx + 4, ty + 3);
    }
  }
}

// ---------------------------------------------------------------- UI Controller

export interface BatchUIElements {
  pickBtn: HTMLButtonElement;
  fileInput: HTMLInputElement;
  downloadCsvBtn: HTMLButtonElement;
  progress: HTMLProgressElement;
  status: HTMLElement;
  tableBody: HTMLElement;
  confInput: HTMLInputElement;
}

export class BatchController {
  private results: BatchItemResult[] = [];
  private isProcessing = false;
  private previewDialog: HTMLDialogElement | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewTitle: HTMLElement | null = null;

  constructor(
    private ui: BatchUIElements,
    private getAgent: () => Agent | null
  ) {
    this.init();
  }

  private init() {
    this.previewDialog = document.getElementById("batchPreviewDialog") as HTMLDialogElement | null;
    this.previewCanvas = document.getElementById("batchPreviewCanvas") as HTMLCanvasElement | null;
    this.previewTitle = document.getElementById("batchPreviewTitle");

    const closeBtn = document.getElementById("batchClosePreviewBtn");
    closeBtn?.addEventListener("click", () => this.previewDialog?.close());
    this.previewDialog?.addEventListener("click", (e) => {
      if (e.target === this.previewDialog) this.previewDialog?.close();
    });

    this.ui.pickBtn.addEventListener("click", () => this.ui.fileInput.click());
    this.ui.fileInput.addEventListener("change", () => {
      const files = Array.from(this.ui.fileInput.files ?? []);
      if (files.length > 0) void this.runBatch(files);
      this.ui.fileInput.value = "";
    });

    this.ui.downloadCsvBtn.addEventListener("click", () => this.downloadCsv());
  }

  async runBatch(files: File[]) {
    const agent = this.getAgent();
    if (!agent) {
      this.ui.status.textContent = "กำลังโหลด agent กรุณารอสักครู่แล้วลองใหม่…";
      this.ui.status.classList.add("bad");
      return;
    }

    const imageFiles = files.filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|bmp|gif)$/i.test(f.name));
    if (imageFiles.length === 0) {
      this.ui.status.textContent = "ไม่พบไฟล์รูปภาพที่เลือก";
      this.ui.status.classList.add("bad");
      return;
    }

    this.isProcessing = true;
    this.ui.pickBtn.disabled = true;
    this.ui.downloadCsvBtn.disabled = true;
    this.results = [];
    this.ui.status.classList.remove("bad");

    const total = imageFiles.length;
    this.ui.progress.hidden = false;
    this.ui.progress.max = total;
    this.ui.progress.value = 0;

    // Reset table with placeholder rows showing thumbnail images
    this.ui.tableBody.replaceChildren(
      ...imageFiles.map((f, idx) => {
        const tr = document.createElement("tr");
        tr.id = `batch-row-${idx}`;
        const objUrl = URL.createObjectURL(f);
        tr.innerHTML = `
          <td class="thumb-cell">
            <img class="batch-thumb" src="${objUrl}" alt="${escapeHtml(f.name)}" title="คลิกเพื่อดูรูปภาพ">
          </td>
          <td>${escapeHtml(f.name)}</td>
          <td class="muted">รอตรวจ…</td>
          <td class="muted">–</td>
        `;

        const img = tr.querySelector("img");
        img?.addEventListener("click", () => void this.showPreview(f.name, f, []));
        return tr;
      })
    );

    const conf = Number(this.ui.confInput.value) || 0.25;

    for (let i = 0; i < total; i++) {
      const file = imageFiles[i];
      this.ui.status.textContent = `กำลังตรวจรูปที่ ${i + 1} จาก ${total}: ${file.name}…`;
      this.ui.progress.value = i;

      const row = document.getElementById(`batch-row-${i}`) as HTMLTableRowElement | null;
      if (row) {
        row.scrollIntoView({ block: "nearest" });
        row.cells[2].innerHTML = '<span class="muted">กำลังตรวจ…</span>';
      }

      let bitmap: ImageBitmap | null = null;
      try {
        bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
        const res = await agent.detect(bitmap, { conf });
        const counts = countByClass(res.boxes);
        const top = topBox(res.boxes);

        const itemResult: BatchItemResult = {
          fileName: file.name,
          counts,
          top,
          boxes: res.boxes,
        };
        this.results.push(itemResult);

        if (row) {
          // Replace thumbnail with rendered canvas showing bounding boxes
          const thumbCanvas = document.createElement("canvas");
          thumbCanvas.className = "batch-thumb";
          thumbCanvas.title = "คลิกเพื่อดูรูปขยายพร้อมกรอบสินค้า";
          drawBoxesOnCanvas(thumbCanvas, bitmap, res.boxes, 56, 56);
          thumbCanvas.addEventListener("click", () => void this.showPreview(file.name, file, res.boxes));
          row.cells[0].replaceChildren(thumbCanvas);

          row.cells[2].textContent = formatTop1(top);
          row.cells[3].textContent = formatCountsSummary(counts);
        }
      } catch (err) {
        const msg = errorMessage(err);
        this.results.push({
          fileName: file.name,
          counts: [],
          top: null,
          error: msg,
        });
        if (row) {
          row.cells[2].innerHTML = `<span class="bad">ข้อผิดพลาด</span>`;
          row.cells[3].innerHTML = `<span class="bad">${escapeHtml(msg)}</span>`;
        }
      } finally {
        bitmap?.close();
        this.ui.progress.value = i + 1;
      }
    }

    this.isProcessing = false;
    this.ui.pickBtn.disabled = false;
    this.ui.progress.hidden = true;
    this.ui.status.textContent = `ตรวจเสร็จสิ้นทั้งหมด ${total} รูป`;

    if (this.results.length > 0) {
      this.ui.downloadCsvBtn.disabled = false;
    }
  }

  async showPreview(title: string, file: File, boxes: Box[] = []) {
    if (!this.previewDialog || !this.previewCanvas) return;
    if (this.previewTitle) this.previewTitle.textContent = title;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      drawBoxesOnCanvas(this.previewCanvas, bitmap, boxes);
      bitmap.close();
      this.previewDialog.showModal();
    } catch {
      // Fallback
    }
  }

  downloadCsv() {
    if (this.results.length === 0) return;
    const rows = batchItemsToCsvRows(this.results);
    const csvContent = generateCsv(rows);
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" }); // BOM for Excel Thai language support
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `retail-shelf-batch-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Initialize batch controller with elements from the DOM. */
export function initBatch(getAgent: () => Agent | null, confInput: HTMLInputElement) {
  const pickBtn = document.getElementById("batchPickBtn") as HTMLButtonElement | null;
  const fileInput = document.getElementById("batchFile") as HTMLInputElement | null;
  const downloadCsvBtn = document.getElementById("batchDownloadCsvBtn") as HTMLButtonElement | null;
  const progress = document.getElementById("batchProgress") as HTMLProgressElement | null;
  const status = document.getElementById("batchStatus");
  const tableBody = document.getElementById("batchTableBody");

  if (!pickBtn || !fileInput || !downloadCsvBtn || !progress || !status || !tableBody) return;

  const ctrl = new BatchController(
    { pickBtn, fileInput, downloadCsvBtn, progress, status, tableBody, confInput },
    getAgent
  );

  const multiPickBtn = document.getElementById("multiPickBtn");
  multiPickBtn?.addEventListener("click", () => {
    location.hash = "#batch";
    fileInput.click();
  });

  return ctrl;
}
