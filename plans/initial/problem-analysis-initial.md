# Problem Analysis: Speak Or No Speak

- **Date:** 2026-10-20
- **Status:** Initial analysis (exploration phase, per [initial.md](initial.md))
- **Input:** [initial.md](initial.md) — a lightweight but reliable JavaScript module that detects (1) when the user starts speaking, (2) when the user has finished a sentence, and (3) when the user interrupts the system while it is "answering", e.g. to control a game avatar or chatbot by voice.

---

## 1. Problem decomposition

"Speak or no speak" sounds like one problem, but it is actually **three distinct detection problems plus one cross-cutting hazard**. Any candidate solution must be judged per sub-problem, not as a monolith.

### S1 — Speech onset ("the user starts talking")
Detect the transition from silence → speech, fast enough that the system feels responsive. Latency budget: **≤ 300 ms** feels instant; > 500 ms feels laggy.

### S2 — Turn end ("the sentence is done")
Decide the user has finished their utterance, so the action can start. This is the classic **endpointing** problem. It is *harder* than it looks:
- Pauses mid-sentence ("let me think… okay") must **not** trigger the action.
- "Um, I can't seem to, um…" — trailing fillers mean "not done".
- A fixed silence timeout (e.g. 700 ms) is the naive answer; it either feels slow (long timeout) or cuts people off (short timeout).

### S3 — Barge-in ("the user speaks again while the system is answering")
While the chatbot/agent is producing output (e.g. speaking via TTS), the microphone must keep listening and raise an `interrupt` event within **~100–250 ms** of real user speech.

### E1 — Echo (cross-cutting hazard for S3)
When the system answers through loudspeakers, the microphone hears the system's own voice. Without echo handling, every answer the system speaks **re-triggers the detector** — the classic runaway feedback loop of half-baked voice bots. This is the single most common reason naive implementations fail, and it must be part of the design, not an afterthought.

### Non-functional requirements (from initial.md)
| Requirement | Implication |
|---|---|
| Lightweight | Model/assets ideally ≲ 10 MB, CPU use low enough to coexist with a game/LLM app |
| Reliable | Must survive real environments: background noise, TV, music, keyboard clatter |
| JavaScript module | Runs in browser (primary) or Node; usable as a library, not a service |
| Action-triggering | Must emit discrete events (start / end / interrupt), not just raw probabilities |
| Game-avatar / chatbot use case | On-device processing strongly preferred (latency, privacy, no per-minute cost) |

---

## 2. Evaluation criteria

Solutions are scored 1–5 per criterion; the weighted total is out of 5.

| Criterion | Weight | Why it matters here |
|---|---|---|
| Reliability / noise robustness | 25 % | The explicit requirement; failure mode is wrong actions |
| Latency (onset + barge-in reaction) | 20 % | Voice interaction feels broken when slow |
| Footprint (assets, CPU/RAM) | 15 % | "Lightweight" is explicit |
| Privacy / on-device | 10 % | A module others embed should not leak audio by default |
| Browser support / standards | 10 % | JS module → must work across modern browsers |
| Integration effort | 10 % | Complexity of building + tuning it |
| Cost | 5 % | Runtime cost per user/minute |
| Content availability (text) | 5 % | Nice-to-have; the core problem is detection, not transcription |

Two verdicts are reported per solution:
- **Score** — weighted general quality.
- **Full-problem fit** — does it actually cover S1, S2, S3 and E1? A high score on the wrong problem is still the wrong answer.

---

## 3. Candidate solutions

### A. Energy-based VAD (Web Audio API, pure JS)

**What:** Classic signal-processing VAD. An `AnalyserNode`/`AudioWorklet` computes RMS loudness + zero-crossing rate per frame; an adaptive noise floor (running minimum) and a hysteresis threshold classify speech vs. silence, with a hangover timer for S2.

