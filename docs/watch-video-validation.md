# Live video mode validation — 2026-11-16

## Scope and environment

- Before editing, checked all three repositories on `main`; working trees were clean and `git pull --ff-only origin main` reported up to date. Only `retail-shelf-web` is changed. `retail-shelf-agent` and `retail-shelf-detection` remain unchanged.
- Read the prior version of this document before implementation. The shipped agent/model release was not changed, and no training was run.
- Browser input: `/Users/narawich/Desktop/NYSfnI5BtaoV1qRq__kjqw.mp4`, H.264, 1440×1080, 30 fps, 210 seconds. Chrome showed playback speed `1×`; agent `v0.3.2` ran on WebGPU.
- Confidence threshold for the live comparison and slot discovery was 0.05. Discovery found 24 slots from 25 detected items; 1 candidate was dropped as currently empty. On one file reopen, automatic discovery returned no slots; clicking discovery again on the same paused opening frame found the 24 slots (52 detect calls, 2.17 s). That first-pass inconsistency remains to investigate.

## Changes exercised

- Video and camera monitoring default to full-frame mode. A single loop owns inference; while it is busy, no frames queue. After it finishes, it captures the newest frame, subject to a 1 Hz cap.
- Each snapshot keeps its own frame ID, media-time or monotonic timestamp, image and boxes. The live video is not painted with detections from an older snapshot. The UI reports detector time, full-cycle time, capture-to-result media delay, real elapsed result age, and clip-timeline gap separately.
- Full-frame shelf-model boxes are matched against slot rectangles mapped through camera-follow transforms. Boundary/overlap ambiguity is uncertain; missing full-frame boxes do not imply an empty slot. Uncertain visible slots receive fair, round-robin crop confirmation with at most two crops per round and a 900 ms fallback budget. Unconfirmed slots remain unknown/stale.
- The old crop-per-slot method remains selectable for comparison. Flow updates use real pipeline steps without presentation holds.
- Video controls were exercised in Chrome: pause held the clip at 0:06 over a 2-second wait; resume advanced it to 0:08; stop paused it; seeking returned it to 0:00. The final run reached the end and did not resume.

## Baseline and same-clip comparison

Before implementation, the original path was observed for about 110 seconds: about 66 rounds, a final visible `detect()` total of 212 ms and capture-to-result delay of 1,428 ms. At that point six slots were visible, implying roughly seven calls per round (full-frame camera follow plus visible-slot crops); this was an observed run, not a statistical baseline.

For a controlled comparison after implementation, both methods were run from the beginning of the supplied clip at 1× with the same 24 slots and threshold over approximately the first 21 seconds. The legacy sample ended at 0:21; the full-frame sample was read at 0:21.38 before stopping. Values below are the in-app per-round mean and p95:

| Method | Rounds | Detect calls / round | `detect()` ms, mean / p95 | Full cycle ms, mean / p95 |
| --- | ---: | ---: | ---: | ---: |
| Legacy crop-per-slot | 12 | 24.0 | 1,127 / 1,616 | 1,687 / 2,432 |
| Full-frame + fallback | 22 | 2.4 | 200 / 317 | 896 / 1,155 |

In this opening segment, full-frame mode used about 90% fewer detect calls per round, reduced average `detect()` time by about 82%, and reduced average cycle time by about 47%. The windows overlap closely but are not identical, and the result is not a precision/recall comparison.

During the uninterrupted full-mode run, the clip reached 3:30 and stopped. The wall-clock interval was 229 seconds from the recorded start to the ended state, 19 seconds longer than the clip's 210-second media duration. The speed control remained `1×`; no pause control was used during this run. The frame nearest the end was snapshot #553 at 209.49 s, 0.5 s behind the clip endpoint. A completed snapshot observed at 1:58 had a real age of 0.9 s and a clip-time gap of 0.9 s. No out-of-stock alert was raised in this clip run.

The 19-second wall-time difference is measured but not attributed. Chrome's active tab changed during a later media-only attempt and its UI read timed out, so that attempt cannot isolate inference from browser scheduling or tab visibility. Controls responded during the separate pause/resume check. No worker change was made without an isolated main-thread bottleneck and verified worker/runtime compatibility.

## Browser, automated, and model limits

