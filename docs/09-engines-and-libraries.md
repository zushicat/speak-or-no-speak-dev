# Engines and runtime libraries

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Architecture](08-architecture.md) · next: [Smart Turn](10-smart-turn.md)

Two engines implement the [`VadEngine`](../src/vad/vad-engine.js) interface:
the default **Silero** adapter and the degraded **energy** fallback. Both lean
on two external libraries that are loaded at runtime from pinned CDN `<script>`
tags and are **not** part of the bundle:

```html
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
```

This chapter explains the engines, the libraries, and — the question that
comes up every time — **why the libraries are not bundled**.

## Silero VAD v5 — why this engine

[Silero VAD](https://github.com/snakers4/silero-vad) is the de-facto
industry-standard open VAD: a ~2 MB neural model (MIT license) trained on
massive multilingual corpora, **< 1 ms per 30 ms chunk on a single CPU
thread**, robust to noise, 8 kHz/16 kHz. It is the VAD underneath LiveKit
Agents, Pipecat, and many production voice bots.

Why it was chosen: the best reliability-per-megabyte of any option; frame-level
speech probability exposed so custom logic can be built **on top** rather than
fought; fully on-device, no network, no keys. (The full method comparison is in
[Design background](15-design-background.md).)

What a VAD **cannot** do: it knows *acoustics*, not *language* — it cannot
tell "sentence done" from "thinking pause". That is why the endpointing state
machine ([How detection works](07-how-detection-works.md)) exists around it,
and why the optional semantic model ([Smart Turn](10-smart-turn.md)) is
additive rather than a replacement.

## vad-web's role and the adapter's dual-mode resolution

[`@ricky0123/vad-web`](https://github.com/ricky0123/vad) (pinned **0.0.31**)
packages Silero for the browser on top of ONNX Runtime Web: it handles mic
capture (AudioWorklet or ScriptProcessor), resampling to 16 kHz, model + worklet
asset loading, and inference, and exposes a callback API.

[`SileroVadAdapter`](../src/vad/silero-vad-adapter.js) consumes it in one
well-defined way. Library resolution (dual-mode):

1. **`window.vad`** — present when the pinned CDN `<script>` tags loaded
   (zero-build mode);
2. else **dynamic `import("@ricky0123/vad-web")`** — resolved by a bundler/npm;
3. both fail → `cdn-unavailable` error → **the facade** switches to the energy
   fallback engine.

`window.vad` is read in **exactly one place** — this adapter — the single
choke point that keeps a later bundler migration or fallback trivial.

The adapter passes **its own** mic stream to vad-web via the documented
`getStream` override (the `stream` option does **not** exist in 0.0.31), so the
AEC/NS/AGC constraints apply to the exact stream the engine consumes. vad-web's
own segmentation callbacks (`onSpeechStart`/`onSpeechEnd`) stay **unwired by
design** — the state machine owns turn semantics.

## Runtime-verified vad-web findings

These were verified against the real 0.0.31 bundle and docs, and they shaped
the implementation:

| Finding | Consequence |
|---|---|
| `frameSamples` is accepted but **ignored** for MicVAD — the frame size is **model-derived** (`legacy ? 1536 : 512` in the bundle) | Silero v5 frames are **512 samples = 32 ms**, not 96 ms → all frame-count thresholds are calibrated to that rate (see [Tuning § the 32 ms story](12-tuning.md#the-32-ms-recalibration-story)) |
| `model: "v5"` must be passed **explicitly** — the 0.0.31 default is `"legacy"` | The adapter pins `model: "v5"` |
| `onFrameProcessed(probs, frame)` — the raw frame parameter **is** provided (verified in Chrome) | The detector buffers turn audio from frames; vad-web's own `onSpeechEnd` segmentation stays unwired |
| Mic track: 48 kHz native; vad-web runs a default device-rate AudioContext and resamples to 16 kHz internally; AEC/NS/AGC active on the track | The adapter inspects `track.getSettings()` for the AEC check |

Each frame is then emitted as `{ probability, frame, rms, durationMs }` —
`rms` computed by the adapter, `durationMs` derived from the actual frame
length at 16 kHz.

## The AudioWorklet hang and the ScriptProcessor fallback

**Observed:** `audioWorklet.addModule` can **never resolve** — seen in
automation Chromium builds, known to also happen in old Safari and embedded
webviews.

**Mitigation:** `MicVAD.new()` is **timeout-guarded** (8 s). On timeout or
error the adapter retries with vad-web's documented legacy path
`processorType: "ScriptProcessor"`, which needs no worklet module load. The
effective path is exposed as `processorTypeUsed`
(`"audio-worklet" | "script-processor"`) via `listener._engine`.

Additional guard: after start, the adapter rejects with `vad-no-frames` if no
frame arrives within 5 s (interface contract: `start()` resolves when the
first frame is emitted).

## `EnergyVad` — the degraded fallback

[`src/vad/energy-vad.js`](../src/vad/energy-vad.js) implements the same
`VadEngine` interface, but with **pure signal processing** — no model, no CDN:

```
getUserMedia → AudioContext → ScriptProcessor(4096, 1, 1)
  → rate-adaptive box-average downsample to 16 kHz
  → 512-sample frames → RMS → probability → onFrame
```

- **Worklet-free on purpose** (immune to the addModule hang). The
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

### The energy probability model

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
(`degraded.engine = "energy"`), never silent.

## Custom engines

Advanced option ([API reference](05-api-reference.md)): pass `engine` (and
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
  ([Architecture](08-architecture.md#the-engine-abstraction)).

## The two runtime libraries

### `onnxruntime-web` — what it is and what it is for here

[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) (pinned
**1.22.0**) is Microsoft's inference engine for ONNX models in the browser,
compiled to WebAssembly. It registers the global **`ort`**.

In this project it runs **two** models:

1. the **Silero VAD** model (`silero_vad_v5.onnx`) — every frame, on the main
   thread,
2. the optional **Smart Turn** model (`smart-turn-v3.2-cpu.onnx`) — at silence
   points only, if enabled ([Smart Turn](10-smart-turn.md); it needs the `ort`
   namespace or a passed-in one).

The WASM binaries (and their `.mjs` JS bindings) are fetched at runtime from
the pinned dist path `cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/`.

### `vad-web` — what it is for here

[`@ricky0123/vad-web`](https://github.com/ricky0123/vad) (pinned **0.0.31**)
is the browser wrapper around Silero VAD. It registers the global **`vad`**
and provides:

- **mic capture** — `MicVAD.new(...)` opens the AudioContext, the capture node
  (AudioWorklet, with a legacy `ScriptProcessor` path), and resamples to the
  model rate;
- **inference wiring** — it loads the Silero model via onnxruntime-web and
  feeds frames;
- **asset loading** — it fetches `silero_vad_v5.onnx` and the audio-worklet
  from its own pinned dist path
  `cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/`.

What this project deliberately does **not** use from vad-web: its
segmentation callbacks (`onSpeechStart`/`onSpeechEnd`) — the adapter consumes
**frames only**, and the turn state machine owns all turn semantics.

## Why neither library is included in the bundle

The single-file bundle ([Development](14-development.md)) contains **only this
project's code** — by design. The reasons:

1. **They are runtime assets, not plain JS.** onnxruntime-web is a WASM
   runtime: multi-MB `.wasm` binaries plus `.mjs` bindings plus loader logic;
   vad-web additionally needs the ONNX model weights and an audio-worklet
   file. These cannot meaningfully be inlined into one JS file — they must be
   fetched (or served) as separate assets either way.
2. **Version pinning is independent of this project.** Both libraries evolve
   on their own (0.0.31 and 1.22.0 are pinned and runtime-verified against
   this adapter). Bundling would couple this project's releases to theirs and
   force a rebuild for every library update; the CDN tags keep the upgrade
   surface visible in your page.
3. **Size and cache economics.** Inlining would multiply the bundle size and
   re-download the WASM/model on every deploy of *your* app. As CDN tags, the
   assets are cached by the browser (immutable, one year) and shared across
   sites — after the first successful load, detection even works offline.
4. **License surface.** The bundle ships no third-party code (MIT only); the
   CDN tags bring vad-web/onnxruntime-web in under their own licenses at
   runtime.
5. **Graceful degradation needs the seam.** The whole fallback story
   (`cdn-unavailable` → energy engine) relies on these libraries being
   *load-time optional* rather than baked in — if they cannot load, the module
   still works, degraded and flagged ([Troubleshooting](13-troubleshooting.md)).

## What the browser fetches at runtime

| Fetch | From | When |
|---|---|---|
| `ort.wasm.min.js` | your `<script>` tag (pinned 1.22.0) | page load |
| `bundle.min.js` (vad-web) | your `<script>` tag (pinned 0.0.31) | page load |
| ORT WASM binaries + `.mjs` bindings | `…/onnxruntime-web@1.22.0/dist/` (paths pinned in the adapter) | engine start |
| `silero_vad_v5.onnx` + audio-worklet | `…/vad-web@0.0.31/dist/` (pinned `baseAssetPath`) | engine start |
| `smart-turn-v3.2-cpu.onnx` | `/vendor/` (or your `modelUrl`) | first Smart Turn evaluation, if enabled |
| `wespeaker_en_voxceleb_resnet34.onnx` | `/vendor/` (or your `modelUrl`) | first voice-gate scoring, if enabled |

The pinned paths are constants in
[`src/vad/silero-vad-adapter.js`](../src/vad/silero-vad-adapter.js)
(`VAD_WEB_BASE`, `ORT_WEB_BASE`) and are passed to vad-web as
`baseAssetPath` / `onnxWASMBasePath`.

## Offline and blocked-CDN operation

- **After the first successful load**, model + WASM come from the browser
  cache (immutable, one year) — detection keeps working offline.
- **If the CDN is blocked at load time** (offline, VPN, strict CSP): the
  adapter reports `cdn-unavailable`, the facade degrades to the energy engine,
  and events keep flowing (`degraded.engine = "energy"`) — a warning, never a
  crash ([Troubleshooting](13-troubleshooting.md)).
- **Local mirror for air-gapped setups**: serve a `/vendor/` directory with
  `ort.wasm.min.js`, vad-web's `bundle.min.js`, the `.onnx`/`.wasm`/`.mjs`
  assets, and point the `<script>` tags and
  `baseAssetPath`/`onnxWASMBasePath` at local paths. (`vendor/` is
  gitignored and excluded from the npm package — it is a local convenience,
  not a distribution channel.)

## Upgrading the pins

The versions appear in three places that must stay in sync:

1. the `<script>` tags in your page (and in
   [`demos/index.html`](../demos/index.html)),
2. the asset-path constants in
   [`src/vad/silero-vad-adapter.js`](../src/vad/silero-vad-adapter.js)
   (used for vad-web's model/worklet fetches and ORT's WASM fetches),
3. the npm package list when you use mode 4
   ([Use it in your own app](04-use-in-your-app.md)).

When upgrading vad-web, re-verify the runtime findings above — frame size
behavior, `getStream`, and the `model` option are exactly the kind of
undocumented details that changed between releases before.

---

*Prev: [Architecture](08-architecture.md) · Next: [Smart Turn](10-smart-turn.md)*
