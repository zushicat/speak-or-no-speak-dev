# explain-global-build-rev-5 — a "standalone" global build of your code

Answers the follow-up to [explain-rev-5.md](explain-rev-5.md) §2: *could I create
a standalone, global-build version of my code — like the ort/vad CDN files?*

---

## 1. Short answer

**Yes — and you already have it.** It is `build/speak-or-no-speak.iife.js`,
built by the same `npm run build:bundle` command as the ESM bundle. A user
links it exactly like the ort/vad tags:

```html
<head>
  <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
  <script src="https://cdn.jsdelivr.net/gh/YOUR-USER/speak-or-no-speak@v0.1.0/build/speak-or-no-speak.iife.js"></script>
</head>
<script>
  const { createSpeakOrNoSpeak } = window.SpeakOrNoSpeak;
  // API from here on — identical to the ESM mode
</script>
```

No `type="module"`, no import statement, no import map — one `<script src>`
tag, then a global. This is mode 3 in
[docs/04-embedding.md](../../docs/04-embedding.md) (~26.0 KB minified + map).

## 2. What "global build" means, mechanically

A bundler can wrap the same source in two flavors:

| | ESM (`speak-or-no-speak.esm.js`) | Global/IIFE (`speak-or-no-speak.iife.js`) |
|---|---|---|
| How it's loaded | `import { createSpeakOrNoSpeak } from "…url…"` inside `<script type="module">` | plain `<script src="…">` |
| What executing it creates | nothing global — exports live in the module namespace | one global: `window.SpeakOrNoSpeak` |
| Consumer syntax | `import { x } from "…"` | `window.SpeakOrNoSpeak.x` (destructure it) |
| Works without module support | no | yes |
| Bundler consumption | ideal (named exports, tree-shaking) | possible but worse (one namespace object, no per-export analysis) |
| Collision risk | none (module scope) | one global name — keep it namespaced |

"IIFE" = immediately-invoked function expression: the whole bundle is wrapped
in `(() => { …your code…; return <exports>; })()` and assigned to one variable.
That is literally what the tail of your IIFE build does — it ends
`…return _t(Ot);})();`, i.e. it *returns* the exports object, and the wrapper
`var SpeakOrNoSpeak = (…)()` puts that object on the global scope. The 16 named
exports of `src/index.js` become properties of that one global —
`window.SpeakOrNoSpeak.createSpeakOrNoSpeak`, `.encodeWav`, `.SpeakError`, and
so on. Same API, different delivery.

Your instinct about the CDN files was right, and it is exact (both verified
today by inspecting their first bytes):

- `ort.wasm.min.js` is an **IIFE global build**: `var ort=(()=>{…})();` →
  `window.ort`. It is even built with the same esbuild-style require shim as
  your IIFE bundle.
- `@ricky0123/vad-web`'s `bundle.min.js` is a **UMD** build — the older
  "universal" wrapper that works as a classic script *and* under
  CommonJS/AMD: `…exports.vad=t(require("onnxruntime-web"))… : e.vad=t(e.ort)`
  → `window.vad`.

Note the last fragment: vad-web's global build grabs **`e.ort` — the global the
ort tag created**. That is why the two CDN tags must appear in that order, and
it is the defining property of global builds: they couple through the global
scope (convention and load order), while ES modules couple through explicit
imports. Your bundle is the third, independent global in that chain — the two
tags feed `window.ort`/`window.vad`, your IIFE feeds `window.SpeakOrNoSpeak`,
and the facade reads the first two at runtime.

## 3. How it's produced

It is the same build script with two option differences
([scripts/build-bundle.mjs](../../scripts/build-bundle.mjs)):

```js
const esm  = await build({ ...common, format: "esm",  outfile: "…/speak-or-no-speak.esm.js" });
const iife = await build({ ...common, format: "iife",
                           globalName: "SpeakOrNoSpeak",           // exports → window.SpeakOrNoSpeak.*
                           outfile: "…/speak-or-no-speak.iife.js" });
```