- Desktop Chrome was visually checked at a 1920×1080 browser surface. Chrome responsive emulation was checked at 390×844: controls wrapped to the viewport width, the agent stages stacked vertically, and no horizontal overflow was visible. This is a viewport simulation, not a physical phone test.
- The Chrome console showed only a missing `favicon.ico` (404); no inference or UI runtime exception was observed.
- WebGPU was exercised on the actual clip. The WASM fallback was not measured in this browser session. The agent API has no cancellation method; an in-flight call is allowed to finish and its result is discarded after a stop, seek, or source-generation change. No Web Worker was added; the worker/ONNX runtime path was not verified end to end.
- Unit tests cover slow detector serialization/no backlog/latest-frame capture, shared timestamps, stop/pause/seek/end/source replacement, playback speed, frame-to-slot matching, small boxes, overlap ambiguity, camera transforms, fair fallback scheduling, stale evidence, and observation-gap handling. They do not establish shelf-level precision/recall.
- The supplied clip was used for model and browser checks; no single product image was substituted for shelf validation. Physical camera behavior, a physical mobile device, Safari/iOS, WASM fallback performance, ground-truth matching accuracy, and out-of-stock event recall were not validated.

## Follow-up check from the real UI — 2026-11-16 (later)

Re-tested in headless Chromium (WASM backend, agent `v0.3.2`) against the version before the live mode (`912bbb9`), on synthetic shelves built from `public/samples/` (4 slots: 3× copp, hanami, lays, pocky each; and 12 slots alternating). In both clips the lays slot empties at 0:08 and stays empty, hold 15 s.

| Check | `912bbb9` | `060b35f` | After this fix |
| --- | --- | --- | --- |
| Open a video file → auto slots | 4 / 12 slots, names correct | **0 slots** (frame captured all black, mean pixel 0) | 4 / 12 slots, names correct |
| Still picture → auto slots | 4 slots, names correct | same rects and names | same |
| 4 slots, full-frame mode | alert 0:30 | alert 0:25.45 (after re-clicking auto slots) | alert 0:24.39 |
| 12 slots, crop-per-slot mode (≈6 s rounds on WASM) | alert 0:39 | **no alert; every slot "ผลเก่า"** | alert 0:29.81 |
| 12 slots, full-frame mode | — | alert 0:26.03 | alert 0:25.74 |
| Video ended / paused 10 s after the alert | banner stays | **banner gone, count 0, every slot "ผลเก่า"** | banner and status stay |

Causes and fixes (`src/watch.ts`, `src/ui/watch-logic.ts`):

1. A paused file at `loadeddata` had no decoded picture yet, so auto slots ran on a blank frame. The file now plays until `requestVideoFrameCallback` reports the first frame, then pauses there (what `912bbb9` did).
2. `MAX_OBSERVATION_GAP_MS = 5000` restarted a slot's empty timer whenever two looks at it were more than 5 s apart. Slow rounds or the round-robin crop queue made that the normal case, so the alert could never fire. Raised to 60 s; seeks already reset the timers.
3. Evidence was marked stale after 5 s of wall-clock time even when the clip was paused or ended, which also hid raised alerts. A file is now judged on its own timeline only, the stale limit is the hold time (at least 5 s), and a raised "ของหมด" stays until the slot is seen filled.

Naming (`cropLabel`, `autoSlots`, `NAME_CONF`) did not change between `912bbb9` and `060b35f`; on these clips both gave identical names and rects. The user's own clip was not available here, so naming on a real dense shelf was not re-checked.

## Stale video frames on a busy main thread — 2026-11-16 (later)

Report from Chrome on a Mac (WASM, crop-every-slot mode, `public/samples/demo-shelf.mp4`): at the end of the clip every slot still read "มีของ". The snapshot sent to the model showed the 0:02 frame (full shelf) while stamped 119.5 s, and the stage showed the 0:50 frame at 2:00. A round there took ~2.5 s (7 back-to-back `detect()` calls), so the wait between rounds was 0 and the page never gave the browser a rendering step; the video kept handing `drawImage` an old frame while `currentTime` ran on.

Fix (`src/watch.ts`): `capture()` waits (≤ 300 ms) for `requestVideoFrameCallback` on a playing video and draws right after it, stamping the frame with the callback's `mediaTime`; `detectShown()` waits for one painted frame (`painted`, ≤ 50 ms when animation frames do not run) before each model call. Test: `watch-session.test.ts` "stamps a playing frame with the media time of the frame on screen".

Headless Chromium on Linux did not show the stale frames before the fix, so the original failure was not reproduced here. After the fix, on the same clip (WASM, conf 0.25, hold 15 s):

| Mode | lays out | pocky out | lays restocked | copp out | hanami (half emptied) |
|---|---|---|---|---|---|
| Full frame | 0:37.1 | 1:02.2 | 1:20.1 | 1:46.6 | no alert |
| Crop every slot | 0:38.0 | 1:08.4 | 1:23.6 | 1:50.3 | no alert |

Expected (hold 15 s): ~0:35, ~1:00 (later if the person walking past at 1:02–1:07 blocks the slot), ~1:18, ~1:45.
