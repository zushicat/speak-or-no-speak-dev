# Speak Or No Speak — Documentation

**Table of contents and documentation plan (rev-4).**

Speak Or No Speak is a browser JavaScript module that detects from a microphone
stream when the user **starts speaking** (S1), **finishes a turn** (S2), and
**barges in while the agent is answering** (S3) — built on Silero VAD +
adaptive endpointing + browser echo cancellation. The demo runs at
<http://localhost:5173/demo/>.

This file is the **master table of contents**. Each chapter below becomes one
individual markdown page in `docs/` (chapter number = file name prefix).
Subchapters live inside their chapter's file. The chapter pages themselves are
written in a follow-up step; this document fixes their structure first.

---

## How to read the documentation

| You want to … | Read |
|---|---|
| Understand what this is (and is not) | [1 Introduction](01-introduction.md) |
| Run the demo right now | [2 Getting started](02-getting-started.md) → [3 The demo page](03-demo.md) |
| Put the module into your own app | [4 Embedding](04-embedding.md) → [5 API reference](05-api-reference.md) |
| Build a voice agent (TTS + barge-in) | [6 Agent integration](06-agent-integration.md) |
| Understand how detection works under the hood | [7 Detection methods](07-detection-methods.md) → [8 Architecture](08-architecture.md) → [10 VAD engines](10-vad-engines.md) |
| Know why two CDN libraries are loaded separately | [11 Runtime libraries](11-runtime-libraries.md) |
| Tune thresholds or debug behavior | [14 Configuration & tuning](14-configuration-tuning.md) → [15 Troubleshooting](15-troubleshooting.md) |
| Work on the source code | [9 Source file guide](09-source-files.md) → [16 Build, test & publish](16-build-test-publish.md) |
| Learn why it was designed this way | [17 Background & decisions](17-background.md) |

---

## Chapter 1 — Introduction
*File: [01-introduction.md](01-introduction.md)*

1.1 **What is Speak Or No Speak?** — the one-paragraph picture: an embeddable,
on-device turn-detection module for browser voice agents; what "turn detection"
means (S1 speech onset · S2 turn end · S3 barge-in) and why a voice loop needs
all three.

1.2 **What it does** — the three detections in detail, with the latency and
reliability expectations for each (S1 ≤ ~300 ms feels instant; S2 must not cut
people off mid-sentence; S3 within ~100–250 ms of real speech), plus the
cross-cutting echo hazard (E1) and how it is handled.

1.3 **What it is NOT** — explicitly out of scope: no speech-to-text engine
(plug point only), no TTS/answer generation, no server/backend, no audio leaving
the device, no wake word / intent recognition, no mobile support in v1, not a
full dialogue manager.

1.4 **Design goals and constraints** — lightweight (≲ 10 MB assets), reliable in
noisy rooms, on-device (latency + privacy), event-based API (not raw
probabilities), zero-build source layout, graceful degradation instead of hard
failure.

1.5 **Where it fits in a voice-agent stack** — diagram of mic → this module →
STT plug point → your LLM/agent → your TTS playback → `setAgentSpeaking` back
into the module; what the module owns and what the app owns.

1.6 **Status, versioning, license** — v0.1.0 work in progress, MIT, project
layout conventions, where the planning documents live (`plans/`, not published).

## Chapter 2 — Getting started
*File: [02-getting-started.md](02-getting-started.md)*

2.1 **Requirements** — serving (Python 3 or Node + `npx serve`), Node ≥ 18 for
tests, current Chromium and/or Safari, and why a **secure context**
(`http://localhost` / `https`) is mandatory for microphone access (`file://`
never works).

2.2 **Starting the HTTP server** — `npm start` (python3 `http.server` on port
5173) and `npm run start:serve` (alternative); opening
<http://localhost:5173/demo/>.

2.3 **Optional: the Python STT stub server** — `python3 demo/stt-stub-server.py`
(port 5175); when you need it (testing the transcription plug point) and when
you can ignore it.

2.4 **First run walkthrough** — click **Start microphone**, allow the permission
prompt, speak; the orange/green indicator, the "listening / not listening"
label, the turn log line ("turn: 1.4 s").

2.5 **What you should see (and hear)** — expected event sequence for a normal
utterance; what counts as one turn; what happens when you stop speaking.

2.6 **Quick troubleshooting** — the four most common first-run failures
(mic-denied, insecure-context, cdn-unavailable, Safari start hang) and their
one-line fixes; full details in Chapter 15.

## Chapter 3 — The demo page
*File: [03-demo.md](03-demo.md)*

