# Chapter 11 — The external runtime libraries

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 10](10-vad-engines.md) · next: [Chapter 12 — Smart Turn](12-smart-turn.md)

Two libraries are **not** part of the bundle and are loaded at runtime from
pinned CDN `<script>` tags:

```html
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
```

This chapter explains what each is for and — the question that comes up every
time — **why they are not bundled**.

## 11.1 `onnxruntime-web` — what it is and what it is for here

[ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/) (pinned
**1.22.0**) is Microsoft's inference engine for ONNX models in the browser,
compiled to WebAssembly. It registers the global **`ort`**.

In this project it runs **two** models:

1. the **Silero VAD** model (`silero_vad_v5.onnx`) — every frame, on the main
   thread ([Chapter 10](10-vad-engines.md)),
2. the optional **Smart Turn** model (`smart-turn-v3.2-cpu.onnx`) — at silence
   points only, if enabled ([Chapter 12](12-smart-turn.md); it needs the `ort`
   namespace or a passed-in one).

The WASM binaries (and their `.mjs` JS bindings) are fetched at runtime from
the pinned dist path `cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/`.

## 11.2 `vad-web` — what it is and what it is for here

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
**frames only**, and the turn state machine owns all turn semantics
([§8.8](08-architecture.md#88-design-decisions-and-their-reasons)).

## 11.3 Why neither is included in the bundle

The single-file bundle ([Chapter 16](16-build-test-publish.md)) contains
**only this project's code** — by design. The reasons:

1. **They are runtime assets, not plain JS.** onnxruntime-web is a WASM
   runtime: multi-MB `.wasm` binaries plus `.mjs` bindings plus loader logic;
   vad-web additionally needs the ONNX model weights and an audio-worklet
   file. These cannot meaningfully be inlined into one JS file — they must be
   fetched (or served) as separate assets either way.
2. **Version pinning is independent of this project.** Both libraries evolve
   on their own (0.0.31 and 1.22.0 are pinned and runtime-verified against
   this adapter). Bundling would couple this project's releases to theirs and
   force a rebuild for every library update; the CDN tags keep the upgrade
   surface visible in your page ([§11.6](#116-upgrading-the-pins)).
3. **Size and cache economics.** Inlining would multiply the bundle size and
   re-download the WASM/model on every deploy of *your* app. As CDN tags, the
   assets are cached by the browser (immutable, one year) and shared across
   sites — after the first successful load, detection even works offline
   ([§11.5](#115-offline-and-blocked-cdn-operation)).
4. **License surface.** The bundle ships no third-party code (MIT only); the
   CDN tags bring vad-web/onnxruntime-web in under their own licenses at
   runtime.
5. **Graceful degradation needs the seam.** The whole fallback story
   (`cdn-unavailable` → energy engine) relies on these libraries being
   *load-time optional* rather than baked in — if they cannot load, the module
   still works, degraded and flagged ([Chapter 15](15-troubleshooting.md)).

## 11.4 What the browser fetches at runtime

| Fetch | From | When |
|---|---|---|
| `ort.wasm.min.js` | your `<script>` tag (pinned 1.22.0) | page load |
| `bundle.min.js` (vad-web) | your `<script>` tag (pinned 0.0.31) | page load |
| ORT WASM binaries + `.mjs` bindings | `…/onnxruntime-web@1.22.0/dist/` (paths pinned in the adapter) | engine start |
| `silero_vad_v5.onnx` + audio-worklet | `…/vad-web@0.0.31/dist/` (pinned `baseAssetPath`) | engine start |
| `smart-turn-v3.2-cpu.onnx` | `/vendor/` (or your `modelUrl`) | first Smart Turn evaluation, if enabled |

The pinned paths are constants in
[`src/vad/silero-vad-adapter.js`](../src/vad/silero-vad-adapter.js)
(`VAD_WEB_BASE`, `ORT_WEB_BASE`) and are passed to vad-web as
`baseAssetPath` / `onnxWASMBasePath`.

## 11.5 Offline and blocked-CDN operation

- **After the first successful load**, model + WASM come from the browser
  cache (immutable, one year) — detection keeps working offline.
- **If the CDN is blocked at load time** (offline, VPN, strict CSP): the
  adapter reports `cdn-unavailable`, the facade degrades to the energy engine,
  and events keep flowing (`degraded.engine = "energy"`) — a warning, never a
  crash ([Chapter 15](15-troubleshooting.md)).
- **Local mirror for air-gapped setups**: serve a `/vendor/` directory with
  `ort.wasm.min.js`, vad-web's `bundle.min.js`, the `.onnx`/`.wasm`/`.mjs`
  assets, and point the `<script>` tags and
  `baseAssetPath`/`onnxWASMBasePath` at local paths. (`vendor/` is
  gitignored and excluded from the npm package — it is a local convenience,
  not a distribution channel.)

## 11.6 Upgrading the pins

The versions appear in three places that must stay in sync:

1. the `<script>` tags in your page (and in
   [`demos/simple-demos/index.html`](../demos/simple-demos/index.html)),
2. the asset-path constants in
   [`src/vad/silero-vad-adapter.js`](../src/vad/silero-vad-adapter.js)
   (used for vad-web's model/worklet fetches and ORT's WASM fetches),
3. the npm package list when you use mode 4
   ([§4.5](04-embedding.md#45-mode-4--npm--bundler)).

When upgrading vad-web, re-verify the runtime findings of
[§10.3](10-vad-engines.md#103-runtime-verified-vad-web-findings) — frame size
behavior, `getStream`, and the `model` option are exactly the kind of
undocumented details that changed between releases before.

---

*Prev: [Chapter 10 — VAD engines](10-vad-engines.md) · Next: [Chapter 12 — Smart Turn](12-smart-turn.md)*