**Strengths**
- Truly zero dependencies, a few KB of code, runs everywhere, no model download.
- Zero latency beyond frame size; trivially explainable and tunable.
- Great as a *level meter* and as a cheap fallback (e.g. "definitely loud sound").

**Weaknesses**
- **Cannot distinguish speech from noise.** Music, TV, keyboard, door slams, a fan spinning up — all "speech". This is fatal for reliability in real rooms, and catastrophic for S3 (the system interrupting itself on its own TTS or any noise).
- Requires constant per-environment threshold tuning; no model means no generalization.
- No notion of turn completion beyond crude silence timers.

**Rating:** Reliability 2 · Latency 4 · Footprint 5 · Privacy 5 · Support 5 · Integration 5 · Cost 5 · Content 1 → **Score ≈ 3.9, full-problem fit: Low**

**Verdict:** Keep as a secondary signal (pre-filter, indicator UI, fallback when the model fails to load), not as the detector. Fails the stated "reliable" requirement.

---

### B. Silero VAD in the browser (`@ricky0123/vad-web` + ONNX Runtime Web) ⭐ core building block

**What:** [Silero VAD](https://github.com/snakers4/silero-vad) is the de-facto industry-standard open VAD: a ~2 MB neural model (MIT license) trained on massive multilingual corpora, **< 1 ms per 30 ms audio chunk on a single CPU thread**, robust to noise, 8 kHz/16 kHz. [`@ricky0123/vad-web`](https://github.com/ricky0123/vad) packages it for the browser on top of ONNX Runtime Web with a clean callback API:

```js
const myvad = await vad.MicVAD.new({
  onSpeechStart: () => { /* S1 */ },
  onSpeechEnd: (audio) => { /* Float32Array @16 kHz — S2 (timeout-based) */ },
});
myvad.start();
```

**Strengths**
- Best reliability-per-megabyte of any option: excellent noise robustness for ~2 MB of model.
- Frame-level speech probability is exposed, so custom logic (S3 gating, adaptive thresholds) can be built on top rather than fought.
- Fully on-device, no network, no keys, MIT — ideal for an embeddable module.
- Battle-tested: it is the VAD underneath LiveKit Agents, Pipecat and many production voice bots.
- Latency is small: vad-web's default frames are ~96 ms (Silero v5 itself accepts 512-sample ≈ 32 ms frames if you integrate the ONNX directly), so onset detection in **~100–300 ms** is realistic.

**Weaknesses**
- VAD knows *acoustics*, not *language*: it cannot tell "sentence done" from "thinking pause" — S2 gets only a silence timeout (vad-web's redemption window is configurable, roughly 500–900 ms works for most people).
- Barge-in (S3) is *possible but DIY*: you must keep the VAD running during agent speech, apply your own short confirmation window, and solve echo (E1) yourself — see §5.
- Adds asset weight: ~2 MB model + ONNX Runtime Web WASM (a few MB, cached after first load).
- Needs mic permission, HTTPS (or localhost), and some care to run inference off the main thread.

**Rating:** Reliability 4.5 · Latency 4 · Footprint 4 · Privacy 5 · Support 5 · Integration 4 · Cost 5 · Content 1 → **Score ≈ 4.2, full-problem fit: Medium** (S1 ✓, S2 timeout-only, S3 DIY, E1 DIY)

**Verdict:** The right *engine* for S1 and the audio core of S3. Not a complete solution alone — it is the foundation the recommended architecture (§5) is built on.

---

### C. Web Speech API (`SpeechRecognition`)

**What:** The browser's built-in recognizer. `onresult` / `onstart` / `onend` events can be (ab)used as speech activity + content in one. Zero download.

**Strengths**
- Zero footprint, zero models, gives *text* for free (interim results even give partial hypotheses usable for S2 heuristics).
- Trivial to prototype.

**Weaknesses**
- **Not Baseline** (MDN flags "limited availability"): no Firefox support, uneven behavior across Chromium/Safari.
- In Chrome the engine is **server-backed** — audio leaves the device, it does not work offline, and there is no SLA or control over the service. Unacceptable for an embeddable privacy-respecting module.
- The engine owns segmentation: `onend` fires at unpredictable times, recognition stops on its own and needs restart loops, and its idea of "sentence end" is coupled to its transcription timeouts — poor match for S2.
- **Barge-in while TTS plays is effectively broken:** the recognizer hears the system's own speech and there is no way to exclude it; you get self-interruption loops or a forced half-duplex flow.
- Rate limits and network hiccups make it unreliable as a real-time control loop.

**Rating:** Reliability 2 · Latency 2.5 · Footprint 5 · Privacy 1 · Support 2 · Integration 4 · Cost 5 · Content 5 → **Score ≈ 3.0, full-problem fit: Low**

**Verdict:** Fine as an opportunistic *content* source in Chromium-only environments; unusable as the detection backbone for a reliable module.

---

### D. Full local pipeline: local streaming STT + end-of-turn logic

**What:** The user's own suggestion in initial.md, taken fully local: run a speech-to-text model in-browser (whisper.cpp compiled to WASM; or an edge-optimized ASR like Moonshine), then a "decision" step that decides the sentence is complete.

**Strengths**
- Text content unlocks *semantic* end-of-turn detection: "book a table for—" is detectably unfinished from words alone; a small classifier or an LLM judge can score completeness.
- Fully on-device, no cloud, no per-minute cost; one dependency chain serves both detection and transcription.

**Weaknesses**
- **Weight is the opposite of "lightweight":** even the smallest Whisper-tier models are tens of MB in WASM with heavy CPU use (streaming Whisper in-browser is typically chunked at ~1 s with noticeable lag); Moonshine-style edge ASR is better but still far heavier than Silero.
- Latency: ASR lag directly delays S2/S3 decisions; local STT is the wrong tool for the *fast* problems (S1, S3).
- In Node/server the weight problem eases, but then every detection decision crosses the network — hurting exactly the low-latency paths.
- The "decision model on text" adds a second model to host and tune.

**Rating:** Reliability 4.5 · Latency 2 · Footprint 1 · Privacy 5 · Support 3 · Integration 2 · Cost 5 · Content 5 → **Score ≈ 3.2, full-problem fit: Medium-High (but violates "lightweight")**

**Verdict:** Right idea, wrong layer. The insight survives in the recommended architecture, but *demoted*: STT/semantic checks belong at the **end of a turn** (post-hoc, batch, cheap), not in the real-time loop. A purpose-built end-of-turn model (see F) achieves most of the semantic benefit at ~1/10 the weight.

---

### E. Cloud streaming STT with provider endpointing

**What:** Stream mic audio to a streaming ASR service (Deepgram, AssemblyAI, Azure, Google, …). These services expose built-in endpointing, including *semantic* endpointing on premium tiers, plus interim results. Pair with a local VAD for barge-in.

**Strengths**
- Highest transcription quality and mature turn-end heuristics out of the box — S2 handled well, including semantics.
- Tiny local footprint; no model management.

**Weaknesses**
- **Cannot solve S1/S3 by itself:** network round-trips (150–400 ms+) make cloud the *slowest* possible path for onset and barge-in. Any real design still needs a local VAD (i.e. solution B) — so E is additive, not alternative.
- Privacy: continuous audio upload. Cost: per-minute pricing that scales with users. Offline: none. These clash with "embeddable module".

**Rating:** Reliability 4.5 · Latency 3 · Footprint 4 · Privacy 1 · Support 4 · Integration 3 · Cost 2 · Content 5 → **Score ≈ 3.5, full-problem fit: Medium**

**Verdict:** A good *later* upgrade for content quality (and semantic endpointing), layered on top of the local architecture — not the foundation.

---

### F. Hybrid local pipeline: Silero VAD + adaptive endpointing + optional end-of-turn model + browser AEC ⭐ recommended

**What:** The architecture used in production voice-agent frameworks (LiveKit Agents, Pipecat, Vocode), assembled as a small self-contained module:

1. **One mic stream with browser echo cancellation** — `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`. Chrome's AEC cancels audio *the browser itself plays* (TTS via audio element/WebAudio), which neutralizes hazard E1 for the common case.
2. **Silero VAD via ONNX Runtime Web in a Web Worker** (WASM SIMD; optional WebGPU), frame-level speech probability at 32–96 ms granularity → S1 and the S3 trigger, ~100–150 ms interrupt latency.
3. **Turn-end state machine (S2):** silence window with adaptive length (shorter after confident fluent speech, longer after fillers/hesitation), plus an optional **end-of-turn model** — e.g. [Smart Turn v3.2](https://github.com/pipecat-ai/smart-turn) (open source, BSD-2, Whisper-Tiny-based, ~8 M params, **8 MB int8**, 23 languages, ~10–100 ms inference, explicitly designed to run *only* when the VAD says silence). Its ONNX weights could be run in-browser via ONNX Runtime Web; no official JS package exists today, so treat this as an experiment with the silence-timeout fallback.
4. **Barge-in mode (S3):** the module exposes `setAgentSpeaking(true/false)`. While true, the VAD stays hot, the confirmation window shrinks (~120–200 ms of sustained speech probability), and an `onInterrupt` event cancels the TTS/LLM stream. AEC + the confirmation window suppress echo false-positives.
5. **Optional STT hook (the user's idea, correctly placed):** when a turn *ends*, the buffered 16 kHz audio is handed to whatever transcription you like (Web Speech, cloud, local) — out of the real-time path.

**Strengths**
- Covers **all three sub-problems + echo** with one small stack (~2 MB model + runtime, sub-10 MB total assets, cached).
- Every real-time decision is on-device and network-independent; only content extraction is pluggable.
- Graceful degradation ladder: if the end-of-turn model is unavailable → silence timeout; if ONNX fails → energy VAD fallback; if AEC is unavailable → stricter barge-in gating (see §5 risks).
- The module API stays tiny (events + one mode flag), which is exactly what "code module for an AI application" needs.

**Weaknesses**
- More moving parts than a single library call: a small state machine with 4–6 tunable thresholds must be built and calibrated.
- The end-of-turn model piece is experimental in-browser (port required).
- Browser AEC quality varies (Safari vs. Chrome; loud speakers); worst case still needs mitigation.

**Rating:** Reliability 4.5 · Latency 5 · Footprint 4 · Privacy 5 · Support 4 · Integration 3.5 · Cost 5 · Content 2 → **Score ≈ 4.3, full-problem fit: High** (S1 ✓, S2 ✓/✓*, S3 ✓, E1 ✓)

**Verdict:** Winner. It is essentially "B, completed" — B's engine plus the two pieces B lacks (turn-end logic, echo-aware barge-in), with the user's STT idea slotted in where it is cheap and safe.

---

### G. TensorFlow.js audio models (YAMNet, speech-commands) & H. commercial VADs (Picovoice Cobra)

- **TF.js models:** YAMNet classifies audio events (including "Speech") and speech-commands does keyword spotting. Both run in-browser, but they are general-purpose: heavier runtime than ORT, frames slower than Silero, and neither is tuned for turn detection. **Score ≈ 3.1, fit Low.** Only attractive if TF.js is already in the stack.
- **Commercial VADs (e.g. Picovoice Cobra):** very small and accurate, but closed-source with key/account/licensing overhead — friction for an embeddable module. **Score ≈ 3.9, fit Medium.** Worth a look only if the Silero route underperforms on target hardware.

---

## 4. Comparison matrix

### 4.1 Weighted scores

| # | Solution | Score | Full-problem fit | Verdict in one line |
|---|---|---|---|---|
| **F** | **Hybrid: Silero + adaptive endpointing + AEC (+ optional turn model)** | **≈ 4.3** | **High** | Complete, light, on-device — **recommended** |
| B | Silero VAD via `vad-web` (ONNX Runtime Web) | ≈ 4.2 | Medium | Best engine; needs endpointing/barge-in built around it |
| E | Cloud streaming STT + provider endpointing | ≈ 3.5 | Medium | Great content/semantics, but slow path + privacy/cost; additive only |
| H | Commercial VAD (Picovoice Cobra) | ≈ 3.9 | Medium | Strong but proprietary; licensing friction |
| D | Local streaming STT + decision model (all-local) | ≈ 3.2 | Medium-High (heavy) | Right idea, wrong layer — too heavy for real-time |
| G | TF.js audio models (YAMNet etc.) | ≈ 3.1 | Low | Wrong tool unless TF.js already present |
| C | Web Speech API (`SpeechRecognition`) | ≈ 3.0 | Low | Not Baseline, server-backed, echo-blind |
| A | Energy-based VAD (Web Audio) | ≈ 3.9 | Low | Zero-dependency but noise-blind; fallback signal only |

*(Note the trap in the table: A and H score well on general criteria but poorly on fit — they don't solve the actual problem. Fit is the deciding column.)*

### 4.2 Sub-problem coverage

| Solution | S1 onset | S2 turn end | S3 barge-in | E1 echo safety |
|---|---|---|---|---|
| A Energy VAD | ~ (noise-blind) | ~ (timer) | ✗ | ✗ |
| B Silero / vad-web | ✓ | ~ (timeout only) | ✓\* (DIY + AEC) | ~ (DIY) |
| C Web Speech API | ~ | ~ | ✗ | ✗ |
| D Local STT pipeline | ✓ | ✓ | ✓ (late) | ✗ |
| E Cloud STT + endpointing | ~ (network lag) | ✓ (semantic) | ✗ (needs local VAD) | ✗ |
| **F Hybrid** | **✓** | **✓ (+ optional model)** | **✓** | **✓ (AEC + gating)** |
| G TF.js models | ~ | ✗ | ~ | ✗ |
| H Commercial VAD | ✓ | ~ | ✓ | ~ |

---

## 5. Recommended architecture (solution F, concretely)

```
                 ┌────────────────────────────────────────────────┐
                 │              speak-or-no-speak module           │
mic ─ getUserMedia(echoCancellation, noiseSuppression, AGC)       │
 │                                                                │
 ▼                                                                │
AudioWorklet (16 kHz, 512–1536-sample frames)                     │
 │  Float32 frames                                                │
 ▼                                                                │
Web Worker: Silero VAD (ONNX Runtime Web, WASM SIMD / WebGPU)     │
 │  speech probability per frame (32–96 ms)                       │
 ▼                                                                │
State machine ── events ──────────────────────────────────────────┘
   IDLE ──onset────────► LISTENING ──silence+turncheck──► TURN_END
     ▲                     │  ▲                            │
     │                     │  └──interrupt──► onInterrupt  ▼
     └──────────────────── setAgentSpeaking(true) ──► AGENT_SPEAKING
                                              (VAD hot, short confirm,
                                               TTS/LLM stream cancelled)
```

**Module API sketch**

```ts
interface SpeakOrNoSpeak {
  start(): Promise<void>;
  stop(): void;
  setAgentSpeaking(active: boolean): void;      // arms barge-in (S3)
  onSpeechStart(cb: () => void): void;           // S1
  onTurnEnd(cb: (audio: Float32Array) => void): void; // S2 — 16 kHz PCM, ready for STT
  onInterrupt(cb: (info: { atMs: number }) => void): void; // S3
  onLevel(cb: (rms: number) => void): void;      // cheap UI meter (solution A lives here)
}
```

**Key parameters (starting points, to be calibrated)**

| Parameter | Start value | Purpose |
|---|---|---|
| Onset confirm | 2–3 frames ≈ 96–288 ms of prob > 0.5–0.6 | Avoids clicks/noise triggering S1 |
| Turn-end silence | 500–700 ms (adaptive ±200 ms) | S2 baseline |
| Min speech | ≥ 250 ms | Ignores coughs/lip smacks |
| Pre-speech pad | 100–300 ms ring buffer | Don't clip word onsets |
| Barge-in confirm (agent speaking) | 120–200 ms sustained prob > 0.6 | E1 protection; ~150 ms interrupt latency |
| Barge-in during no-AEC | require 2× confirm + level spike, or block | Fail-safe against echo loops |

**Failure-mode ladder (degradation, not death):** end-of-turn model unavailable → silence timeout · ONNX fails to load → energy VAD fallback (degraded flag exposed) · AEC unavailable → stricter barge-in gating + UI hint to use headphones · mic denied → explicit error event.

---

## 6. Risks & open questions

1. **Echo cancellation quality** — the linchpin of S3 on loudspeakers. Must be validated early with a loopback test (TTS playing + mic listening) on Chrome/Edge/Safari, laptop speakers vs. headphones.
2. **Barge-in false positives** — TV/other people speaking will legitimately trigger interrupts. Semantic filtering ("is this speech directed at me?") is out of scope for v1; a "resume" grace period after an interrupt mitigates thrash.
3. **End-of-turn model in the browser** — Smart Turn is proven server-side; an ONNX Runtime Web port is plausible (8 MB int8, 16 kHz PCM in) but unproven. Ship the silence-timeout baseline first, A/B the model later.
4. **SharedArrayBuffer / threads** — multi-threaded WASM needs cross-origin isolation headers; otherwise run ORT single-threaded (still fast enough for Silero at < 1 ms/frame).
5. **Safari quirks** — AudioContext sample-rate handling and AEC behavior differ; needs a compatibility pass.
6. **Calibration data** — thresholds above are starting points; a small recording harness (quiet room / TV / music / typing) should drive final values.

## 7. Suggested next steps

1. **Spike (½ day):** `vad-web` demo page — speech indicator + onSpeechEnd logging; confirm asset sizes and frame latency on target hardware.
2. **Echo test (½ day):** play TTS through speakers while VAD runs with `echoCancellation: true`; measure false-trigger rate (validates E1 assumption).
3. **Build the state machine** (§5) around vad-web's frame events; expose the module API with the degradation ladder.
4. **Calibrate** with the recording harness; tune onset/turn-end/barge-in windows.
5. **Experiment (optional):** port Smart Turn v3 ONNX weights to ONNX Runtime Web; A/B against silence timeout.
6. **Later:** plug STT into `onTurnEnd` audio for content (Web Speech / cloud / local — swappable).

---

## 8. References

- Silero VAD — https://github.com/snakers4/silero-vad (MIT, ~2 MB, < 1 ms per 30 ms chunk on one CPU thread)
- `@ricky0123/vad` (browser VAD on ONNX Runtime Web) — https://github.com/ricky0123/vad · docs: https://docs.vad.ricky0123.com
- Smart Turn v3.2 (open end-of-turn model, BSD-2, 8 MB int8, 23 languages) — https://github.com/pipecat-ai/smart-turn · weights: https://huggingface.co/pipecat-ai/smart-turn-v3
- ONNX Runtime Web — https://onnxruntime.ai/docs/tutorials/web/
- MDN `SpeechRecognition` (not Baseline; Chrome server-backed) — https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- Architecture precedents: LiveKit Agents, Pipecat (https://pipecat.ai), Vocode
- whisper.cpp (WASM STT) — https://github.com/ggml-org/whisper.cpp · Moonshine (edge ASR) — https://github.com/usefulsensors/moonshine
- Picovoice Cobra (commercial VAD) — https://picovoice.ai
