# Use it in your own app

> Part of the [Speak Or No Speak documentation](README.md) · prev: [The demo page](03-demo-page.md) · next: [API reference](05-api-reference.md)

There are four ways to put Speak Or No Speak into a page. They all expose the
**same API** ([API reference](05-api-reference.md)) — they differ only in
*where the code comes from* and *where the two runtime libraries come from*.

## The four integration modes at a glance

| Mode | You import | Runtime libraries (`vad-web`, `onnxruntime-web`) | Best when |
|---|---|---|---|
| **1 · zero-build page** | `src/index.js` from this checkout, served statically | pinned CDN `<script>` tags | you develop with the source checkout (like the demo) |
| **2 · prebuilt ESM bundle** | `build/speak-or-no-speak.esm.js` copied next to your page | pinned CDN `<script>` tags | you want one linked file, no npm install, no bundler |
| **3 · prebuilt IIFE bundle** | `build/speak-or-no-speak.iife.js` as a classic `<script>` → global `window.SpeakOrNoSpeak` | pinned CDN `<script>` tags | your page does not use ES modules |
| **4 · npm / bundler** | `npm i speak-or-no-speak` | `npm i @ricky0123/vad-web onnxruntime-web`, resolved by your bundler **or** still CDN tags | your app already has a build pipeline |

In every mode the engine adapter resolves its library at runtime in this order:

1. `window.vad` — present when the CDN tags are included (modes 1–3);
2. dynamic `import("@ricky0123/vad-web")` — resolved by a bundler/npm (mode 4);
3. both unavailable → a `cdn-unavailable` error → the **facade degrades to the
   energy engine** (a warning, never a crash — see
   [Troubleshooting](13-troubleshooting.md)).

## Mode 1 — zero-build page (CDN `<script>` tags)

Serve the checkout statically and import the source entry module. This is what
the demo does:

```html
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
<script type="module">
  import { createSpeakOrNoSpeak } from "./src/index.js";

  const listener = await createSpeakOrNoSpeak({
    onSpeechStart: () => console.log("user started"),
    onTurnEnd: (e) => console.log("turn end", e.durationMs, "ms"),
    onInterrupt: (i) => console.log("barge-in after", i.latencyMs, "ms"),
  });
  await listener.start(); // call from a user gesture (Safari)
</script>
```

The two tags are **required for the Silero engine** — they register the `ort`
and `vad` globals ([Engines and runtime libraries](09-engines-and-libraries.md)).

## Mode 2 — prebuilt ESM bundle

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

**Live example:** [`demos/demo-esm-bundle.html`](../demos/demo-esm-bundle.html) —
the demo page importing only the prebuilt bundle. Serve the checkout and open
<http://localhost:5173/demos/demo-esm-bundle.html>.

Facts about the bundle (details in [Development](14-development.md)):

- ≈ 42 KB minified (+ sourcemap), a minified build of `src/index.js` with all
  **20 named exports** preserved — API-identical to importing the source
  (verified by [`test/bundle-verify.html`](../test/bundle-verify.html)).
- It contains **only this project's code**; the two runtime libraries arrive
  via the CDN tags at runtime.
- Each artifact starts with a version banner; rebuild any time with
  `npm run build:bundle`.

## Mode 3 — prebuilt IIFE bundle (classic script, no modules)

Same two CDN tags; the IIFE build defines a global:

```html
<script src="./speak-or-no-speak.iife.js"></script>
<script>
  const { createSpeakOrNoSpeak } = window.SpeakOrNoSpeak;
  // identical API from here on
</script>
```

**Live example:** [`demos/demo-iife-bundle.html`](../demos/demo-iife-bundle.html)
(<http://localhost:5173/demos/demo-iife-bundle.html>). ≈ 43 KB minified
(+ sourcemap). Everything else behaves exactly like the ESM bundle.

## Mode 4 — npm / bundler

```bash
npm i speak-or-no-speak @ricky0123/vad-web onnxruntime-web
```

```js
import { createSpeakOrNoSpeak } from "speak-or-no-speak";
// same API; the adapter auto-imports @ricky0123/vad-web when window.vad is absent
```

Notes:

- The package is **ESM-only** (`"type": "module"`). If the CDN tags are
  absent, the adapter's dynamic `import("@ricky0123/vad-web")` resolves
  through your bundler / `node_modules`.
- The speech model and WASM binaries are still fetched from the CDN at
  runtime (the adapter pins those asset paths) — installing the npm packages
  does not remove the runtime fetches
  ([Engines and runtime libraries](09-engines-and-libraries.md)).
- You can still *also* include the CDN tags; `window.vad` wins, and the
  dynamic import is never reached.

## Using the ESM bundle inside Vite / webpack / esbuild

The bundle contains exactly **one bare dynamic import** — the Silero adapter's
`import("@ricky0123/vad-web")` — and your build must decide how to treat it:

- **CDN tags present (recommended):** mark `@ricky0123/vad-web` as **external**
  in your bundler config. At runtime `window.vad` is checked first, so the
  dynamic import is never reached — full Silero accuracy, no npm packages
  needed.
- **No CDN tags:** `npm i @ricky0123/vad-web onnxruntime-web` in your app and
  let your bundler resolve (and inline) the dynamic import. The tags become
  unnecessary; the model/WASM assets are still CDN-fetched.
- **Neither:** your bundler either errors on the unresolvable import (loudly,
  at build time) or leaves it failing at runtime — in which case the adapter
  catches it and the facade degrades to the energy engine
  ([Troubleshooting](13-troubleshooting.md)). A working setup is one of the two
  above.

## Serving requirements

- **Secure context:** serve over `https://` or `http://localhost` — never
  `file://`, or the microphone API is unavailable (`insecure-context`).
- **CDN reachability at runtime** (unless you serve a local `/vendor/`
  mirror): the two pinned tags, plus vad-web's own fetches of the Silero
  model, the audio-worklet, and the ONNX WASM binaries
  ([Engines and runtime libraries](09-engines-and-libraries.md)).
- **Browsers:** current desktop Chromium and/or Safari; mobile is out of scope.
- **Licensing:** the bundle ships no third-party code (MIT); the CDN tags
  bring vad-web / onnxruntime-web in under their own licenses at runtime.

## Choosing a mode

- **Prototyping against the source / developing this repo** → mode 1 (the
  demo is the worked example).
- **"I just want to link one file"** → mode 2 (ESM) or mode 3 (IIFE for
  non-module pages).
- **You have a bundler already** → mode 4, with the CDN tags as the simplest
  runtime-library source; or the npm packages if you prefer zero external tags.
- **Offline / air-gapped deployments** → any mode + a local `/vendor/` mirror
  ([Engines and runtime libraries](09-engines-and-libraries.md#offline-and-blocked-cdn-operation)).

---

*Prev: [The demo page](03-demo-page.md) · Next: [API reference](05-api-reference.md)*
