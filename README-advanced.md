# Advanced notes — threading, workers, WASM (WP7 §7.2)

## Main-thread budget (measured, WP1 + WP6)

The frame handler chain (capture → resample → Silero inference → callbacks)
was probed at **p50 ≈ 0 ms / p95 = 0.3 ms / max 3.9 ms** per frame
(2033-frame probe, 60 s). The plan's budget: **p95 < 8 ms** — met with a
>20× margin on the reference machine. **Main-thread inference is fine; the
worker contingency is NOT needed for v1.**

Frame delivery is bursty (ScriptProcessor: ~2–3 frames every ~85 ms buffer
with sub-millisecond intra-burst gaps) — the state machine's timing is
audio-time-based (`durationMs`), so burstiness does not affect correctness.

## Worker contingency recipe (only if a target machine exceeds the budget)

Move capture + inference off the main thread; the facade API stays unchanged:

1. Create `vad-worker.js`:

   ```js
   importScripts("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js",
                 "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js");
   // inside the worker: MicVAD.new(...) with the SAME options as the adapter,
   // postMessage({prob, frame, rms, durationMs}) per frame.
   ```

2. `new Worker("vad-worker.js")` in the adapter; `onFrame` callbacks receive
   the posted frames (structured-clone the Float32Array or transfer it).

3. The mic stream lives in the worker (`getUserMedia` is available there);
   the main thread keeps only the facade + state machine.

Caveats:

- **SharedArrayBuffer**: multi-threaded WASM (`ort-wasm-simd-threaded`) needs
  cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` headers). **Single-threaded
  WASM is the tested default** and needs no special headers — its budget is
  the one measured above.
- AudioWorklet inside workers: prefer the `processorType: "ScriptProcessor"`
  path in workers too (the worklet hang affects some builds, D-WP1-5).

## Publishing

    npm publish --dry-run   # verify the file list (recordings excluded)
    npm publish             # ships speak-or-no-speak@0.1.0 (ESM-only)

The `files` field excludes `test/recordings/` (calibration audio) and
`vendor/` (the optional local CDN mirror, see below).

## Offline / blocked-CDN operation

After the first successful load, model + WASM come from the browser cache
(immutable, one year) — detection keeps working offline. If the CDN is
blocked at load time: the adapter reports `cdn-unavailable`, the facade
degrades to the energy engine, and events keep flowing
(`degraded.engine = "energy"`). A local mirror can be served from `/vendor/`
(download `ort.wasm.min.js` + `bundle.min.js` + the `.onnx`/`.wasm`/`.mjs`
assets and point the `<script>` tags and `baseAssetPath`/`onnxWASMBasePath`
at local paths).