3.1 **Page anatomy** — every UI element of `demo/index.html`: indicator dot,
label, start/stop button, Smart Turn checkbox, error line, debug line,
background-sound row, STT row, event log.

3.2 **The listening indicator** — what the green/orange dot and the label map to
(`onSpeechStart` / `onTurnEnd`); interior pauses keep it green (the turn is
still open).

3.3 **Microphone start/stop toggle** — the button stays visible and toggles
`start()` / `stop()`; what stop releases; pagehide cleanup.

3.4 **Background sound row** — the five Pixabay ambient MP3s in
`demo/assets/` (with sources & license note), the volume slider, and the key
design point: background playback is deliberately **not** `setAgentSpeaking` —
it is supposed to reach the detector so noise robustness can be tested; because
it is `<audio>` in the same tab, AEC may partially cancel it.

3.5 **Smart Turn checkbox** — enabling the optional semantic end-of-turn model;
the ONNX session is cached across start/stop cycles.

3.6 **Transcription row & event log** — the "transcribe turns" toggle, the
endpoint field (default `http://localhost:5175/transcribe`), the timestamped
log; STT is wired fire-and-forget from `onTurnEnd` only.

3.7 **The Python script: what it does and what it does NOT do** —
`demo/stt-stub-server.py` is a **dev-only mockup**: it accepts a POST with a WAV
body, checks the `RIFF` magic, and returns a **canned** JSON response
(`"(stub) recognized turn audio"`, confidence 0.9) with CORS headers. It does
**not** run any speech recognition, it is not part of the package, and it never
touches detection.

3.8 **URL parameters** — `?noaec=1` forces `echoCancellation: false` to exercise
the no-AEC barge-in gating on any machine; when to use it.

3.9 **Suggested experiments** — speak over a playing background track, test
barge-in timing, compare AEC on/off, compare with/without Smart Turn, distance
from the mic.

## Chapter 4 — Embedding the module in your own app
*File: [04-embedding.md](04-embedding.md)*

4.1 **The integration modes at a glance** — zero-build source page, prebuilt ESM
bundle, prebuilt IIFE bundle (global), npm/bundler package; one API in all
modes; a comparison table (what you install, what you serve, when to choose it).

4.2 **Mode 1 — zero-build page (CDN `<script>` tags)** — the two pinned runtime
tags (`onnxruntime-web@1.22.0`, `@ricky0123/vad-web@0.0.31`) registering the
`ort` / `vad` globals, then importing `src/index.js`; the minimal working page.

4.3 **Mode 2 — prebuilt ESM bundle** — copying
`build/speak-or-no-speak.esm.js` (+ `.map`) next to your page, `import {
createSpeakOrNoSpeak } from "./speak-or-no-speak.esm.js"`; sizes, version
banner, sourcemaps.

4.4 **Mode 3 — prebuilt IIFE bundle** — classic `<script>` + the
`window.SpeakOrNoSpeak` global; for pages without module support.

4.5 **Mode 4 — npm / bundler** — `npm i speak-or-no-speak
@ricky0123/vad-web onnxruntime-web`; the adapter's library resolution order
(`window.vad` → dynamic `import("@ricky0123/vad-web")` → energy fallback).

4.6 **Using the ESM bundle inside Vite/webpack/esbuild** — the one bare dynamic
import in the bundle and how to treat it: mark `@ricky0123/vad-web` external
when CDN tags are present, or install the packages and let the bundler inline
it; what happens if you do neither (loud build error or energy fallback).

4.7 **Serving requirements** — secure context rules, CDN reachability, what
vad-web additionally fetches at runtime (Silero model, worklet, WASM binaries).

4.8 **Choosing a mode** — a short decision guide.

## Chapter 5 — API reference
*File: [05-api-reference.md](05-api-reference.md)*

5.1 **`createSpeakOrNoSpeak(options?)`** — async factory; does not touch the
microphone yet; rejects with `SpeakError` on fatal misconfiguration.

5.2 **Options** — `mic` (per-key merge over AEC defaults), `thresholds`,
`engine` / `energyEngine` (custom engines, what injecting one disables),
`turnModel`, `debug`, and the five event callbacks.

5.3 **Thresholds** — the full table: every key, its default, and its meaning
(`onsetSpeechThreshold` 0.6, `negativeSpeechThreshold` 0.35,
`onsetConfirmFrames` 9 ≈ 288 ms, `minSpeechMs` 250, `redemptionMs` 650 base,
`shortPauseMs` 250, `preSpeechPadMs` 200, `bargeInConfirmFrames` 6 ≈ 192 ms,
`maxTurnMs` 30000, `graceAfterInterruptMs` 500, `noAecBargeInConfirmMs` 300,
`noAecRmsFactor` 2, `modelTimeoutMs` 300); how frame counts relate to wall time.

