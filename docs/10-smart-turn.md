# Smart Turn: the optional end-of-turn model

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Engines and runtime libraries](09-engines-and-libraries.md) · next: [Transcription](11-transcription.md)

`SmartTurnModel`
([`src/turn-model/smart-turn.js`](../src/turn-model/smart-turn.js)) is an
**optional** semantic end-of-turn model. It judges whether an utterance is
**semantically complete** — the piece a VAD can never know, because a VAD
knows acoustics, not language
([Engines and runtime libraries](09-engines-and-libraries.md#silero-vad-v5--why-this-engine)).

## What it is and where it comes from

It wraps [Smart Turn v3.2](https://github.com/pipecat-ai/smart-turn) from
Pipecat (BSD-2): an **8 MB int8 ONNX model** with a **Whisper-Tiny backbone**,
trained to answer one question for a chunk of speech audio: *is this sentence
done?* The weights are not in the repo and not in the bundle — one manual
download (see [Setup](#setup)).

The gap it fills: the adaptive silence window handles fluent speech
perfectly, but the **hesitant** scenario — *"okay … hmm … let me think … go
now"* — split into 2 turns in 100 % of that calibration recording: the
thinking pauses exceeded even the patient redemption window. That is exactly
the "um, I can't seem to, um…" failure class this model targets.

## When it runs, and fail-open semantics

The model is a **gate at the turn-end moment**, nothing more:

```
redemption window reached (silence)
   → snapshot the turn audio (pad + frames)
   → turnModel.predictComplete(snapshot)
        complete   → onTurnEnd emits
        incomplete → the turn CONTINUES (accumulation never stopped;
                     silence resets, so the next evaluation only runs
                     after ANOTHER full redemption window)
```

- It runs **only at silence points** — the state machine guarantees it; the
  real-time frame budget is untouched.
- **Fail-open everywhere**: a model error, a load failure, or the
  `modelTimeoutMs` (300 ms) timeout emits the turn end anyway. **The model can
  only *hold* a turn, never lose one.**
- **New speech cancels a pending evaluation** (generation counter): if the
  user resumes speaking while the model is thinking, the evaluation is
  discarded and the next redemption re-runs it on the **entire** turn
  including the new audio.
- Truncation (`maxTurnMs`) and the agent-disarm flush **bypass** the model.
- At most one evaluation is pending at a time; evaluation cadence is bounded
  to ≈ 1 per redemption window.

## The feature pipeline (for the curious)

A key discovery during integration: the model does **not** consume raw audio —
it consumes **Whisper log-mel features** `[batch, 80, 800]`. So the module
replicates the Whisper feature extractor in pure JavaScript
([`src/turn-model/whisper-features.js`](../src/turn-model/whisper-features.js)):

```
turn audio (16 kHz mono, any length)
  → pad/truncate to exactly 8 s (128 000 samples, left-padded: the audio
    ends at the buffer end)
  → zero-mean / unit-variance over the whole padded buffer
  → center reflect-pad 200
  → frames of 400 samples, hop 160, periodic-Hann window
  → rfft(400) via Bluestein's chirp-z  (400 is not a power of two;
    the FFT is float64 to match numpy's internal precision)
  → power² → slaney-mel filterbank (80 filters) → log10
  → drop the last frame → [80, 800]
  → max(x, max − 8) → (x + 4) / 4
  → ONNX inference → sigmoid probability (applied in-model) > 0.5 → complete
```

The implementation is **parity-verified against the Python reference**
(`transformers.WhisperFeatureExtractor(chunk_length=8)`) with a max absolute
difference of **8.8e-6** — float32 quantization level. Two implementation
notes worth knowing:

- Cached Bluestein tables + precomputed twiddle factors keep per-frame work to
  one forward FFT, one multiply, one inverse FFT.
- Working buffers are cached across calls: per-call allocation would generate
  ~25 MB garbage per evaluation and trigger GC storms that also stall the
  following ONNX inference.

## Setup

```js
import { createSpeakOrNoSpeak, SmartTurnModel } from "speak-or-no-speak";

const listener = await createSpeakOrNoSpeak({
  turnModel: new SmartTurnModel({
    modelUrl: "/vendor/smart-turn-v3.2-cpu.onnx", // default; wherever you host the weights
    ort: window.ort,                              // default; from the onnxruntime-web CDN tag
    threshold: 0.5,
  }),
});
```

- **The weights are NOT in the bundle and NOT in the repo** (`vendor/` is
  gitignored): download `smart-turn-v3.2-cpu.onnx` once (Hugging Face:
  [`pipecat-ai/smart-turn-v3`](https://huggingface.co/pipecat-ai/smart-turn-v3))
  into `/vendor/`, or host it yourself and pass `modelUrl`.
- Requires the **onnxruntime-web CDN tag**
  ([Engines and runtime libraries](09-engines-and-libraries.md)) or an
  explicitly passed `ort` namespace; otherwise the session setup rejects
  ("ORT runtime unavailable") and the detector fails open.
- The ORT session is created lazily on the **first evaluation**
  (`executionProviders: ["wasm"]`, `graphOptimizationLevel: "all"`) and
  reused; the demo caches the model instance across start/stop cycles
  ([Demo page § Smart Turn](03-demo-page.md#page-anatomy)).

## Measured performance

Reference machine; single-threaded WASM without special headers vs threaded
WASM with COOP/COEP headers:

| Metric | Single-threaded WASM (no headers) | Threaded WASM (COOP/COEP, 4 threads) |
|---|---|---|
| Session load | 120–179 ms | 802 ms (threaded build) |
| Inference p50 | 141–146 ms | **47.6 ms** |
| Inference p95 | 145–151 ms | **48.3 ms** |
| Feature extraction (JS) | ~25 ms/call warm | — |

The **no-headers default is the tested path** and meets the ≤ 150 ms criterion
— barely; threaded WASM is comfortably fast but needs cross-origin isolation
headers on your server ([Architecture § threading](08-architecture.md#threading-model)).

## When to use it, and when not

**Use it when** your users hesitate: dictation, thoughtful assistants,
non-native speakers, children. The calibration recordings showed the adaptive
redemption handles fluent speech (0 premature turn-ends in the clean
scenarios) but splits hesitant speech — that evidence is what motivated the
model.

**Skip it when** latency at turn end matters more than rare split-utterances:
the model adds up to ~170 ms (features + inference) at every silence point,
needs the 8 MB asset, and (without COOP/COEP) runs single-threaded. It is
**opt-in by design** — `options.turnModel` — and the silence-timeout baseline
is always there behind it.

---

*Prev: [Engines and runtime libraries](09-engines-and-libraries.md) · Next: [Transcription](11-transcription.md)*
