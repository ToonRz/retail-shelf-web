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