5.4 **The facade members** — `start()` (resolves on first frame; may degrade
transparently), `stop()` (idempotent), `setAgentSpeaking(active)`, `state`
(`idle`/`ready`/`listening`), `degraded` (`{ aec, engine }`).

5.5 **Events & payloads** — `onSpeechStart` (S1), `onTurnEnd` with
`TurnEndEvent` (`audio` 16 kHz mono incl. pre-speech pad, `durationMs`,
`truncated`, `afterInterrupt`, `stats`), `onInterrupt` with `InterruptInfo`
(`atMs`, `latencyMs`), `onLevel` (~31 events/s), `onError` with `EngineError`.

5.6 **Error codes** — all nine stable codes, their class (fatal / warning /
runtime), both delivery paths (thrown `SpeakError` from `start()` and emitted
via `onError`), and `humanMessage(code)` for UI surfaces.

5.7 **All 16 exports** — the complete export surface of `src/index.js` /
the bundles, one-liner per export.

5.8 **Debug & advanced handles** — `_detector` (traces with `debug: true`),
`_engine` (`processorTypeUsed`), `window.__sons` in the demo; stability caveat.

## Chapter 6 — Agent integration: barge-in & echo
*File: [06-agent-integration.md](06-agent-integration.md)*

6.1 **Why barge-in is hard** — the echo hazard E1: the microphone hears the
system's own answer; the runaway feedback loop of naive voice bots.

6.2 **The `setAgentSpeaking` contract** — arm while your app produces audio,
disarm the moment it stops; what armed means for the detector.

6.3 **Behavior while the flag is armed** — no `onTurnEnd`, no `onSpeechStart`;
confirmed user speech triggers `onInterrupt` instead; turn accumulation
continues throughout; a redemption-eligible turn flushes at disarm.

6.4 **The interrupt event** — `atMs` (ms since armed) and `latencyMs`
(voice-onset → event ≈ the confirm window actually waited); expected latencies.

6.5 **The post-interrupt contract (five rules)** — cancel TTS/LLM immediately
(latency-sensitive path, await nothing first), disarm once output is really
stopped, the interrupting utterance arrives as the next `onTurnEnd` with
`afterInterrupt: true`, the 500 ms grace keeps "hey, sto—" one turn, and app
code must not depend on turn events while armed.

6.6 **Echo cancellation scope** — browser AEC cancels **only audio played by the
same browser tab** (TTS via `speechSynthesis`/`<audio>`/WebAudio); other apps'
audio (TV, music players) is only covered by the confirm-window gating.

6.7 **Without AEC — the stricter gating** — `no-aec` warning, `degraded.aec =
true`, ~300 ms confirm **and** frame rms > 2× the rolling agent-playback mean
rms (TTS-leakage guard); recommendations (headphones, surface the flag in UI).

6.8 **A complete agent loop** — worked example wiring `onInterrupt` → cancel
stream → `setAgentSpeaking(false)` → next turn.

6.9 **Common pitfalls** — forgetting to disarm (permanently silences turn
detection), relying on turn events during agent speech, treating interrupts as
turn ends.

## Chapter 7 — How detection works: the methods
*File: [07-detection-methods.md](07-detection-methods.md)*

7.1 **The problem decomposition** — S1/S2/S3 plus the E1 echo hazard; why one
problem is really four; latency budgets and failure modes per sub-problem.

7.2 **Frames and speech probability** — 16 kHz mono, 512-sample frames = 32 ms
(Silero v5), the per-frame `VadFrame` (`probability`, `frame`, `rms`,
`durationMs`), ~31 frames/s.

7.3 **Hysteresis: two thresholds** — onset 0.6 / negative 0.35 and why a single
threshold flickers; "mid" frames are hysteresis, not events.

7.4 **Onset confirmation** — 9 consecutive above-onset frames ≈ 288 ms before
`onSpeechStart`; why the window exists (clicks, coughs, keyboard clatter).

7.5 **The state machine** — one state (`ready` / `listening` / `pause`) × one
boolean (`agentSpeaking`); the full behavior matrix; `pause` is a sub-state of
listening, not a state of its own.

7.6 **Turn endpointing: the redemption window** — the classic fixed-timeout
trap; the base 650 ms redemption; what "redemption" means.

7.7 **Adaptive redemption (`redemptionFor`)** — patient when the user hesitates,
snappy when they are fluent: fluent long turns → −200 ms, hesitant turns (≥ 2
interior pauses or < 600 ms speech) → +200 ms, long pauses ≥ 800 ms → +250 ms,
clamped to 350–1200 ms; the rhythm stats that drive it (`speechMs`,
`interiorPauses`, `longestPauseMs`).

