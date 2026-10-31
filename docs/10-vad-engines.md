# Chapter 10 — The VAD engines

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 9](09-source-files.md) · next: [Chapter 11 — Runtime libraries](11-runtime-libraries.md)

Two engines implement the [`VadEngine`](../src/vad/vad-engine.js) interface:
the default **Silero** adapter and the degraded **energy** fallback. This
chapter explains both, plus the adapter's runtime findings and workarounds.

## 10.1 Silero VAD v5 — why this engine

[Silero VAD](https://github.com/snakers4/silero-vad) is the de-facto
industry-standard open VAD: a ~2 MB neural model (MIT license) trained on
massive multilingual corpora, **< 1 ms per 30 ms chunk on a single CPU
thread**, robust to noise, 8 kHz/16 kHz. It is the VAD underneath LiveKit
Agents, Pipecat, and many production voice bots.

Why it won the method analysis ([Chapter 17](17-background.md)): the best
reliability-per-megabyte of any option; frame-level speech probability exposed
so custom logic can be built **on top** rather than fought; fully on-device,
no network, no keys.

What a VAD **cannot** do: it knows *acoustics*, not *language* — it cannot
tell "sentence done" from "thinking pause". That is why the endpointing state
machine (Chapter 7) exists around it, and why the optional semantic model
(Chapter 12) is additive rather than a replacement.

## 10.2 vad-web's role and the adapter's dual-mode resolution

[`@ricky0123/vad-web`](https://github.com/ricky0123/vad) (pinned **0.0.31**)
packages Silero for the browser on top of ONNX Runtime Web: it handles mic
capture (AudioWorklet or ScriptProcessor), resampling to 16 kHz, model +
worklet asset loading, and inference, and exposes a callback API.

[`SileroVadAdapter`](../src/vad/silero-vad-adapter.js) consumes it in one
well-defined way. Library resolution (dual-mode, WP7 §7.5):

1. **`window.vad`** — present when the pinned CDN `<script>` tags loaded
   (zero-build mode, D1);
2. else **dynamic `import("@ricky0123/vad-web")`** — resolved by a
   bundler/npm (T7 dual-mode);
3. both fail → `cdn-unavailable` error → **the facade** switches to the energy
   fallback engine.

`window.vad` is read in **exactly one place** — this adapter — the single
choke point that keeps a later bundler migration or fallback trivial.

The adapter passes **its own** mic stream to vad-web via the documented
`getStream` override (the `stream` option does **not** exist in 0.0.31), so the
AEC/NS/AGC constraints apply to the exact stream the engine consumes. vad-web's
own segmentation callbacks (`onSpeechStart`/`onSpeechEnd`) stay **unwired by
design** — the state machine owns turn semantics.

## 10.3 Runtime-verified vad-web findings

These were verified against the real 0.0.31 bundle and docs during WP1, and
they changed the plan:

| Finding | Consequence |
|---|---|
| `frameSamples` is accepted but **ignored** for MicVAD — the frame size is **model-derived** (`legacy ? 1536 : 512` in the bundle) | Silero v5 frames are **512 samples = 32 ms**, not the plan's assumed 96 ms → all frame-count thresholds were recalibrated to the same wall-clock windows (deviation **D-WP1-1**; [§14.3](14-configuration-tuning.md#143-the-32-ms-recalibration-story)) |
| `model: "v5"` must be passed **explicitly** — the 0.0.31 default is `"legacy"` | The adapter pins `model: "v5"` (plan T1) |
| `onFrameProcessed(probs, frame)` — the raw frame parameter **is** provided (verified in Chrome) | The detector buffers turn audio from frames; vad-web's own `onSpeechEnd` segmentation stays unwired (plan 1.3.3) |
| Mic track: 48 kHz native; vad-web runs a default device-rate AudioContext and resamples to 16 kHz internally; AEC/NS/AGC active on the track | The adapter inspects `track.getSettings()` for the AEC check |

Each frame is then emitted as `{ probability: probs.isSpeech, frame, rms,
durationMs }` — `rms` computed by the adapter (`computeRms`), `durationMs`
derived from the actual frame length at 16 kHz.

## 10.4 The AudioWorklet hang and the ScriptProcessor fallback

**Observed:** `audioWorklet.addModule` can **never resolve** — seen in
automation Chromium 154 (2026-10-20), known to also happen in old Safari and
embedded webviews (WP1 D-WP1-5).

**Mitigation:** `MicVAD.new()` is **timeout-guarded** (8 s). On timeout or
error the adapter retries with vad-web's documented legacy path
`processorType: "ScriptProcessor"`, which needs no worklet module load. The
effective path is exposed as `processorTypeUsed`
(`"audio-worklet"` | `"script-processor"`) via `sons._engine`.

Additional guard: after start, the adapter rejects with `vad-no-frames` if no
frame arrives within 5 s (interface contract: `start()` resolves when the
first frame is emitted).

## 10.5 `EnergyVad` — the degraded fallback

[`src/vad/energy-vad.js`](../src/vad/energy-vad.js) implements the same
`VadEngine` interface, but with **pure signal processing** — no model, no CDN:

```
getUserMedia → AudioContext → ScriptProcessor(4096, 1, 1)
  → rate-adaptive box-average downsample to 16 kHz
  → 512-sample frames → RMS → probability → onFrame
```

- **Worklet-free on purpose** (immune to the addModule hang, D-WP1-5). The
  ScriptProcessor node is kept alive by a zero-gain sink connected to the
  destination.
- **Pause semantics differ by design:** `pause()` mutes the mic track
  (`track.enabled = false`) so the pipeline stays warm and silent frames
  (probability 0) keep flowing — unlike the Silero adapter, which stops the
  tracks.

By contract this mode is **degraded** and never chosen silently: the facade
flips to it only on `engine-load-failed` (and `cdn-unavailable`,
`audio-pipeline`), reports a one-time `engine-fallback` warning, and exposes
`degraded.engine = "energy"`.

## 10.6 The energy probability model

Pure and unit-testable ([`energyProbability`](../src/vad/energy-vad.js)):

```
noiseFloor  = min(noiseFloor × 1.0005 + 1e-6, rms)   // slow rise, fast drop
probability = clamp((rms − noiseFloor·3.2) / (noiseFloor·3.2), 0, 1)
rms < 0.005 → probability = 0                        // absolute floor
```

- The **noise floor** is a slow exponential min-tracker (initial guess 0.001;
  adapts within ~1 s): it rises slowly (×1.0005 per frame + epsilon) but drops
  immediately when rms falls below it — so it tracks the quiet baseline, not
  speech.
- Speech is then "rms meaningfully above the floor" (3.2× ratio), with an
  absolute floor of 0.005 to silence digital silence.

**Noise-blind by design:** music, TV, keyboards — anything loud is "speech".
Fine for quiet rooms, wrong for noisy ones; always flagged
(`degraded.engine = "energy"`), never silent. This is exactly the candidate A
of the method analysis, kept as the fallback it was always meant to be
([§17.3](17-background.md#173-why-the-hybrid-architecture-won)).

## 10.7 Custom engines

Advanced option ([§5.2](05-api-reference.md#52-options)): pass `engine` (and
optionally `energyEngine`) to `createSpeakOrNoSpeak` — used by tests and
experiments.

- An injected engine is used as-is; the facade reports
  `degraded.engine = "silero"` regardless (the flag tracks the *kind*, and a
  custom engine is neither) — treat injected engines as test hooks.
- Injecting an engine **disables the automatic energy fallback** unless you
  also pass `energyEngine` — the facade never hijacks a deliberately injected
  engine.
- Your engine must fulfill the `VadEngine` contract: frames + errors via
  callbacks, `start()` resolving on first frame, Node-importable module code
  ([§8.3](08-architecture.md#83-the-engine-abstraction)).

---

*Prev: [Chapter 9 — Source file guide](09-source-files.md) · Next: [Chapter 11 — Runtime libraries](11-runtime-libraries.md)*
