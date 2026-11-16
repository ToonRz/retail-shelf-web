# Watch video synchronization validation — 2026-11-16

All three repositories were clean on main and `git pull --ff-only origin main` reported up to date before edits. Only retail-shelf-web changes; no model, release pin, training, commit, or push.

## Findings and experiments

- Original `checkSlot()` sampled time after each asynchronous detect. A stop only changed the loop flag, allowing the in-flight answer to mutate state and leaving the video playing.
- Initial regression reproduced the missing pause and missing per-frame result provenance. Tests exercise the actual watch module with a DOM, delayed detector, fake clock/media/canvas, and stubbed flow rendering.
- Comparing continuous versus presentation mode isolates UI hold time. Every round now freezes its timestamp when pixels are copied; every asynchronous continuation checks its generation before publishing. A single busy owner serializes auto-discovery and watch calls even after cancellation.
- Chrome exposed a separate queued `emptied` event from the previous source. Source-load cancellation now uses an AbortController instead; a regression covers that event ordering.
- `agent/src/detect.ts` confirms inference runs in-browser and latency includes preprocessing and postprocessing. No evidence here calls for training.

## Automated checks

- Web: `npm test` — 81 tests passed, including 15 watch-session regressions in `test/watch-session.test.ts`.
- Web: `npm run build` — TypeScript + Vite passed.
- Agent (unchanged): 75 tests, typecheck and build passed.
- `git diff --check` passed.
- Session regressions cover slow multi-slot detection; shared IDs/timestamps; presentation toggling and hold time; pause/resume/stop/seek races; changing files; end-of-video; source-load event ordering; camera monotonic time/no pause; detect versus cycle duration; shelfOnly.

## Actual browser checks

Headless Google Chrome with the locally staged v0.3.2 model (WebGPU), at 1440×1000 and 390×844. Input was a 20-second H.264 MP4 generated from `public/samples/lays.jpg` using ffmpeg. Playwright drove actual file input, pointer drawing, buttons, slider and speed select. No page errors were reported.

Observed: model loads; file loads and auto-discovery completes (this single-pack fixture produces no accepted auto-slots); two manually drawn slots are checked; presentation freezes video time; pause prevents automatic resume; resume works; seek produces new timestamps; stop pauses; continuous mode plays with a separate snapshot; mobile controls accept play/pause/speed input; no horizontal overflow or overlay interception. Desktop and mobile screenshots were visually inspected.

## Limits

This is playback/state validation, not a shelf-detection accuracy benchmark. Auto-slot success, physical camera motion, real camera permission/device behavior, Safari/iOS, and physical touch devices were not checked in-browser. Camera behavior is covered by DOM simulation and existing tracking algorithm tests. Slow model concurrency and changing files during a call are simulated deterministically; the real-browser model was fast. Detection/training repository was inspected but its Python/training pipeline was not run or changed.

The current agent contract has no cancellation API. An old detect call must settle before the next can begin; its results are discarded after invalidation. A synchronous WASM call can still delay input handling until it yields to the browser.