7.8 **Interior pauses** — `shortPauseMs` 250 opens the PAUSE sub-state; pauses
shorter than redemption never end a turn ("let me think … okay" stays one turn).

7.9 **Turn boundaries and guards** — `minSpeechMs` (discard coughs/clicks) and
the D-WP3-1 subtlety that confirm-window speech **counts** as speech (why short
real commands like "one" are not discarded), the pre-speech pad (`preSpeechPadMs`
200, ring buffer, never clips word onsets), and `maxTurnMs` 30000 force-end with
`truncated: true`.

7.10 **Barge-in confirmation and grace** — the 6-frame ≈ 192 ms confirm while
the agent speaks, the 500 ms `graceAfterInterruptMs` that keeps silence from
slicing the interrupting utterance, and why an interrupt never emits
`onSpeechStart` (it *is* the onset).

7.11 **Worked examples** — trace-throughs: a fluent command; a hesitant
"um … let me think … go now"; a barge-in "hey, stop"; a cough; a 35 s monologue.

7.12 **What the turn audio contains** — pad + accumulated frames as one
`Float32Array`, `durationMs` from sample count, WAV export
(`encodeWav`/`encodeWavBytes`) for saving/replay/STT.

## Chapter 8 — Architecture
*File: [08-architecture.md](08-architecture.md)*

8.1 **Component map** — the explorable architecture app
([`docs/archify/speak-or-no-speak.architecture.html`](archify/speak-or-no-speak.architecture.html),
opens as a plain webapp, no server needed) and the screenshot
([`plans/rev-4/assets/speak-or-no-speak-browser-turn-detection.png`](../plans/rev-4/assets/speak-or-no-speak-browser-turn-detection.png)):
User → Microphone → SileroVadAdapter → TurnDetector → events → Demo page; CDN,
SmartTurnModel, STT endpoint.

8.2 **End-to-end data flow** — `getUserMedia` (AEC/NS/AGC constraints) →
vad-web capture (worklet or ScriptProcessor, resampled to 16 kHz) → 32 ms
frames → `TurnDetector.onFrame` → state machine → `onSpeechStart` /
`onTurnEnd` / `onInterrupt` → demo DOM.

8.3 **The engine abstraction** — the `VadEngine` interface (`start`/`stop`/
`pause`/`resume`/`onFrame`/`onError`); engines emit frames, never decide turns;
Node-importable by contract (no top-level `window`).

8.4 **The facade wiring** — how `createSpeakOrNoSpeak` merges options,
constructs engine + detector, wires the frame stream, and implements the
degradation ladder on `start()`.

8.5 **A pure state machine on purpose** — no `window`/`document` access, timing
from audio time (`durationMs`), unit-testable in Node with recorded fixtures.

8.6 **The audio capture pipeline** — mic track settings, the AEC constraint
check (`micSettings.echoCancellation`), the AudioWorklet vs ScriptProcessor
paths, sample-rate handling.

8.7 **Threading model** — why main-thread inference is fine (measured: p50 ≈
0 ms, p95 0.3 ms, max 3.9 ms per frame against an 8 ms budget), frame
burstiness and why it does not matter (audio-time-based timing), and the
worker contingency recipe if a target machine ever exceeds the budget
(includes the SharedArrayBuffer / cross-origin-isolation caveats).

8.8 **Design decisions and their reasons** — a summary table of the notable
"why" choices (own state machine instead of vad-web's `onSpeechEnd`
segmentation; frames buffered by the detector; energy fallback instead of hard
failure; fail-open turn model; STT strictly outside the loop).

## Chapter 9 — Source file guide
*File: [09-source-files.md](09-source-files.md)*

What each individual JavaScript file in `src/` actually does — per file:
purpose, key exports/functions, and what it deliberately does **not** do.

9.1 **Repository layout and the zero-build philosophy** — no bundler, no
TypeScript compile; plain ES modules from a static server; runtime libraries
pinned via CDN tags; where tests/plans/build live.

9.2 **`src/index.js` — the public export surface** — the only module consumers
should import; the 16 named exports and their grouping.

9.3 **`src/speak-or-no-speak.js` — the facade** — `createSpeakOrNoSpeak`: option
merging, engine construction, frame wiring, the degradation ladder on `start()`,
`setAgentSpeaking`, `state`/`degraded` getters; the agent-speaking contract in
its header comment.

9.4 **`src/config.js` — defaults and option merging** — `DEFAULTS` (every value
traceable to a plan decision) and `mergeOptions` (recursive plain-object merge,
everything else replaces; inputs not mutated; Node-safe).

