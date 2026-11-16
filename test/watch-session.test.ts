// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const fake = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock('../src/agent', () => ({ SHELF_AGENT_VERSION: 'mock', loadAgent: async () => ({ manifest: { model: { classes: 110 } }, backend: 'wasm', detect: fake.detect }) }));
vi.mock('../src/flow', () => ({ FlowView: class {
  ready() {} round() {} send() {} reply() {} fail() {} decide() {} idle() {} reset() {} roundDone() {}
} }));

let video: HTMLVideoElement;
let paused = true;
const click = (id: string) => document.getElementById(id)!.click();
const tick = async (ms = 50) => { await vi.advanceTimersByTimeAsync(ms); };

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  document.body.innerHTML = readFileSync('index.html', 'utf8').split('<body>')[1].split('</body>')[0].replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.clear();
  localStorage.setItem('watchSlots', JSON.stringify([0, 1].map(i => ({ id: String(i), name: `slot${i}`, rect: [i / 2, 0, .5, 1] }))));
  const ctx = { clearRect() {}, fillRect() {}, drawImage() {}, strokeRect() {}, setLineDash() {}, fillText() {}, measureText: () => ({ width: 10 }), getImageData: () => ({ data: new Uint8ClampedArray(4096) }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close() {} }));
  video = document.getElementById('watchVideo') as HTMLVideoElement;
  paused = true;
  Object.defineProperty(video, "srcObject", { writable: true, value: null });
  Object.defineProperties(video, { videoWidth: { value: 100 }, videoHeight: { value: 100 }, paused: { get: () => paused }, ended: { configurable: true, value: false }, duration: { value: 210 } });
  vi.spyOn(video, 'play').mockImplementation(async () => { paused = false; video.dispatchEvent(new Event('play')); });
  vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; video.dispatchEvent(new Event('pause')); });
  (document.getElementById('watchFollow') as HTMLInputElement).checked = false;
  (document.getElementById('watchSound') as HTMLInputElement).checked = false;
  fake.detect.mockReset().mockImplementation(async () => { await new Promise(r => setTimeout(r, 500)); return { boxes: [], width: 100, height: 100, latency_ms: 500 }; });
  const { openWatch } = await import('../src/watch'); await openWatch();
});

afterEach(async () => {
  if (document.getElementById('watchStartBtn')?.textContent === 'หยุดเฝ้า') click('watchStartBtn');
  await tick(3000); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it('defaults to full-frame mode and exposes the actually loaded backend', () => {
  expect((document.getElementById('watchMethod') as HTMLSelectElement).value).toBe('full');
  expect(document.getElementById('watchPill')!.textContent).toContain('WASM');
});

it('does not pause playback for a slow detection and the next round captures the latest media time', async () => {
  let inFlight = 0, peak = 0;
  fake.detect.mockImplementation(async () => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 500));
    inFlight--;
    video.currentTime = 20;
    return { boxes: [], width: 100, height: 100, latency_ms: 500 };
  });
  video.currentTime = 2;
  click('watchStartBtn'); await tick(3200);
  expect(video.paused).toBe(false);
  expect(peak).toBe(1);
  expect(fake.detect.mock.calls.length).toBeGreaterThanOrEqual(6);
  const rows = [...document.querySelectorAll<HTMLElement>('#watchSlots tr')];
  expect(rows.map(r => r.dataset.frameTime)).toEqual(['20000', '20000']);
  expect(new Set(rows.map(r => r.dataset.frameId)).size).toBe(1);
  expect(document.getElementById('watchComparison')!.textContent).toContain('ภาพเต็ม: 2 รอบ');
});

it('keeps result boxes and timestamps tied to one shared snapshot', async () => {
  video.currentTime = 12;
  click('watchStartBtn'); await tick(1550);
  const rows = [...document.querySelectorAll<HTMLElement>('#watchSlots tr')];
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map(r => r.dataset.frameId)).size).toBe(1);
  expect(rows.map(r => r.dataset.frameTime)).toEqual(['12000', '12000']);
  expect(document.getElementById('watchComparison')!.textContent).toContain('ภาพเต็ม: 1 รอบ · 3.0 calls/รอบ'); // one full frame + two fair fallback crops
  expect(document.getElementById('watchFrameInfo')!.textContent).toContain('Snapshot #');
});

