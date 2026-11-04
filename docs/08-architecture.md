# Chapter 8 — Architecture

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 7](07-detection-methods.md) · next: [Chapter 9 — Source file guide](09-source-files.md)

## 8.1 Component map

The project ships an **explorable architecture webapp** — open it directly in a
browser, no server needed:
[`docs/archify/speak-or-no-speak.architecture.html`](archify/speak-or-no-speak.architecture.html).

Screenshot of the diagram:

![Speak Or No Speak — browser turn detection architecture](../plans/rev-4/assets/speak-or-no-speak-browser-turn-detection.png)

The components and their roles:

| Component | Where | Role |
|---|---|---|
| User → Microphone | outside the page | speaks · barges in; `getUserMedia` with AEC/NS/AGC |
| jsDelivr CDN | external, pinned | `vad-web` 0.0.31 + `ort-web` 1.22.0 via `<script>` tags |
| Demo page | `demo/index.html` + `demo/main.js` | UI mapping only (browser tab, secure context) |
| `createSpeakOrNoSpeak()` | [`src/speak-or-no-speak.js`](../src/speak-or-no-speak.js) | facade · wires engine ↔ detector · public API |
| `SileroVadAdapter` | [`src/vad/silero-vad-adapter.js`](../src/vad/silero-vad-adapter.js) | default engine — Silero v5 via vad-web; emits `VadFrame` every 32 ms |
| `EnergyVad` | [`src/vad/energy-vad.js`](../src/vad/energy-vad.js) | degraded fallback — RMS vs adaptive noise floor |
| `TurnDetector` | [`src/turn/turn-detector.js`](../src/turn/turn-detector.js) | ready/listening/pause × agentSpeaking state machine · adaptive endpointing |
| `SmartTurnModel` | [`src/turn-model/smart-turn.js`](../src/turn-model/smart-turn.js) | optional end-of-turn · fail-open 300 ms · lazy ONNX session from `/vendor/` |
| STT adapter | [`src/stt/`](../src/stt/stt-adapter.js) | app-supplied (`CloudStubAdapter` example) · app-wired, outside the real-time loop |
| STT endpoint | dev stub `:5175` or your backend | POST WAV → `{text}` — dev-only stub |

## 8.2 End-to-end data flow

```
mic ──getUserMedia(AEC/NS/AGC)──► vad-web capture (AudioWorklet or
                                   ScriptProcessor, resampled to 16 kHz)
        │
        ▼  VadFrame every 32 ms {probability, frame, rms, durationMs}
  TurnDetector.onFrame ── state machine (Chapter 7) ──┬─► onSpeechStart (S1)
        │                                             ├─► onTurnEnd (S2, +audio)
        │                                             └─► onInterrupt (S3)
        └─ every frame also: onLevel(rms) → UI meter
```

Everything above the mic lives inside the browser tab; nothing leaves the
device. The engine is replaceable behind one interface, and the detector is a
pure function of the frame stream plus the agent flag.

## 8.3 The engine abstraction

[`src/vad/vad-engine.js`](../src/vad/vad-engine.js) defines the contract every
engine implements:

```js
interface VadEngine {
  start():  Promise<void>;  // load model + open mic; resolves on first frame
  stop():   void;           // release everything
  pause():  void;  resume(): void;
  onFrame(cb: (frame: VadFrame) => void): void;
  onError(cb: (err: {code, message}) => void): void;
}
```

Two rules make the abstraction work:

- **Engines never decide turns.** They emit frames; the `TurnDetector` is the
  single consumer of the stream and the only owner of turn semantics.
- **Implementations must stay importable in Node** (no top-level
  `window`/`navigator` access — guarded inside `start()`), so the whole
  detection core is unit-testable without a browser (D1).

## 8.4 The facade wiring

[`createSpeakOrNoSpeak`](../src/speak-or-no-speak.js) does exactly four things:

1. **Merges options** over `DEFAULTS` (`mergeOptions` — per-key recursive
   merge for objects, replacement for everything else).
2. **Constructs** the engine (default `SileroVadAdapter` with the merged mic
   constraints) and the `TurnDetector` (thresholds, debug flag, optional
   `turnModel`).
3. **Wires the streams**: engine `onFrame` → `detector.onFrame` + `onLevel`;
   engine `onError` → your `onError`.
4. **Implements the degradation ladder in `start()`**: if the Silero engine
   throws `engine-load-failed`, `cdn-unavailable`, or `audio-pipeline`, and a
   fallback is allowed (no injected `engine`, or an explicit `energyEngine`
   was provided), it stops the failed engine, emits a one-time
   `engine-fallback` warning, switches to `EnergyVad`, and starts again.
   Mic/permission/context failures are **fatal** — no fallback can help.
   After start, `detector.noAecMode` is set from `engine.aecDegraded`.

## 8.5 A pure state machine — on purpose

`TurnDetector` has **no `window`/`document` access** and no wall-clock
dependencies: all timing derives from `frame.durationMs` (audio time). That
buys three things:

- the full machine is unit-tested in Node with synthetic frame sequences
  ([`test/unit/turn-detector.test.js`](../test/unit/turn-detector.test.js)),