9.5 **`src/errors.js` — the error taxonomy** — `ERROR_CODES` (9 stable codes),
`SpeakError` (Error subclass with `.code`), `humanMessage` (UI-ready sentences);
codes are the contract, messages are prose.

9.6 **`src/types.js` — the typed contract** — JSDoc `@typedef`s only (no TS
compile): `VadFrame`, `TurnEndEvent`, `InterruptInfo`, `EngineError`,
`ModuleState`, `Thresholds`, `TurnModel`, options, facade.

9.7 **`src/wav-export.js` — WAV encoding** — `encodeWavBytes` (44-byte RIFF
header + 16-bit PCM, clamped, little-endian) and `encodeWav` (Blob in browser /
Buffer in Node); why it lives in `src/` and not `test/util/`.

9.8 **`src/vad/` — the engines** —
`vad-engine.js` (the interface + `VadFrame` contract),
`silero-vad-adapter.js` (detailed in Chapter 10),
`energy-vad.js` (detailed in Chapter 10).

9.9 **`src/turn/` — the detection core** —
`turn-detector.js` (the state machine, `redemptionFor`, the rms baseline, the
turn-model gate, debug traces),
`ring-buffer.js` (fixed-capacity pre-speech pad; capacity =
`preSpeechPadMs + onsetConfirmFrames × frameDuration`).

9.10 **`src/turn-model/` — the semantic model** —
`smart-turn.js` (`SmartTurnModel`: lazy ORT session, `predictComplete`,
threshold 0.5),
`whisper-features.js` (Whisper log-mel features in pure JS — pad/truncate 8 s,
zero-mean/unit-var, Hann window, Bluestein rfft(400), slaney mel, normalization;
parity-verified vs the Python reference).

9.11 **`src/stt/` — the transcription plug point** —
`stt-adapter.js` (the `SttAdapter` interface and the hard rule),
`cloud-stub-adapter.js` (the ~50-line example: WAV POST → `{text,
confidence}`).

9.12 **`demo/` — the demo files** — `index.html` (UI + pinned CDN tags),
`main.js` (UI mapping only, no detection logic), `stt-stub-server.py` (dev
mockup), `assets/` (ambient MP3s + sources).

## Chapter 10 — The VAD engines
*File: [10-vad-engines.md](10-vad-engines.md)*

10.1 **Silero VAD v5 — why this engine** — the de-facto open VAD (~2 MB, MIT,
< 1 ms per chunk on one thread, noise-robust); what a VAD can and cannot know
(acoustics, not language).

10.2 **vad-web's role and the adapter's dual-mode resolution** — what
`@ricky0123/vad-web` provides (mic capture, worklet/ScriptProcessor
segmentation, model loading, ORT wiring); resolution order `window.vad` →
dynamic npm import → `cdn-unavailable`; why `window.vad` is read in exactly one
choke point.

10.3 **Runtime-verified vad-web findings** — the `stream` option does not exist
(`getStream` override instead), `frameSamples` is accepted but ignored for
MicVAD (frame size is model-derived: 512 samples = 32 ms), `model: "v5"` must be
passed explicitly (0.0.31 default is "legacy"), frame param verified provided;
how these findings changed the plan (threshold recalibration 96 ms → 32 ms).

10.4 **The AudioWorklet hang and the ScriptProcessor fallback** — the observed
`addModule` hang (automation Chromium, old Safari, webviews), the 8 s timeout
guard, the retry with `processorType: "ScriptProcessor"`, and
`processorTypeUsed`.

10.5 **`EnergyVad` — the degraded fallback** — same `VadEngine` interface, pure
signal processing: worklet-free ScriptProcessor(4096) pipeline, rate-adaptive
downsampling to 16 kHz, 512-sample frames.

10.6 **The energy probability model** — `noiseFloor` min-tracker (slow rise
×1.0005, fast drop), `clamp((rms − 3.2·floor) / (3.2·floor))`, absolute floor
0.005; why this mode is noise-blind by design and always flagged
(`degraded.engine = "energy"`).

10.7 **Custom engines** — injecting `engine`/`energyEngine`, what the facade
does and does not fall back to then, the contract your engine must fulfill.

## Chapter 11 — The external runtime libraries
*File: [11-runtime-libraries.md](11-runtime-libraries.md)*

11.1 **`onnxruntime-web` — what it is and what it is for here** — the ONNX
Runtime Web WASM build (`ort.wasm.min.js`, pinned 1.22.0); it runs the Silero
VAD ONNX model and (optionally) the Smart Turn model; registers the `ort`
global.

