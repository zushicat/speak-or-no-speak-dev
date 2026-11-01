# Chapter 17 — Background & decision history

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 16](16-build-test-publish.md) · next: [Appendix A — Glossary](appendix-a-glossary.md)

Why is this module built the way it is? This chapter recaps the decision
trail: the problem analysis, the candidate methods, the winning architecture,
and the work packages that produced the code.

## 17.1 The initial problem analysis

The project started with a problem analysis
([`appendix-b-problem-analysis-initial.md`](appendix-b-problem-analysis-initial.md))
that decomposed "speak or no speak" into the four sub-problems used throughout
this documentation — **S1** (speech onset, ≤ ~300 ms latency), **S2** (turn
end / endpointing, the hard one), **S3** (barge-in while the agent answers,
~100–250 ms), and **E1** (echo, the cross-cutting hazard) — plus the
non-functional requirements: lightweight (≲ 10 MB), reliable in real rooms, a
JavaScript module (browser-primary), action-triggering events, and on-device
processing for latency and privacy.

It then defined weighted evaluation criteria — reliability/noise-robustness
25 %, latency 20 %, footprint 15 %, privacy/on-device 10 %, browser support
10 %, integration effort 10 %, cost 5 %, content availability 5 % — and
reported two verdicts per candidate: the weighted **score** and the
**full-problem fit** (a high score on the wrong problem is still the wrong
answer).

## 17.2 The candidate solutions (A–H) and their scores

| # | Solution | Score | Full-problem fit | Verdict in one line |
|---|---|---|---|---|
| **F** | **Hybrid: Silero + adaptive endpointing + AEC (+ optional turn model)** | **≈ 4.3** | **High** | Complete, light, on-device — **recommended** |
| B | Silero VAD via `vad-web` (ONNX Runtime Web) | ≈ 4.2 | Medium | Best engine; needs endpointing/barge-in built around it |
| H | Commercial VAD (Picovoice Cobra) | ≈ 3.9 | Medium | Strong but proprietary; licensing friction |
| A | Energy-based VAD (Web Audio) | ≈ 3.9 | Low | Zero-dependency but noise-blind; fallback signal only |
| E | Cloud streaming STT + provider endpointing | ≈ 3.5 | Medium | Great content/semantics, but slow path + privacy/cost; additive only |
| D | Local streaming STT + decision model (all-local) | ≈ 3.2 | Medium-High (heavy) | Right idea, wrong layer — too heavy for real-time |
| G | TF.js audio models (YAMNet etc.) | ≈ 3.1 | Low | Wrong tool unless TF.js already present |
| C | Web Speech API (`SpeechRecognition`) | ≈ 3.0 | Low | Not Baseline, server-backed, echo-blind |

*Note the trap in the table: A and H score well on general criteria but
poorly on fit — they don't solve the actual problem. Fit is the deciding
column.*

Sub-problem coverage of the finalists: A fails S3/E1 outright; B covers S1
and needs DIY for S2/S3/E1; C is echo-blind and server-backed; D is right in
spirit but wrong in weight/latency for real time; E is additive, not a
foundation.

## 17.3 Why the hybrid architecture won

Solution **F** is essentially "**B, completed**": B's engine plus the pieces B
lacks — turn-end logic, echo-aware barge-in — with the transcription idea
slotted in where it is cheap and safe:

1. one mic stream with **browser echo cancellation** (E1 groundwork),
2. **Silero VAD** for frame-level speech probability (S1 + the S3 trigger),
3. a **turn-end state machine** with an adaptive silence window (S2), plus an
   optional **end-of-turn model** (Smart Turn) for the semantic cases,
4. a **barge-in mode** (`setAgentSpeaking`) with its own shorter confirm
   window (S3),
5. the **STT hook at turn end** — post-hoc, batch, cheap (the user's original
   idea, correctly placed).

Equally important: **every rejected candidate survives as a piece of the final
design.** The energy VAD (A) became the degraded fallback engine
([Chapter 10](10-vad-engines.md)); cloud STT (E) became the transcription plug
point ([Chapter 13](13-transcription.md)); the semantic end-of-turn idea from
the full-local pipeline (D) returned as the optional 8 MB Smart Turn model
([Chapter 12](12-smart-turn.md)) instead of a tens-of-MB streaming STT in the
real-time loop.

## 17.4 Work packages WP0–WP9

The implementation proceeded in work packages:

| WP | Delivered | Notable decisions |
|---|---|---|
| WP0 | scaffolding, repo layout, zero-build setup (D1) | plain ES modules, CDN-pinned runtime libs |
| WP1 | VAD engine integration: `SileroVadAdapter` + demo spike | **D-WP1-1**: Silero v5 frames are 32 ms (model-derived), not 96 ms → threshold recalibration; **D-WP1-5**: AudioWorklet hang → ScriptProcessor retry |
| WP2 | demo indicator page (the orange/green dot) | UI mapping only — no detection logic in the demo |
| WP3 | facade + turn state machine | **D-WP3-1**: confirm-window speech counts as speech (short commands were silently discarded otherwise) |
| WP4 | endpointing refinement + turn audio buffering | adaptive redemption (`redemptionFor`), PAUSE sub-state, ring-buffer pad; WAV encoder moved to `src/` (D-WP4-1) |
| WP5 | barge-in + echo safety | `setAgentSpeaking` contract, interrupt latency measurement (`t_voice → t_event`), no-AEC stricter gating (rms-vs-playback-baseline) |
| WP6 | calibration harness + recordings | replay determinism, the s1–s9 scenario corpus; WP6 data later passed the WP8 gate |
| WP7 | hardening + packaging | degradation ladder (energy fallback), error taxonomy, dual-mode library resolution, npm shape |
| WP8 | Smart Turn experiment | **GO gate**: hesitant speech split turns in 100 % of s3 recordings; premise corrected — the model consumes Whisper log-mel features, not raw PCM → the pure-JS feature extractor became the WP's main unplanned work item |
| WP9 | STT plug point | `SttAdapter` + `CloudStubAdapter` + the demo stub server |

Plus **WP-B1** (rev-2): the single-file bundle
([Chapter 16](16-build-test-publish.md)).

## 17.5 References and further reading

- Silero VAD — <https://github.com/snakers4/silero-vad> (MIT, ~2 MB, < 1 ms per 30 ms chunk on one CPU thread)
- `@ricky0123/vad` (browser VAD on ONNX Runtime Web) — <https://github.com/ricky0123/vad> · docs: <https://docs.vad.ricky0123.com>
- ONNX Runtime Web — <https://onnxruntime.ai/docs/tutorials/web/>
- Smart Turn v3.2 (open end-of-turn model, BSD-2, 8 MB int8, 23 languages) — <https://github.com/pipecat-ai/smart-turn> · weights: <https://huggingface.co/pipecat-ai/smart-turn-v3>
- MDN `SpeechRecognition` (not Baseline; Chrome server-backed) — <https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition>
- Architecture precedents: LiveKit Agents, Pipecat (<https://pipecat.ai>), Vocode
- whisper.cpp (WASM STT) — <https://github.com/ggml-org/whisper.cpp> · Moonshine (edge ASR) — <https://github.com/usefulsensors/moonshine>
- Picovoice Cobra (commercial VAD) — <https://picovoice.ai>

---

*Prev: [Chapter 16 — Build, test & publish](16-build-test-publish.md) · Next: [Appendix A — Glossary](appendix-a-glossary.md)*
