# Chapter 9 — Source file guide

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 8](08-architecture.md) · next: [Chapter 10 — VAD engines](10-vad-engines.md)

What each individual JavaScript file in `src/` actually does — per file: its
purpose, its key exports, and what it deliberately does **not** do. The
repository layout first, then the files grouped by directory.

## 9.1 Repository layout and the zero-build philosophy

```
demo/                 demo page (index.html, main.js, stt-stub-server.py, assets/)
src/                  the module (facade, VAD adapters, turn state machine)
  vad/                engine interface + Silero adapter + energy fallback
                      + aec-scope.js (AEC scope negotiation/classification, rev-8.1 WP-E1)
  turn/               the pure state machine + ring buffer
                      + echo-correlation.js (coherence echo gate, WP-E3)
  turn-model/         optional semantic end-of-turn model (+ its feature pipeline)
  stt/                transcription plug point (interface + example)
  agent-audio/        echo-reference-route.js — cancelable agent audio (WP-E2)
  gate/               agent-voice-gate.js + kaldi-fbank.js — voice-profile gate (WP-E4, default off)
test/                 node --test suite, replay harness, calibration recordings
scripts/              build-bundle.mjs (the single-file bundle builder)
                      build-agent-voice-profile.mjs (voice-gate profile, WP-E4)
build/                prebuilt ESM + IIFE bundles (+ sourcemaps)
vendor/               gitignored local assets (Smart Turn weights, speaker-embedding model, optional CDN mirror)
plans/                implementation plans & work packages (not published)
docs/                 this documentation (+ the archify architecture webapp)
```

**Zero-build**: no bundler and no TypeScript compile for development — plain
ES modules loaded straight from the static server; the runtime libraries are
pinned via CDN `<script>` tags. Types are JSDoc `@typedef`s
([`src/types.js`](../src/types.js)) that editors resolve without a build.
(The prebuilt bundle for consumers is a *release* artifact, built on demand —
[Chapter 16](16-build-test-publish.md).)

## 9.2 `src/index.js` — the public export surface

