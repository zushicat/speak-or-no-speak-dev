# WP1 — VAD engine integration (Silero via CDN)

- **Status:** done (2026-10-20) — all acceptance criteria verified in browser (Chromium 154 via ego-browser automation; Safari quick check pending manual pass)
- **Phase:** M1
- **Estimate:** 0.5–1 d
- **Depends on:** WP0
- **Decisions applied:** D1 (zero-build CDN)
- **Master plan:** [plan-initial.md](../plan-initial.md)

## Objective

Frame-level speech probabilities from Silero VAD v5 flowing in the browser, behind a clean `VadEngine` interface, with browser echo cancellation verified on the microphone track. The engine is swapped later (WP7 fallback) or tuned — the interface is the contract that stays.

## Prerequisites

- WP0 acceptance criteria met (secure context serving works).

## Steps

### 1.1 CDN script tags in `index.html`

Per the [vad-web README](https://github.com/ricky0123/vad) quickstart, add **before** the module script:

```html
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
```

Pin exact versions (0.0.31 / ORT 1.22.0 at plan time; re-pin at implementation if newer patches exist). These register the globals `ort` and `vad`. Our own code loads as ES modules and reads `window.vad` only inside the adapter (single choke point — keeps a later npm/bundler migration trivial).

### 1.2 `src/vad/vad-engine.js` — the interface (JSDoc, D1: no TS)

```js
/**
 * @typedef {Object} VadFrame
 * @property {number} probability    P(speech) for this frame, 0..1
 * @property {Float32Array|null} frame  raw 16 kHz mono samples of this frame
 *                                      (null if the engine build doesn't provide it)
 * @property {number} rms            loudness 0..1 of the frame
 * @property {number} durationMs     frame duration (~96 ms at 1536 samples/16 kHz)
 */

/**
 * @typedef {(frame: VadFrame) => void} FrameCallback
 * @typedef {(err: {code: string, message: string}) => void} ErrorCallback
 */

/** @interface */
export class VadEngine {
  /** Load model + open mic. Resolves when the first frame is emitted. */
  async start() {}
  stop() {}
  pause() {}
  resume() {}
  /** @param {FrameCallback} cb */
  onFrame(cb) {}
  /** @param {ErrorCallback} cb */
  onError(cb) {}
}
```

### 1.3 `src/vad/silero-vad-adapter.js`

Responsibilities, in order:

1. **Mic with AEC constraints (E1 groundwork):**

```js
const stream = await navigator.mediaDevices.getUserMedia({
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
});
const settings = stream.getAudioTracks()[0].getSettings();
// log settings; if settings.echoCancellation !== true → emit warning event (no-aec),
// facade will switch to stricter barge-in gating in WP5.
```

2. **Instantiate vad-web, passing our stream** so the constraints actually apply:

```js
const myvad = await window.vad.MicVAD.new({
  stream,                                          // our constrained MediaStream
  baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/",
  onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",
  frameSamples: 1536,   // ~96 ms/frame at 16 kHz; if the pinned version rejects
                        // this option, omit it and record the deviation
});
```

*Verification step:* check the pinned version's docs/bundle for `stream` and `frameSamples` option support; if `stream` is unsupported, fall back to vad-web's `audioConstraints` option — **acceptance requires the mic track to report `echoCancellation: true` regardless of which mechanism wins.**

3. **Frame stream:** wire `onFrameProcessed` and translate:

```js
myvad.onFrameProcessed = (probs, frame) => {
  // probs.isSpeech / probs.notSpeech; frame may or may not be provided
  // depending on the pinned version — VERIFY once at runtime (console.log)
  // and store the finding in this file's header comment.
  const rms = frame ? computeRms(frame) : 0;
  emit({ probability: probs.isSpeech, frame: frame ?? null, rms, durationMs: 96 });
};
```

*Audio-capture strategy decision:* if `frame` **is** provided → our state machine (WP3) buffers turn audio from frames (preferred, full control incl. pre-speech pad). If **not** → fallback strategy: collect turn audio from vad-web's `onSpeechEnd(audio)` segment callback while our state machine drives *timing* from probabilities; document the deviation in WP3.

4. **Keep vad-web's internal segmentation unwired** (`onSpeechStart/onSpeechEnd` only as the fallback above). Our state machine is the single source of truth for events.
5. Wire vad-web's error path → `onError` (codes come in WP7; interim codes fine).
6. Guard: `typeof window === 'undefined' || !window.vad` → `onError({code:'cdn-unavailable', ...})` (module stays importable in Node for unit tests).

### 1.4 Smoke wiring in `demo/main.js`

- Instantiate the adapter on a click (defer mic access to user gesture — Safari requires it).
- `onFrame`: every 10th frame, `console.log(prob, rms)`; also naive indicator coloring (`prob > 0.6 → green`) as a pre-WP2 sanity check.
- Log `stream.getAudioTracks()[0].getSettings()` once.

### 1.5 Performance probe

Wrap the frame handler with `performance.now()`; after 60 s of running, log p50/p95 handler time. This number decides whether main-thread inference is fine (expected: Silero is < 1 ms/frame) or the WP7 worker contingency must trigger (threshold: p95 > 8 ms).

## Acceptance criteria

- [x] Probabilities stream ~every **32 ms** (see deviation D-WP1-1: v5 frames are 512 samples, not 1536); speech typically ≥ 0.85 (measured 0.89–1.0), silence typically ≤ 0.15 (measured 0.000–0.06).
- [x] Mic track settings report `echoCancellation: true` (also `noiseSuppression: true`, `autoGainControl: true`; native track rate 48 kHz, resampled to 16 kHz internally).
- [x] Frame handler p95 < 8 ms over 60 s (probe output recorded in "Results" below).
- [x] Model + WASM fetched from CDN once (subsequent loads from cache: `performance.getEntriesByType("resource")` shows `transferSize: 0` for `ort.wasm.min.js`, `bundle.min.js`, `silero_vad_v5.onnx` (2.3 MB), `ort-wasm-simd-threaded.mjs`, `ort-wasm-simd-threaded.wasm` (11 MB); CDN serves `cache-control: immutable, max-age=31536000`).
- [ ] Works in Chrome and Safari (quick check; full matrix in WP5/WP6). **Chrome: verified. Safari: pending** — manual pass (open http://localhost:5173, click Start, speak).
- [x] Missing `window.vad` (CDN blocked via CDP `Network.setBlockedURLs`) → clean `onError({code:"cdn-unavailable"})`, no uncaught exception, button stays usable.

**Results (filled during implementation):** handler p50 **0.0** ms, p95 **0.3** ms (max 3.9 ms over 2033 frames / 65 s) — main-thread inference OK, worker contingency NOT triggered. `onFrameProcessed` frame param provided: **yes** (512-sample Float32Array @ 16 kHz → `durationMs` 32.0 ms). Measured frame rate 31.99 Hz; delivery is bursty (ScriptProcessor: p50 gap 0.9 ms inside ~85 ms buffer bursts) — state-machine timing must use `durationMs`, not callback cadence.

### Verified deviations from this WP's sketches (implement against 0.0.31 reality)

| # | Sketch said | 0.0.31 reality | Consequence |
|---|---|---|---|
| D-WP1-1 | frames 1536 samples ≈ 96 ms | frame size is **model-derived**: `legacy ? 1536 : 512` (bundle); `frameSamples` option **ignored** by MicVAD | Silero v5 → **512 samples = 32 ms/frame ≈ 31 Hz**. **WP3 must recalibrate frame-count thresholds** (e.g. `onsetConfirmFrames` 3×96 ms → ~9×32 ms for 288 ms; `bargeInConfirmFrames` 2×96 ms → ~5–6×32 ms for 150–190 ms). Finer granularity is *better* for onset/turn latency. |
| D-WP1-2 | `stream` option on `MicVAD.new` | not an option; documented **`getStream: async () => stream`** override | Our AEC-constrained stream is used directly — cleaner than the sketch. |
| D-WP1-3 | default model = v5 | `model` defaults to **`"legacy"`** | Pass `model: "v5"` explicitly (T1). |
| D-WP1-4 | `baseAssetPath`/`onnxWASMBasePath` needed | defaults already CDN; pinned explicitly anyway | Defensive pinning kept. |
| D-WP1-5 | AudioWorklet always works | `audioWorklet.addModule` **can hang forever** (observed in automation Chromium 154; also reported on old Safari/embedded webviews) | `MicVAD.new()` timeout-guarded (8 s) → retry with `processorType: "ScriptProcessor"` (documented legacy path). Effective path exposed as `adapter.processorTypeUsed`. Automation environment ran the ScriptProcessor path throughout. |

### Verification log (2026-10-20, ego-browser Chromium 154, macOS)

1. Node import: adapter + interface importable without `window`; `start()` in Node → clean `onError` `cdn-unavailable` (module stays unit-testable).
2. Mic: `getUserMedia` with AEC constraints → track settings logged, `echoCancellation=true`, `aecDegraded=false`.
3. Frame stream: 2030 frames / 65 s during live speech probe; speech probs 0.89–1.0, silence ≤ 0.06; `frameParamProvided = true`; frame len 512 / 32.0 ms.
4. Perf (60 s, silence): handler p50 0.0 ms / p95 0.3 ms / max 3.9 ms; frame-interval p95 92.6 ms (burst cadence); no main-thread stalls.
5. Cache: second load — all five CDN assets `transferSize: 0` (memory/disk cache), 1–20 ms load.
6. CDN blocked: `Network.setBlockedURLs(["*cdn.jsdelivr.net*"])` → reload → `window.vad`/`ort` absent → click Start → status `error [cdn-unavailable]: window.vad is missing…`, no uncaught exception. CDN unblocked again afterwards.

## Risks

| Risk | Mitigation |
|---|---|
| CDN blocked by network policy / offline dev | Fallback documented: download the two dist files into `/vendor/`, serve locally, point the two `*BasePath` options + `<script src>` at local paths (already in `.gitignore` so the repo stays clean) |
| Pinned vad-web version lacks `stream` or `frameSamples` options | Verification step 1.3.2; use `audioConstraints` fallback; record deviation |
| Safari needs user gesture for AudioContext | Mic access starts from a click (1.4); formalized in WP2 UI |
| ORT WASM threads want cross-origin isolation headers | Single-threaded WASM still meets the < 8 ms budget for Silero; multi-thread recipe noted for WP7 |

## Deliverables

- `src/vad/vad-engine.js`, `src/vad/silero-vad-adapter.js`, updated `index.html` + `demo/main.js`, recorded performance results.