- calibration recordings can be **replayed deterministically** through any
  configuration ([§16.5](16-build-test-publish.md#165-the-replay-harness-and-calibration-recordings)),
- bursty frame delivery (2–3 frames per ScriptProcessor buffer) cannot skew
  timing — the machine counts audio time, not callback time.

## 8.6 The audio capture pipeline

The Silero adapter's capture path ([Chapter 10](10-vad-engines.md)):

1. `getUserMedia({ audio: AEC_CONSTRAINTS })` — **our** stream, passed to
   vad-web via its documented `getStream` override, so the AEC/NS/AGC
   constraints apply to the exact stream the engine consumes.
2. Track settings are inspected: `echoCancellation !== true` →
   `aecDegraded = true` + `no-aec` warning (drives the stricter barge-in
   gating, [§6.7](06-agent-integration.md#67-without-aec--the-stricter-gating)).
3. vad-web runs its own AudioContext at the device rate (typically 48 kHz) and
   resamples to 16 kHz internally; frames are model-derived 512 samples
   (32 ms).
4. Capture uses vad-web's default AudioWorklet path; if the worklet module
   load hangs, the adapter retries with the legacy ScriptProcessor path
   ([§10.4](10-vad-engines.md#104-the-audioworklet-hang-and-the-scriptprocessor-fallback)).

The energy engine's pipeline is deliberately worklet-free:
`getUserMedia → AudioContext → ScriptProcessor(4096) → box-average downsample
to 16 kHz → 512-sample frames → RMS probability` ([§10.5](10-vad-engines.md#105-energyvad--the-degraded-fallback)).

## 8.7 Threading model

**Main-thread inference is fine — measured.** The frame handler chain
(capture → resample → Silero inference → callbacks) was probed at
**p50 ≈ 0 ms / p95 = 0.3 ms / max 3.9 ms** per frame (2033-frame probe over
60 s). The plan's budget was p95 < 8 ms — met with a **>20× margin**. The
worker contingency is therefore **not needed for v1**.

Frame delivery is bursty (ScriptProcessor: ~2–3 frames every ~85 ms buffer
with sub-millisecond intra-burst gaps) — harmless, because the state machine's
timing is audio-time-based ([§8.5](#85-a-pure-state-machine--on-purpose)).

**Worker contingency recipe** (only if a target machine ever exceeds the
budget) — move capture + inference off the main thread; the facade API stays
unchanged:

1. Create `vad-worker.js` that `importScripts(...)` the two pinned CDN
   libraries and runs `MicVAD.new(...)` with the *same* options as the
   adapter, posting `{prob, frame, rms, durationMs}` per frame.
2. In the adapter, `new Worker("vad-worker.js")` and forward posted frames to
   the `onFrame` callbacks (structured-clone or transfer the `Float32Array`).
3. The mic stream lives in the worker (`getUserMedia` is available there); the
   main thread keeps only facade + state machine.

Caveats:

- **SharedArrayBuffer**: multi-threaded WASM (`ort-wasm-simd-threaded`) needs
  cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp` headers). **Single-threaded
  WASM is the tested default** and needs no special headers — its budget is
  the one measured above.
- AudioWorklet inside workers: prefer the `processorType: "ScriptProcessor"`
  path there too (the worklet hang affects some builds).

## 8.8 Design decisions and their reasons

| Decision | Why |
|---|---|
| Own state machine instead of vad-web's `onSpeechStart`/`onSpeechEnd` | vad-web's segmentation is a fixed silence timeout: no adaptive endpointing, no barge-in mode, no pause sub-state, no pad control. The adapter consumes **frames only**; vad-web's own callbacks stay unwired by design. |
| Energy fallback instead of hard failure | A blocked CDN or a failed model load must not kill the page — a degraded detector that *works* beats a dead one, as long as the degradation is flagged (`degraded.engine`). |
| Fail-open turn model | The Smart Turn model can only *hold* a turn, never lose one: errors/timeouts emit the turn end ([§12.2](12-smart-turn.md#122-when-it-runs-and-fail-open-semantics)). |
| STT strictly outside the real-time loop | STT latency/failures must never affect detection; the module ships no engine and never calls adapters itself (Chapter 13). |
| Browser AEC as the E1 groundwork | The browser cancels **what it can reference** — `RTCPeerConnection` audio on Chrome/Edge/Firefox by default; same-page audio needs the route (rev-8.1 WP-E2 `createAgentAudioRoute`) or the `"all"` scope (D1) + the OS permission; Safari's system AEC covers everything. Measured per-browser table: [analysis-rev-8 §3.1](../plans/rev-8/analysis-rev-8.md), [Chapter 6 §6.6](06-agent-integration.md#66-echo-cancellation-scope). Statistical gating covers the rest. |
| Main thread instead of a worker | Measured p95 0.3 ms against an 8 ms budget; a worker adds cross-origin-isolation requirements and complexity for no measured need (recipe kept in [§8.7](#87-threading-model)). |
| Zero-build source layout | Plain ES modules from a static server keep the dev loop free of toolchains; the bundle (Chapter 16) serves consumers who want one file. |
| Every threshold is an option | No hidden constants — apps tune per environment from documented defaults ([Chapter 14](14-configuration-tuning.md)). |

---

*Prev: [Chapter 7 — Detection methods](07-detection-methods.md) · Next: [Chapter 9 — Source file guide](09-source-files.md)*
