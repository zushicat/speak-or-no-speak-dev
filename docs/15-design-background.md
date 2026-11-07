# Design background: why it is built this way

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Development](14-development.md) · next: [Glossary](appendix-glossary.md)

Why is this module built the way it is? This chapter recaps the reasoning: the
problem analysis, the candidate approaches that were considered, and why the
shipped hybrid design won. No code here — just the "why".

## The initial problem analysis

The project started with a problem analysis that decomposed "speak or no
speak" into the four sub-problems used throughout this documentation —
**speech onset** (≤ ~300 ms latency), **turn end / endpointing** (the hard
one), **barge-in** while the agent answers (~100–250 ms), and **echo** (the
cross-cutting hazard) — plus the non-functional requirements: lightweight
(≲ 10 MB), reliable in real rooms, a JavaScript module (browser-primary),
action-triggering events, and on-device processing for latency and privacy.

It then defined weighted evaluation criteria — reliability/noise-robustness
25 %, latency 20 %, footprint 15 %, privacy/on-device 10 %, browser support
10 %, integration effort 10 %, cost 5 %, content availability 5 % — and
reported two verdicts per candidate: the weighted **score** and the
**full-problem fit** (a high score on the wrong problem is still the wrong
answer).

## The candidate solutions (A–H) and their scores

| # | Solution | Score | Full-problem fit | Verdict in one line |
|---|---|---|---|---|
| **F** | **Hybrid: Silero + adaptive endpointing + AEC (+ optional turn model)** | **≈ 4.3** | **High** | Complete, light, on-device — **the shipped design** |
| B | Silero VAD via `vad-web` (ONNX Runtime Web) | ≈ 4.2 | Medium | Best engine; needs endpointing/barge-in built around it |
| H | Commercial VAD (Picovoice Cobra) | ≈ 3.9 | Medium | Strong but proprietary; licensing friction |
| A | Energy-based VAD (Web Audio) | ≈ 3.9 | Low | Zero-dependency but noise-blind; fallback signal only |
| E | Cloud streaming STT + provider endpointing | ≈ 3.5 | Medium | Great content/semantics, but slow path + privacy/cost; additive only |
| D | Local streaming STT + decision model (all-local) | ≈ 3.2 | Medium-High (heavy) | Right idea, wrong layer — too heavy for real time |
| G | TF.js audio models (YAMNet etc.) | ≈ 3.1 | Low | Wrong tool unless TF.js already present |
| C | Web Speech API (`SpeechRecognition`) | ≈ 3.0 | Low | Not Baseline, server-backed, echo-blind |

*Note the trap in the table: A and H score well on general criteria but
poorly on fit — they don't solve the actual problem. Fit is the deciding
column.*

Sub-problem coverage of the finalists: A fails barge-in/echo outright; B
covers speech onset and needs DIY for the rest; C is echo-blind and
server-backed; D is right in spirit but wrong in weight/latency for real
time; E is additive, not a foundation.

## Why the hybrid architecture won

Solution **F** is essentially "**B, completed**": B's engine plus the pieces B
lacks — turn-end logic, echo-aware barge-in — with the transcription idea
slotted in where it is cheap and safe:

1. one mic stream with **browser echo cancellation** (the echo groundwork),
2. **Silero VAD** for frame-level speech probability (onset + the barge-in
   trigger),
3. a **turn-end state machine** with an adaptive silence window (turn end),
   plus an optional **end-of-turn model** (Smart Turn) for the semantic cases,
4. a **barge-in mode** (`setAgentSpeaking`) with its own shorter confirm
   window,
5. the **STT hook at turn end** — post-hoc, batch, cheap.

Equally important: **every rejected candidate survives as a piece of the final
design.** The energy VAD (A) became the degraded fallback engine
([Engines and runtime libraries](09-engines-and-libraries.md#energyvad--the-degraded-fallback));
cloud STT (E) became the transcription plug point
([Transcription](11-transcription.md)); the semantic end-of-turn idea from the
full-local pipeline (D) returned as the optional 8 MB Smart Turn model
([Smart Turn](10-smart-turn.md)) instead of a tens-of-MB streaming STT in the
real-time loop.

## References and further reading

- Silero VAD — <https://github.com/snakers4/silero-vad> (MIT, ~2 MB, < 1 ms per 30 ms chunk on one CPU thread)
- `@ricky0123/vad` (browser VAD on ONNX Runtime Web) — <https://github.com/ricky0123/vad> · docs: <https://docs.vad.ricky0123.com>
- ONNX Runtime Web — <https://onnxruntime.ai/docs/tutorials/web/>
- Smart Turn v3.2 (open end-of-turn model, BSD-2, 8 MB int8, 23 languages) — <https://github.com/pipecat-ai/smart-turn> · weights: <https://huggingface.co/pipecat-ai/smart-turn-v3>
- MDN `SpeechRecognition` (not Baseline; Chrome server-backed) — <https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition>
- Architecture precedents: LiveKit Agents, Pipecat (<https://pipecat.ai>), Vocode
- whisper.cpp (WASM STT) — <https://github.com/ggml-org/whisper.cpp> · Moonshine (edge ASR) — <https://github.com/usefulsensors/moonshine>
- Picovoice Cobra (commercial VAD) — <https://picovoice.ai>

---

*Prev: [Development](14-development.md) · Next: [Glossary](appendix-glossary.md)*