CLI equivalent, if you ever want to produce just the global build by hand:

```bash
npx esbuild src/index.js --bundle --minify --format=iife \
  --global-name=SpeakOrNoSpeak --outfile=build/speak-or-no-speak.iife.js
```

Everything else — entry point, `external: ["@ricky0123/vad-web"]`, minify,
sourcemap — is identical, which is why the two artifacts are API-identical and
only ~1 KB apart in size. The only *real* decision in a global build is the
global name: it should be unique enough to never collide and stable enough to
document. `SpeakOrNoSpeak` satisfies both; changing it is a one-line edit in
the script.

## 4. Nuances specific to your IIFE build

- **The two CDN tags are still required** for the Silero engine. The adapter
  checks `window.vad?.MicVAD?.new` first and only then falls back to a dynamic
  import — verified verbatim in both artifacts, so the IIFE build behaves
  exactly like the ESM build: tags present → full Silero accuracy; tags
  missing → `cdn-unavailable` → degrade to the energy engine. The global build
  does not change the runtime-library story at all.
- **One global, not many.** The ort/vad precedent could tempt you to expose
  several small globals (`window.speakOrNoSpeak`, `window.encodeWav`, …).
  Don't — every additional global is another collision and another thing to
  document. One namespace object with 16 properties is the good pattern (and
  what `globalName` gives you for free).
- **Bundler users should still take the ESM.** A bundler can consume the IIFE
  file, but it loses per-export tree-shaking and named-import checking. The
  pair exists precisely so each consumer picks the fitting flavor.
- **No sub-path imports.** The whole API is one object; `import … from
  "…/speak-or-no-speak.iife.js"` is not a thing (it has no exports clause).

## 5. If you want it *more* standalone — the two remaining dials

**(a) UMD instead of IIFE.** UMD adds "also works under `require()`/`define()`
(CJS/AMD)" on top of the script tag. esbuild cannot emit UMD (rollup can), and
in 2026 it buys you almost nothing: browsers want ESM or a plain script tag,
and modern Node wants ESM. Even ort ships exactly the modern pair —
`ort.esm.min.js` for module users plus the IIFE/UMD-style `ort.*.min.js` for
script users — which is precisely the pair your build already produces. Skip
UMD unless a specific legacy consumer shows up.

**(b) Inline the runtime libraries** (drop `external`, bundle vad-web and ort
in) so the file truly needs no CDN tags. This works technically but is the
wrong trade-off for this project:

- Size: ~25 KB becomes roughly a megabyte-plus of third-party code.
- vad-web itself *depends* on onnxruntime-web, so both must go in — and ort
  still fetches its multi-MB `.wasm` binaries and the Silero model at runtime,
  so you would not even eliminate the network dependency, only reshape it.
- You would ship Microsoft's and ricky0123's code inside your artifact —
  license notices, version pinning churn, and rewrites of the "contains only
  this project's code" guarantee (D2 in the build script).

The one legitimate use case — offline/air-gapped pages — is already solved
better by the local `/vendor/` mirror ([§11.5 of the runtime-library
chapter](../../docs/11-runtime-libraries.md)), which keeps the artifacts small
and third-party code out of yours.

## 6. Bottom line

Nothing needs to be built or changed: the "standalone global build" already
exists as `build/speak-or-no-speak.iife.js`, linkable with a plain `<script
src>` exactly like the ort/vad files, exposing the full API as
`window.SpeakOrNoSpeak.*`. The ESM artifact remains the primary recommendation
(module pages, bundlers), the IIFE the drop-in for classic-script pages and for
users who just want "load a script, get a global". If you publish via jsDelivr
`/gh/` as described in [explain-rev-5.md](explain-rev-5.md) §5, both flavors
are linkable the moment the repo is public and tagged — keep the `iife` marker
in the filename so consumers never have to guess which flavor they loaded.
