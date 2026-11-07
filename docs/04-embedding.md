# Chapter 4 — Embedding the module in your own app

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 3](03-demo.md) · next: [Chapter 5 — API reference](05-api-reference.md)

There are four ways to put Speak Or No Speak into your page, all exposing the
**same API** ([Chapter 5](05-api-reference.md)). They differ only in *where the
code comes from* and *where the two runtime libraries come from*.

## 4.1 The integration modes at a glance

| Mode | You import | Runtime libraries (`vad-web`, `onnxruntime-web`) | Best when |
|---|---|---|---|
| **1 · zero-build page** | `src/index.js` from this checkout, served statically | pinned CDN `<script>` tags | you develop with the source checkout (like the demo) |
| **2 · prebuilt ESM bundle** | `build/speak-or-no-speak.esm.js` copied next to your page | pinned CDN `<script>` tags | you want one linked file, no npm install, no bundler |
| **3 · prebuilt IIFE bundle** | `build/speak-or-no-speak.iife.js` as a classic `<script>` → global `window.SpeakOrNoSpeak` | pinned CDN `<script>` tags | your page does not use ES modules |
| **4 · npm / bundler** | `npm i speak-or-no-speak` | `npm i @ricky0123/vad-web onnxruntime-web`, resolved by your bundler **or** still CDN tags | your app already has a build pipeline |

In every mode the engine adapter resolves its library at runtime in this order:

1. `window.vad` — present when the CDN tags are included (modes 1–3);
2. dynamic `import("@ricky0123/vad-web")` — resolved by a bundler/npm
   (mode 4);
3. both unavailable → `cdn-unavailable` → the **facade degrades to the energy
   engine** (a warning, never a crash — [Chapter 15](15-troubleshooting.md)).

## 4.2 Mode 1 — zero-build page (CDN `<script>` tags)

Serve the checkout statically and import the source entry module. This is what
the demo does:

```html
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
<script type="module">
  import { createSpeakOrNoSpeak } from "./src/index.js";

  const sons = await createSpeakOrNoSpeak({
    onSpeechStart: () => console.log("user started"),
    onTurnEnd: (e) => console.log("turn end", e.durationMs, "ms"),
    onInterrupt: (i) => console.log("barge-in after", i.latencyMs, "ms"),
  });
  await sons.start(); // call from a user gesture (Safari)
</script>
```

The two tags are **required for the Silero engine** — they register the `ort`
and `vad` globals ([Chapter 11](11-runtime-libraries.md)).

## 4.3 Mode 2 — prebuilt ESM bundle

Copy `build/speak-or-no-speak.esm.js` (and the `.js.map`) next to your page,
then:

```html
<head>
  <!-- pinned CDN runtime deps — required for the Silero engine -->
  <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
</head>
<script type="module">
  import { createSpeakOrNoSpeak } from "./speak-or-no-speak.esm.js";
  // identical API from here on
</script>
```