11.2 **`vad-web` — what it is and what it is for here** —
`@ricky0123/vad-web` 0.0.31; the mic-capture + segmentation wrapper around
Silero (worklet/ScriptProcessor, resampling, model + worklet asset loading);
registers the `vad` global.

11.3 **Why neither is included in the bundle** — the bundle contains only this
project's code by design: both libraries are runtime *assets* (multi-MB WASM
binaries + ONNX model weights + a worklet file) rather than plain JS, they are
version-pinned independent of this project, shipping them would multiply bundle
size and license surface, the CDN tags allow browser caching (immutable, one
year) shared across sites, and the adapter degrades gracefully if they cannot be
loaded — the energy fallback keeps the page working.

11.4 **What the browser fetches at runtime** — the two pinned `<script>` tags,
then vad-web's own fetches (`silero_vad_v5.onnx`, the worklet, ORT WASM
binaries) from the pinned jsDelivr dist paths; which paths are pinned inside the
adapter.

11.5 **Offline and blocked-CDN operation** — after the first successful load the
cache covers offline use; at load time a blocked CDN means `cdn-unavailable` →
energy fallback (events keep flowing, `degraded.engine = "energy"`); serving a
local mirror from `/vendor/` (download the JS, ONNX, WASM and `.mjs` assets and
point the tags and `baseAssetPath`/`onnxWASMBasePath` at local paths).

11.6 **Upgrading the pins** — keep the versions in the demo tags, the READMEs
and the adapter's asset-path constants in sync; what changes between vad-web
releases.

## Chapter 12 — Smart Turn: the optional end-of-turn model
*File: [12-smart-turn.md](12-smart-turn.md)*

12.1 **What it is and where it comes from** — Pipecat's Smart Turn v3.2
(BSD-2): an 8 MB int8 ONNX model with a Whisper-Tiny backbone that judges
whether an utterance is **semantically complete**; the gap it fills (the VAD
knows acoustics, not language).

12.2 **When it runs and fail-open semantics** — consulted **only at silence
points** (redemption reached → evaluate → complete? emit : continue);
fail-open on error, load failure, or the 300 ms `modelTimeoutMs` — the model can
only *hold* a turn, never lose one; new speech cancels a pending evaluation and
the next redemption re-runs it on the whole turn.

12.3 **The feature pipeline** — turn audio (16 kHz mono) → pad/truncate to 8 s
(left-pad) → zero-mean/unit-variance → Whisper log-mel `[80, 800]`
(`whisper-features.js`, replicating `WhisperFeatureExtractor(chunk_length=8)`
exactly; Bluestein chirp-z rfft(400) in float64; allocation-free cached buffers)
→ ORT inference → sigmoid > 0.5 → complete; parity-verified vs the Python
reference (max abs diff 8.8e-6).

12.4 **Setup** — the weights are **not** in the repo and not in the bundle
(`vendor/` is gitignored): one manual download of
`smart-turn-v3.2-cpu.onnx` to `/vendor/` (or any URL/modelUrl); requires the
onnxruntime-web CDN tag (or a passed `ort` namespace); the demo checkbox.

12.5 **Measured performance** — lazy session init ~120 ms local; inference p50
≈ 141 ms single-threaded WASM (47.6 ms threaded with COOP/COEP headers);
feature extraction ~25 ms warm; the no-headers default and its borderline
budget.

12.6 **When to use it and when not** — the WP6 evidence (hesitant speech is
where the silence-only baseline splits turns); opt-in by design; interaction
with the adaptive redemption window.

## Chapter 13 — Transcription plug point (STT)
*File: [13-transcription.md](13-transcription.md)*

13.1 **The hard rule** — STT lives **strictly outside the real-time loop**:
adapters are called only with `onTurnEnd` audio (16 kHz mono, incl. pre-speech
pad), never with live frames; an adapter failure must never affect
`onSpeechStart`/`onTurnEnd`/`onInterrupt` — wrap at your level.

13.2 **The `SttAdapter` interface** — `async transcribe(audio, { language }) →
{ text, confidence? }`; the module ships no STT engine.

13.3 **`CloudStubAdapter` — the shipped example** — POSTs the turn as a 16-bit
PCM WAV body (built with `encodeWav`) to a configurable endpoint, expects
`{ text, confidence? }` JSON back; optional `Authorization: Bearer` token and
`X-Language` header; dev example by design.

13.4 **The Web Speech API alternative** — zero-backend option: run
`SpeechRecognition` in parallel and harvest the final result matching the turn
window; Chromium-only, server-backed (not Baseline), audio leaves the machine
(privacy caveat), but zero audio plumbing — a prototyping shortcut.