The **only module consumers should import**. It re-exports the 16 public names
grouped by concern: the facade (`createSpeakOrNoSpeak`), engines
(`SileroVadAdapter`, `EnergyVad`, `energyProbability`), errors (`SpeakError`,
`ERROR_CODES`, `humanMessage`), the turn model (`SmartTurnModel`), the STT plug
point (`SttAdapter`, `CloudStubAdapter`), advanced detection
(`TurnDetector`, `redemptionFor`), WAV export (`encodeWav`,
`encodeWavBytes`), and configuration (`DEFAULTS`, `mergeOptions`). Full table:
[§5.7](05-api-reference.md#57-all-16-exports).

## 9.3 `src/speak-or-no-speak.js` — the facade

**Purpose:** `createSpeakOrNoSpeak(options)` → merges options over `DEFAULTS`,
constructs engine + detector, wires the frame stream, exposes the five public
members (`start`, `stop`, `setAgentSpeaking`, `state`, `degraded`).

Key behavior ([details in §8.4](08-architecture.md#84-the-facade-wiring)):

- `start()` wires the detector callbacks to your options, starts the engine,
  and — on `engine-load-failed` / `cdn-unavailable` / `audio-pipeline` —
  switches to the energy engine with a one-time `engine-fallback` warning
  (skipped when you injected a custom `engine` without an `energyEngine`).
- After start, `detector.noAecMode` is set from `engine.aecDegraded`.
- `state` mirrors the detector (idle when stopped); `degraded` reports
  `{ aec, engine }`.

The module doc comment carries the **agent integration contract** — the same
rules as [Chapter 6](06-agent-integration.md) — because that is the piece
embedders most often get wrong.

**Does not:** touch the microphone (that is the engines'), decide anything
about turns (that is the detector's), or hold detection state of its own.

## 9.4 `src/config.js` — defaults and option merging

**Purpose:** `DEFAULTS` — the complete default configuration, every value
traceable to a plan decision — and `mergeOptions(user, defaults)`.

- `DEFAULTS.mic`: `{ channelCount: 1, echoCancellation: true,
  noiseSuppression: true, autoGainControl: true }` — browser AEC is the E1
  echo-safety groundwork.
- `DEFAULTS.thresholds`: the 13 detection thresholds
  ([§5.3](05-api-reference.md#53-thresholds)); frame counts calibrated for
  Silero v5's 32 ms frames (the plan's original 96 ms figures describe the
  same wall-clock windows — deviation **D-WP1-1**).
- `mergeOptions`: plain objects merge **recursively per key**; every other
  value (numbers, arrays, functions, `null`, `undefined`) replaces the default;
  `undefined` means "not provided" and keeps the default. Returns a new object,
  never mutates inputs, no `window` access (Node tests use it).

## 9.5 `src/errors.js` — the error taxonomy

**Purpose:** stable error **codes** app code can branch on.

- `ERROR_CODES`: the 9 codes — fatal: `mic-denied`, `mic-not-found`,
  `insecure-context`, `cdn-unavailable`, `engine-load-failed`; warnings:
  `no-aec`, `engine-fallback`; runtime: `audio-pipeline`, `vad-no-frames`.
- `SpeakError`: `Error` subclass carrying `code` (and a `cause`).
- `humanMessage(code)`: a ready-made UI sentence per code — the demo maps all
  errors through it.

**Design rule:** codes are the contract, messages are prose. Errors are
delivered **both ways** — thrown from `start()` and emitted via `onError`
([§5.6](05-api-reference.md#56-error-codes--humanmessage)).

## 9.6 `src/types.js` — the typed contract

**Purpose:** the source of truth for the public API surface as JSDoc
`@typedef`s only (no TS compile, per D1): `VadFrame`, `TurnEndEvent`,
`InterruptInfo`, `EngineError`, `ModuleState`, `Thresholds`, `TurnModel`,
`SpeakOrNoSpeakOptions`, `SpeakOrNoSpeak`. Editors with TS language support
resolve these in plain JS consumers. Some typedefs are re-declared here even
though they also exist near their implementation, so the **public** contract is
self-contained.

## 9.7 `src/wav-export.js` — WAV encoding

**Purpose:** zero-dependency 16-bit PCM WAV encoder — the debugging/export
tool for turn audio.

- `encodeWavBytes(samples, sampleRate = 16000)`: pure byte building — 44-byte
  RIFF header + little-endian int16 samples, clamped to [−1, 1].
- `encodeWav(samples, sampleRate)`: wraps the bytes in a `Blob`
  (browser) or `Buffer` (Node ≥ 18) — used by `CloudStubAdapter` for the POST
  body and by the demo's turn-audio handling.

**Path note (D-WP4-1):** the plan placed this in `test/util/`, but the demo
imports it in the browser and it must not drag `node:test` into a page — so
the encoder lives in `src/` and its tests in `test/util/`.

## 9.8 `src/vad/` — the engines

- **`vad-engine.js`** — the `VadEngine` interface and the `VadFrame` typedef.
  Contract: engines emit frames + errors; the detector is the single frame
  consumer; `start()` resolves when the first frame is emitted; implementations
  stay Node-importable (no top-level `window`/`navigator`).
- **`silero-vad-adapter.js`** — the default engine; detailed in
  [Chapter 10](10-vad-engines.md).
- **`energy-vad.js`** — the degraded fallback engine; detailed in
  [Chapter 10](10-vad-engines.md).
- **`aec-scope.js`** (rev-8.1 WP-E1) — the honest AEC-scope machinery:
  `AEC_CONSTRAINTS` (`{ideal:"all"}`, D1 — the single constraint source used
  by `DEFAULTS.mic` and both engines), `classifyAecScope(settings)`
  (D2/D3: `"all" | "remote-only" | "unknown" | "none"`, value-based, never
  browser-sniffing), `endedFallbackConstraints` (D4's one-time fallback
  re-request), `strictGatingActive` (D5's scope × route × override rule).
  Pure, Node-tested; the adapter exposes `engine.aecScope` and keeps
  `aecDegraded` derived (`scope === "none"`).

## 9.9 `src/turn/` — the detection core

- **`turn-detector.js`** — the heart: the pure onset/turn-end/barge-in state
  machine ([Chapter 7](07-detection-methods.md)). Also exports
  `redemptionFor` (the adaptive redemption policy), keeps the rolling
  agent-playback rms baseline (no-AEC gating), gates turn ends through the
  optional `turnModel` (fail-open), and records debug traces
  (`debug: true` → `traces`, last 100 transitions). Private state is reset by
  `reset()`; `pause()`/`resume()` freeze accumulation without dropping the
  ring buffer. Rev-8.1 additions: the coherence echo gate
  (`echoGate` options + `pushEchoReference`), the voice-gate frame hook
  (`setVoiceGate`), and `halfDuplex` (M6 escape hatch — armed frames are
  non-speech).
- **`ring-buffer.js`** — fixed-capacity `Float32Array` ring buffer for the
  pre-speech pad: `push()` (frames longer than capacity keep only their last
  samples), `flush()` (chronological output + reset), `clear()`. The detector
  sizes the capacity as `preSpeechPadMs + onsetConfirmFrames × frameDuration`
  so confirmed onset frames are part of the flushed pad and word onsets are
  never clipped ([§7.9](07-detection-methods.md#79-turn-boundaries-and-guards)).
- **`echo-correlation.js`** (rev-8.1 WP-E3) — pure normalized cross-correlation
  of a mic frame against the agent-reference ring (strided delay search,
  box-average decimation); the coherence echo gate's classifier.

## 9.10 `src/turn-model/` — the semantic model

- **`smart-turn.js`** — `SmartTurnModel` behind the `TurnModel` interface:
  `predictComplete(turnAudio) → Promise<boolean>`. Lazy ORT session init
  (`ensureSession`), WASM execution provider, threshold 0.5 on the model's
  completion probability. Detailed in [Chapter 12](12-smart-turn.md).
- **`whisper-features.js`** — Whisper log-mel feature extraction in pure JS:
  pad/truncate to 8 s → zero-mean/unit-variance → center reflect-pad →
  periodic-Hann window → **Bluestein chirp-z rfft(400)** (400 is not a power of
  two; the radix-2 FFT is float64 to match numpy precision) → power² → slaney
  mel filterbank (80) → log10 → drop last frame → `max(x, max−8)` → `(x+4)/4`,
  output `[80, 800]` float64 row-major. Allocation-free via cached working
  buffers (per-call allocation would generate ~25 MB garbage and trigger GC
  storms that also stall the following ONNX inference). Parity-verified against
  the Python reference (max abs diff 8.8e-6). Detailed in
  [Chapter 12](12-smart-turn.md).

## 9.11 `src/stt/` — the transcription plug point

- **`stt-adapter.js`** — the `SttAdapter` **interface**
  (`transcribe(audio, { language }) → Promise<{ text, confidence? }>`) and the
  hard rule: STT lives strictly **outside** the real-time loop; the module
  itself never calls adapters — the wiring belongs to the embedding app
  ([Chapter 13](13-transcription.md)).
- **`cloud-stub-adapter.js`** — the shipped ~50-line example: POSTs the turn
  as a 16-bit PCM WAV body (`encodeWav`) with optional
  `Authorization: Bearer` and `X-Language` headers, expects
  `{ text, confidence? }` JSON back. Dev example by design — implement
  `SttAdapter` for any real backend.

## 9.11a `src/agent-audio/` — cancelable agent audio (rev-8.1 WP-E2)

- **`echo-reference-route.js`** — `createAgentAudioRoute({ audioContext?,
  gain?, mode? })`: plays the app's agent voice through a local WebRTC
  loopback (`MediaStreamDestination` → pc1 ⇄ pc2 → `<audio autoplay>`) so the
  browser's AEC references it as *remote participant* audio; WebKit resolves
  to **direct** mode (`resolveRouteMode`, D7 — measured: WebKit's loopback
  gathers no ICE candidates). Contract: connect the source to `route.input`
  ONLY, control volume on `route.gain.gain.value` (D8), create it inside the
  mic-start gesture (R2), `stop()` is idempotent, `getReferenceNode()` feeds
  the E3 echo gate. Failures throw `audio-pipeline` — the app keeps plain
  playback ([§5.4a](05-api-reference.md#54a-createagentaudiorouteoptions)).

## 9.11b `src/gate/` — the voice-profile gate (rev-8.1 WP-E4, default off)

- **`agent-voice-gate.js`** — `AgentVoiceGate`: embeds turn/rolling-window
  audio through a speaker-verification ONNX and compares against the agent
  voice profile (cosine similarity, threshold 0.8); fail-open everywhere;
  `similarityHistory`/`lastSimilarity` calibration telemetry. Pure helpers
  exported: `cosineSimilarity`, `isAgentVoice`.
- **`kaldi-fbank.js`** — kaldi-style fbank-80 feature extraction in pure JS
  (povey window, pre-emphasis, HTK-mel) + per-utterance CMVN (REQUIRED for
  voice separation — measured: 0.945 same-voice / 0.393 different-voice; raw
  fbank is useless). Shared by the browser gate and the offline profile
  builder.
- **`agent-voice-profile.json`** — the committed 3.7 KB profile (built from
  `demo/agent-voice-sample.wav` by
  `scripts/build-agent-voice-profile.mjs`; the MODEL is gitignored
  `/vendor/`).

## 9.12 `demo/` — the demo files

- **`index.html`** — the UI (Chapter 3) plus the two pinned CDN tags; the
  module script is cache-busted with a version query (`main.js?v=3`).
- **`main.js`** — **UI mapping only, no detection logic**: event → DOM
  mappings, mic toggle, background-sound playback, STT wiring, log; exposes
  `window.__sons` as a debug handle; releases mic + audio on `pagehide`.
- **`stt-stub-server.py`** — dev-only canned STT mockup ([§3.7](03-demo.md#37-the-python-script-what-it-does-and-what-it-does-not-do)).
- **`assets/`** — the five Pixabay ambient MP3s + `sources.md` (original
  filenames, lengths, license notes).

---

*Prev: [Chapter 8 — Architecture](08-architecture.md) · Next: [Chapter 10 — VAD engines](10-vad-engines.md)*