**Live demo:** [`demos/simple-demos/demo-esm-bundle.html`](../demos/simple-demos/demo-esm-bundle.html) —
same UI and wiring as the [demo page](03-demo.md), but importing **only the
prebuilt bundle**. Serve the checkout (`npm start`) and open
[`http://localhost:5173/demos/simple-demos/demo-esm-bundle.html`](http://localhost:5173/demos/simple-demos/demo-esm-bundle.html).

Facts about the bundle ([Chapter 16](16-build-test-publish.md)):

- ~25.1 KB minified (+ sourcemap), a minified build of `src/index.js` with all
  **16 named exports** preserved — API-identical to the source (verified by
  [`test/bundle-verify.html`](../test/bundle-verify.html)).
- It contains **only this project's code**; the two runtime libraries arrive
  via the CDN tags at runtime.
- Each artifact starts with a version banner; rebuild any time with
  `npm run build:bundle`.

## 4.4 Mode 3 — prebuilt IIFE bundle (classic script, no modules)

Same two CDN tags; the IIFE build defines a global:

```html
<script src="./speak-or-no-speak.iife.js"></script>
<script>
  const { createSpeakOrNoSpeak } = window.SpeakOrNoSpeak;
  // identical API from here on
</script>
```

**Live demo:** [`demos/simple-demos/demo-iife-bundle.html`](../demos/simple-demos/demo-iife-bundle.html) —
same UI and wiring as the [demo page](03-demo.md), but the API comes from the
`window.SpeakOrNoSpeak` global (no modules). Serve the checkout (`npm start`)
and open
[`http://localhost:5173/demos/simple-demos/demo-iife-bundle.html`](http://localhost:5173/demos/simple-demos/demo-iife-bundle.html).

~26.0 KB minified (+ sourcemap). Everything else behaves exactly like the ESM
bundle.

## 4.5 Mode 4 — npm / bundler

```bash
npm i speak-or-no-speak @ricky0123/vad-web onnxruntime-web
```

```js
import { createSpeakOrNoSpeak } from "speak-or-no-speak";
// same API; the adapter auto-imports @ricky0123/vad-web when window.vad is absent
```

Notes:

- The package is **ESM-only** (`"type": "module"`). If the CDN tags are absent,
  the adapter's dynamic `import("@ricky0123/vad-web")` resolves through your
  bundler / `node_modules`.
- The ONNX model and WASM binaries are still fetched from the CDN at runtime
  (the adapter pins those asset paths) — installing the npm packages does not
  remove the runtime fetches ([Chapter 11](11-runtime-libraries.md)).
- You can still *also* include the CDN tags; `window.vad` wins, and the dynamic
  import is never reached.

## 4.6 Using the ESM bundle inside Vite / webpack / esbuild

The bundle contains exactly **one bare dynamic import** — the Silero adapter's
`import("@ricky0123/vad-web")` — and your build must decide how to treat it:

- **CDN tags present (recommended):** mark `@ricky0123/vad-web` as **external**
  in your bundler config so the build does not try to resolve it. At runtime
  `window.vad` is checked first, so the dynamic import is never reached — full
  Silero accuracy, no npm packages needed.
- **No CDN tags:** `npm i @ricky0123/vad-web onnxruntime-web` in your app and
  let your bundler resolve (and inline) the dynamic import. The tags become
  unnecessary; the model/WASM assets are still CDN-fetched.
- **Neither:** your bundler either errors on the unresolvable import (loud, at
  build time) or leaves it failing at runtime — in which case the adapter
  catches it and the facade degrades to the energy engine
  ([Chapter 15](15-troubleshooting.md)). A working setup is one of the two
  above.

## 4.7 Serving requirements

- **Secure context**: serve over `https://` or `http://localhost` — never
  `file://`, or `getUserMedia` is unavailable (`insecure-context`).
- **CDN reachability at runtime** (unless you serve a local `/vendor/` mirror):
  the two pinned tags, plus vad-web's own fetches of the Silero model, the
  audio-worklet, and the ORT WASM binaries ([Chapter 11](11-runtime-libraries.md)).
- **Browsers:** current Chromium and/or Safari; mobile out of scope for v1.
- **Licensing:** the bundle ships no third-party code (MIT); the CDN tags bring
  vad-web / onnxruntime-web under their own licenses at runtime.

## 4.8 Choosing a mode

- **Prototyping against the source / developing this repo** → mode 1 (the demo
  is the worked example).
- **"I just want to link one file"** → mode 2 (ESM) or mode 3 (IIFE for
  non-module pages).
- **You have a bundler already** → mode 4, with the CDN tags as the simplest
  runtime-library source; or the packages if you prefer zero external tags.
- **Offline/air-gapped deployments** → any mode + a local `/vendor/` mirror
  ([§11.5](11-runtime-libraries.md#115-offline-and-blocked-cdn-operation)).

---

*Prev: [Chapter 3 — The demo page](03-demo.md) · Next: [Chapter 5 — API reference](05-api-reference.md)*