13.5 **Writing your own adapter** — implementing `SttAdapter` for any backend
(Whisper server, managed STT API), wiring it in `onTurnEnd`, error handling
patterns from the demo.

13.6 **Privacy and security notes** — the module itself sends nothing anywhere;
your adapter may: keep tokens in your configuration (never hardcoded), prefer a
server-side proxy for credentials, and tell users where audio goes.

## Chapter 14 — Configuration & tuning
*File: [14-configuration-tuning.md](14-configuration-tuning.md)*

14.1 **Options and how merging works** — `mergeOptions` semantics: plain
objects merge per key, everything else replaces; `mic: { echoCancellation:
false }` disables only AEC; `undefined` keeps the default.

14.2 **Every threshold explained** — the rationale behind each default
(Chapter 5 has the table; this is the why), including which thresholds interact
(onset vs confirm, shortPause vs redemption, confirm vs grace).

14.3 **The 32 ms recalibration story** — the plan originally assumed 96 ms
frames (1536 samples); Silero v5 delivers 512 samples = 32 ms, so all
frame-count thresholds were recomputed to the same wall-clock windows
(D-WP1-1); a warning for anyone changing `onsetConfirmFrames` /
`bargeInConfirmFrames`.

14.4 **Tuning recipes** — noisy room, fast dialogue, slow thinkers, game-avatar
use case, kiosk: which knobs to move first and what to watch
(`degraded`, `stats` on `TurnEndEvent`, debug traces).

14.5 **Surfacing degraded flags in your UI** — `degraded.aec` and
`degraded.engine`, the matching `no-aec` / `engine-fallback` warnings, and why
the module never degrades silently.

14.6 **Debug traces** — `debug: true` records state-transition traces
(`onSpeechStart`, `enterPause`, `onInterrupt` + latency, `model-eval-*`,
`turn-discarded`, …) on `_detector.traces` (last 100, with `audioMs` timeline).

## Chapter 15 — Degradation & troubleshooting
*File: [15-troubleshooting.md](15-troubleshooting.md)*

15.1 **The degradation ladder** — automatic, always flagged, never silent:
Silero fails to load → energy engine (one-time `engine-fallback` +
`degraded.engine`); mic track without AEC → stricter gating (`no-aec` +
`degraded.aec`); turn model fails → fail-open turn end.

15.2 **Error codes reference** — the nine codes with class and consequence,
both delivery paths, and `humanMessage` text.

15.3 **Symptom → fix table** — `insecure-context`, `mic-denied`,
`mic-not-found`, `cdn-unavailable`, `vad-no-frames`, `no-aec`, false interrupts
from loud speakers, Safari hang at start, stale demo module cache.

15.4 **Browser quirks and platform notes** — Safari AudioWorklet hang →
ScriptProcessor retry; mic needs a user gesture (call `start()` from a click);
TTS `speechSynthesis` quirks are app-side; iOS Safari unverified, mobile out of
scope for v1.

15.5 **Known limitations** — AEC scope (same-tab only), energy fallback
noise-blindness, single-threaded WASM budget, pinned CDN dependency, and the
things explicitly not solved in v1 (semantic "is this speech directed at me?"
filtering).

## Chapter 16 — Build, test & publish
*File: [16-build-test-publish.md](16-build-test-publish.md)*

16.1 **The bundle artifacts** — `build/speak-or-no-speak.esm.js` (25.1 KB) and
`.iife.js` (26.0 KB) + sourcemaps; minified builds of `src/index.js` with all 16
exports preserved, API-identical to the source; the version banner.

16.2 **The build script** — `scripts/build-bundle.mjs`: esbuild, ESM + IIFE
targets, sourcemaps, banner injection, idempotent byte-identical output, and the
loud failure if a new bare import appears in `src/` without being accounted for
(dependencies are never silently dropped).

16.3 **Rebuilding** — `npm run build:bundle` (minified default),
`-- --no-minify` for readable debugging output; `test/bundle-verify.html` as the
worked example covering all three load modes (Node import smoke + live browser
check).

16.4 **Unit tests** — `node --test`, zero test dependencies; what each suite
covers (`config`, `facade`, `ring-buffer`, `turn-detector`, `wp4-endpointing`,
`wp5-barge-in`, `wp7-hardening`, `wp8-turn-model`, `wp9-stt`,
`util/wav-export`) and the Node-importability contract they enforce.

16.5 **The replay harness and calibration recordings** — `test/harness.html` +
`harness-main.js` + `harness/replay.js`; the `test/recordings/` fixture set
(s1-short-commands, s2-fluent, s3-hesitant, s5-music-synth, s6-typing-synth,
s7-agent-noise, s8-speak-over-agent, s9-distance-2m) and how scenario replay
drives threshold decisions; `test/spike-smart-turn.html` (WP8 spike).

