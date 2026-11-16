// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const fake = vi.hoisted(() => ({ detect: vi.fn(), slow: false }));
vi.mock('../src/agent', () => ({ SHELF_AGENT_VERSION: 'mock', loadAgent: async () => ({ manifest: { model: { classes: 110 } }, backend: 'wasm', detect: fake.detect }) }));
vi.mock('../src/flow', () => ({ FlowView: class {
  get slow() { return fake.slow; }
  ready() {} round() {} send() {} reply() {} fail() {} decide() {} idle() {} reset() {} roundDone() {}
  async nextPaint() {} async hold() { if (fake.slow) await new Promise(r => setTimeout(r, 1100)); }
} }));
let video: HTMLVideoElement;
let paused = true;
const click = (id: string) => document.getElementById(id)!.click();
const tick = async (ms = 50) => { await vi.advanceTimersByTimeAsync(ms); };
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); fake.slow = false;
  document.body.innerHTML = readFileSync('index.html', 'utf8').split('<body>')[1].split('</body>')[0].replace(/<script[\s\S]*?<\/script>/g, '');
  localStorage.clear();
  localStorage.setItem('watchSlots', JSON.stringify([0, 1].map(i => ({ id: String(i), name: `slot${i}`, rect: [i / 2, 0, .5, 1] }))));
  const ctx = { clearRect() {}, fillRect() {}, drawImage() {}, strokeRect() {}, setLineDash() {}, fillText() {}, measureText: () => ({ width: 10 }), getImageData: () => ({ data: new Uint8ClampedArray(4096) }) };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.stubGlobal('createImageBitmap', async () => ({ width: 100, height: 100, close() {} }));
  video = document.getElementById('watchVideo') as HTMLVideoElement;
  paused = true;
  Object.defineProperty(video, "srcObject", { writable: true, value: null });
  Object.defineProperties(video, { videoWidth: { value: 100 }, videoHeight: { value: 100 }, paused: { get: () => paused }, ended: { configurable: true, value: false }, duration: { value: 60 } });
  vi.spyOn(video, 'play').mockImplementation(async () => { paused = false; video.dispatchEvent(new Event('play')); });
  vi.spyOn(video, 'pause').mockImplementation(() => { paused = true; video.dispatchEvent(new Event('pause')); });
  (document.getElementById('watchFollow') as HTMLInputElement).checked = false;
  (document.getElementById('watchSound') as HTMLInputElement).checked = false;
  fake.detect.mockReset().mockImplementation(async () => { await new Promise(r => setTimeout(r, 500)); return { boxes: [], width: 100, height: 100, latency_ms: 500 }; });
  const { openWatch } = await import('../src/watch'); await openWatch();
});
afterEach(async () => { if (document.getElementById('watchStartBtn')!.textContent === 'หยุดเฝ้า') click('watchStartBtn'); await tick(3000); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('stop pauses the file and suppresses a late answer', async () => {
  click('watchStartBtn'); await tick(); click('watchStartBtn'); await tick(700);
  expect(video.paused).toBe(true);
  expect(document.getElementById('watchSlots')!.textContent).not.toContain('กำลังยืนยัน');
});
it('uses the capture timestamp for every slot despite slow responses', async () => {
  video.currentTime = 2; click('watchStartBtn'); await tick(); video.currentTime = 20; await tick(1100);
  const rows = [...document.querySelectorAll('#watchSlots tr')];
  expect(rows.map(r => (r as HTMLElement).dataset.frameTime)).toEqual(['2000', '2000']);
});

it('holds a presentation frame through every slot and resumes only after the summary', async () => {
  fake.slow = true; video.currentTime = 2;
  click('watchStartBtn'); await tick(600);
  expect(video.paused).toBe(true);
  await tick(1800); expect(video.paused).toBe(true);
  await tick(2100); expect(video.paused).toBe(false);
  expect([...document.querySelectorAll<HTMLElement>('#watchSlots tr')].map(r => r.dataset.frameTime)).toEqual(['2000', '2000']);
  expect(document.getElementById('watchOutCount')!.textContent).toBe('0');
});
it.each(['watchPlay', 'watchStartBtn'])('never resumes after %s during a presentation', async id => {
  fake.slow = true; click('watchStartBtn'); await tick(700); click(id); await tick(5000);
  expect(video.paused).toBe(true);
  expect(fake.detect).toHaveBeenCalledTimes(1);
});
it('rapid stop/start and pause/resume keep at most one detect in flight', async () => {
  let inFlight = 0, peak = 0;
  fake.detect.mockImplementation(async () => {
    peak = Math.max(peak, ++inFlight); await new Promise(r => setTimeout(r, 500)); inFlight--;
    return { boxes: [], width: 100, height: 100, latency_ms: 500 };
  });
  click('watchStartBtn'); await tick(50); click('watchStartBtn'); click('watchStartBtn');
  await tick(50); click('watchPlay'); click('watchPlay'); await tick(2100);
  expect(peak).toBe(1); expect(fake.detect.mock.calls.length).toBeGreaterThan(1);
});
it('seek invalidates the old round and timers but preserves slot coordinates', async () => {
  click('watchStartBtn'); await tick(600);
  video.dispatchEvent(new Event('seeking')); video.currentTime = 40;
  video.dispatchEvent(new Event('seeked')); await tick(1600);
  expect(document.querySelectorAll('#watchSlots tr').length).toBe(2);
  expect([...document.querySelectorAll<HTMLElement>('#watchSlots tr')].map(r => r.dataset.frameTime)).toEqual(['40000', '40000']);
  expect(document.getElementById('watchOutCount')!.textContent).toBe('0');
});
it('ending a video cancels an in-flight answer and does not resume', async () => {
  fake.slow = true; click('watchStartBtn'); await tick(50);
  Object.defineProperty(video, 'ended', { value: true }); video.dispatchEvent(new Event('ended'));
  await tick(5000); expect(video.paused).toBe(true);
  expect(fake.detect).toHaveBeenCalledTimes(1);
  expect(document.getElementById('watchStartBtn')!.textContent).toBe('เริ่มเฝ้า');
});
it('changing presentation mode during a round takes effect safely on subsequent steps/rounds', async () => {
  click('watchStartBtn'); await tick(50); fake.slow = true; await tick(1000);
  expect(video.paused).toBe(false); // this frame was captured in continuous mode
  await tick(1100); expect(video.paused).toBe(true);
  fake.slow = false; await tick(3500); expect(video.paused).toBe(false);
});
it('separates detect time from presentation and waiting time', async () => {
  fake.slow = true; click('watchStartBtn'); await tick(5500);
  expect(Number(document.getElementById('watchLatency')!.textContent)).toBe(1000);
  expect(Number(document.getElementById('watchRoundLatency')!.textContent)).toBeGreaterThanOrEqual(5300);
});
it('camera keeps playing in presentation mode and uses monotonic capture time', async () => {
  fake.slow = true;
  Object.defineProperty(video, 'readyState', { value: 2 });
  const stop = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  click('watchCamBtn'); await tick();
  // Draw a slot through the real pointer handlers after switching sources.
  const overlay = document.getElementById('watchOverlay')!;
  vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
  overlay.setPointerCapture = vi.fn();
  overlay.dispatchEvent(new PointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
  overlay.dispatchEvent(new PointerEvent('pointermove', { clientX: 80, clientY: 80 }));
  overlay.dispatchEvent(new PointerEvent('pointerup'));
  vi.mocked(video.pause).mockClear(); video.currentTime = 999;
  click('watchStartBtn'); await tick(600);
  expect(video.pause).not.toHaveBeenCalled();
  expect(Number(document.querySelector<HTMLElement>('#watchSlots tr')!.dataset.frameTime)).toBeLessThan(999000);
  click('watchStartBtn'); expect(video.pause).not.toHaveBeenCalled();
});
it('changing the file while detecting drops old results and never overlaps auto discovery', async () => {
  click('watchStartBtn'); await tick(50);
  Object.defineProperty(video, 'readyState', { value: 2 });
  vi.spyOn(video, 'load').mockImplementation(() => {});
  const input = document.getElementById('watchFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['video'], 'next.mp4', { type: 'video/mp4' })] });
  input.dispatchEvent(new Event('change')); await tick(1200);
  expect(document.querySelector<HTMLElement>('#watchSlots tr')!.dataset.frameTime).toBeUndefined();
  expect(document.getElementById('watchStartBtn')!.textContent).toBe('เริ่มเฝ้า');
  expect(video.paused).toBe(true);
  expect(fake.detect).toHaveBeenCalledTimes(2); // old slot + new file discovery
});
it('does not count presentation wall time as empty-stock time', async () => {
  fake.slow = true; video.currentTime = 2;
  (document.getElementById('watchHold') as HTMLInputElement).value = '5';
  click('watchStartBtn'); await tick(13000);
  expect(document.getElementById('watchOutCount')!.textContent).toBe('0');
  expect(document.querySelectorAll('#watchLog [data-event="out"]').length).toBe(0);
  // Only the source timeline advancing can complete the hold.
  video.currentTime = 8; await tick(10000);
  expect(document.getElementById('watchOutCount')!.textContent).toBe('2');
});
it('ignores queued emptied events from closing a previous source while waiting for new data', async () => {
  let ready = 0;
  Object.defineProperty(video, 'readyState', { get: () => ready });
  vi.spyOn(video, 'load').mockImplementation(() => { setTimeout(() => video.dispatchEvent(new Event('emptied')), 0); });
  const input = document.getElementById('watchFile') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['v'], 'new.mp4', { type: 'video/mp4' })] });
  input.dispatchEvent(new Event('change')); await tick(10);
  ready = 2; video.dispatchEvent(new Event('loadeddata')); await tick(600);
  expect(document.getElementById('watchStatus')!.textContent).toContain('ไม่เจอสินค้า');
  expect(document.getElementById('watchTransport')!.hidden).toBe(false);
});

it('keeps shelfOnly on every slot check and attaches a shared frame ID', async () => {
  click('watchStartBtn'); await tick(1100);
  expect(fake.detect.mock.calls.every(([, opts]) => opts.shelfOnly === true)).toBe(true);
  const ids = [...document.querySelectorAll<HTMLElement>('#watchSlots tr')].map(r => r.dataset.frameId);
  expect(ids[0]).toBeDefined(); expect(new Set(ids).size).toBe(1);
});