it('keeps the legacy crop-every-slot path available for comparison', async () => {
  click('watchStartBtn'); await tick(1550); click('watchStartBtn'); await tick(600);
  const method = document.getElementById('watchMethod') as HTMLSelectElement;
  method.value = 'legacy'; method.dispatchEvent(new Event('change'));
  fake.detect.mockClear();
  video.currentTime = 12;
  click('watchStartBtn'); await tick(1600); click('watchStartBtn');
  expect(fake.detect.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(document.getElementById('watchComparison')!.textContent).toContain('ภาพเต็ม: 1 รอบ');
  expect(document.getElementById('watchComparison')!.textContent).toContain('วิธีเดิม: 1 รอบ · 2.0 calls/รอบ');
});

it('stop pauses the file and discards a late answer without starting another round', async () => {
  click('watchStartBtn'); await tick(50); click('watchStartBtn'); await tick(1600);
  expect(video.paused).toBe(true);
  expect(fake.detect).toHaveBeenCalledTimes(1);
  expect(document.getElementById('watchComparison')!.textContent).toContain('ภาพเต็ม: ยังไม่มีรอบ');
  expect(document.getElementById('watchStartBtn')!.textContent).toBe('เริ่มเฝ้า');
});

it('pause invalidates the current generation and stays paused until the user resumes', async () => {
  click('watchStartBtn'); await tick(50); click('watchPlay'); await tick(1200);
  expect(video.paused).toBe(true);
  expect(fake.detect).toHaveBeenCalledTimes(1);
  expect(document.getElementById('watchPlay')!.textContent).toBe('เล่น');
});

it('seek clears old results and resumes only from the sought media time', async () => {
  click('watchStartBtn'); await tick(50);
  video.dispatchEvent(new Event('seeking')); video.currentTime = 40;
  video.dispatchEvent(new Event('seeked')); await tick(2100);
  expect([...document.querySelectorAll<HTMLElement>('#watchSlots tr')].map(r => r.dataset.frameTime)).toEqual(['40000', '40000']);
  expect(document.getElementById('watchOutCount')!.textContent).toBe('0');
});

it('video ended cancels the in-flight round and does not resume', async () => {
  click('watchStartBtn'); await tick(50);
  Object.defineProperty(video, 'ended', { value: true }); video.dispatchEvent(new Event('ended'));
  await tick(1200);
  expect(video.paused).toBe(true);
  expect(fake.detect).toHaveBeenCalledTimes(1);
  expect(document.getElementById('watchStartBtn')!.textContent).toBe('เริ่มเฝ้า');
});

it('keeps result age on the real clock separate from video distance while paused', async () => {
  fake.detect.mockImplementation(async () => {
    await new Promise(r => setTimeout(r, 20));
    video.currentTime = 5;
    return { boxes: [], width: 100, height: 100, latency_ms: 20 };
  });
  video.currentTime = 2;
  click('watchStartBtn'); await tick(400); // 3 calls, each after one painted frame (up to 50 ms)
  expect(document.getElementById('watchResultDelay')!.textContent).toBe('3.0');
  expect(document.getElementById('watchTimelineGap')!.textContent).toBe('3.0');
  click('watchPlay');
  const before = Number(document.getElementById('watchResultAge')!.textContent);
  await tick(2000);
  const after = Number(document.getElementById('watchResultAge')!.textContent);
  expect(after).toBeGreaterThan(before + 1.5);
  expect(document.getElementById('watchTimelineGap')!.textContent).toBe('3.0');
});

it('applies the selected playback speed without changing the run lifecycle', () => {
  const speed = document.getElementById('watchSpeed') as HTMLSelectElement;
  speed.value = '2'; speed.dispatchEvent(new Event('change'));
  expect(video.playbackRate).toBe(2);
  expect(video.paused).toBe(true);
});

it('changing the file during detection suppresses the old round before discovery on the new source', async () => {
  click('watchStartBtn'); await tick(50);
  Object.defineProperty(video, 'readyState', { value: 2 });
  vi.spyOn(video, 'load').mockImplementation(() => {});
  const input = document.getElementById('watchFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['video'], 'next.mp4', { type: 'video/mp4' })] });
  input.dispatchEvent(new Event('change')); await tick(1200);
  expect(document.getElementById('watchStatus')!.textContent).toContain('ไม่เจอสินค้า');
  expect(document.getElementById('watchStartBtn')!.textContent).toBe('เริ่มเฝ้า');
  expect(video.paused).toBe(true);
  expect(fake.detect).toHaveBeenCalledTimes(2); // old frame settles, then one new-file discovery call
});

it('stamps a playing frame with the media time of the frame on screen, not currentTime', async () => {
  // The model blocks the main thread; a decoder that falls behind leaves the presented frame older than currentTime.
  Object.assign(video, {
    requestVideoFrameCallback: (cb: (now: number, meta: { mediaTime: number }) => void) => setTimeout(() => cb(0, { mediaTime: 1.5 }), 10),
    cancelVideoFrameCallback: () => {},
  });
  video.currentTime = 9;
  click('watchStartBtn'); await tick(400);
  expect(document.getElementById('watchFrameInfo')!.textContent).toContain('คลิป 1.50 s');
  expect(document.getElementById('watchFrameInfo')!.textContent).not.toContain('คลิป 9.00 s');
});