16.6 **Publishing** — the `files` field (recordings and `vendor/` excluded),
`npm publish --dry-run` to verify the list, then `npm publish` (ESM-only).

## Chapter 17 — Background & decision history
*File: [17-background.md](17-background.md)*

17.1 **The initial problem analysis** — recap of
`plans/initial/problem-analysis-initial.md`: the four sub-problems, the
non-functional requirements, and the evaluation criteria (reliability 25 %,
latency 20 %, footprint 15 %, …).

17.2 **The candidate solutions (A–H) and their scores** — energy VAD, Silero via
vad-web, Web Speech API, full local STT pipeline, cloud streaming STT, the
hybrid (winner), TF.js audio models, commercial VADs; the general-score vs
full-problem-fit trap.

17.3 **Why the hybrid architecture won** — score ≈ 4.3 with high full-problem
fit; how every rejected option survives as a piece of the final design (energy
VAD = fallback, cloud STT = plug point, semantic end-of-turn = optional model).

17.4 **Work packages WP0–WP9** — what each delivered (scaffolding, VAD engine
integration, demo indicator, facade + state machine, endpointing + buffering,
barge-in + echo, calibration harness, hardening + packaging, Smart Turn
experiment, STT plug point), with the key deviations/decisions
(D-WP1-1 frame recalibration, D-WP3-1 confirm-speech counting, the WP8 GO gate).

17.5 **Revision history** — rev-2: the single-file bundle (WP-B1);
rev-3: persistent mic toggle + background sounds on the demo page;
rev-4: this documentation.

17.6 **References and further reading** — Silero VAD, vad-web docs, ONNX
Runtime Web, Smart Turn, MDN SpeechRecognition, architecture precedents
(LiveKit Agents, Pipecat, Vocode), whisper.cpp / Moonshine, Picovoice Cobra.

## Appendix A — Glossary
*File: [appendix-a-glossary.md](appendix-a-glossary.md)*

The vocabulary used throughout: VAD, endpointing, turn, barge-in, hysteresis,
onset, redemption, echo cancellation (AEC), RMS, noise floor, Silero, ONNX,
ONNX Runtime Web, WASM, AudioWorklet, ScriptProcessor, ESM/IIFE, secure
context, `getUserMedia`, sub-problem labels S1/S2/S3/E1, work-package labels
WP0–WP9, degradation ladder, fail-open.

---

## Coverage map — where the existing material lands

Every fact in the current READMEs and planning documents has a home in the
chapters above (nothing gets dropped when the chapter pages are written):

| Existing source | Feeds chapters |
|---|---|
| [`README.md`](../README.md) (run demo, layout, embedding modes, STT, agent integration, AEC scope, limitations) | 1, 2, 3, 4, 5, 6, 13, 15 |
| [`README-advanced.md`](../README-advanced.md) (main-thread budget, worker recipe, publishing, offline/CDN) | 8, 11, 15, 16 |
| [`README-BUNDLE.md`](../README-BUNDLE.md) (bundle quick starts, API/thresholds/events/errors/exports, bundler integration, Smart Turn, degradation) | 4, 5, 6, 12, 13, 14, 15, 16 |
| [`plans/initial/problem-analysis-initial.md`](../plans/initial/problem-analysis-initial.md) (method comparison, recommended architecture) | 1, 7, 8, 17 |
| [`plans/initial/` work packages + `wp8-decision.md`](../plans/initial/wp8-decision.md) | 9, 10, 12, 17 |
| [`src/` sources (module doc comments)](../src/index.js) | 5, 7, 9, 10, 12, 13 |
| [`demo/` (index.html, main.js, stt-stub-server.py, assets)](../demo/index.html) | 3, 9 |
| [`docs/archify/speak-or-no-speak.architecture.html`](archify/speak-or-no-speak.architecture.html) (explorable architecture webapp) | 8 |
| [`plans/rev-4/assets/speak-or-no-speak-browser-turn-detection.png`](../plans/rev-4/assets/speak-or-no-speak-browser-turn-detection.png) (architecture screenshot) | 8 |

## Notes for the writing step

- One file per chapter, named exactly as linked above; subchapters are `##`
  sections (or `###` where a chapter file groups directory-level sections).
- Audience: app developers embedding the module; assume web-platform basics,
  explain voice-processing terms on first use (full glossary in Appendix A).
- Code samples copy from the READMEs and adapt to the bundle/source modes;
  each chapter cross-links related chapters instead of repeating reference
  tables (API reference is the single source for options/events/errors).
