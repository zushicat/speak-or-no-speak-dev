# explain-rev-5 — a minified, linkable bundle from your GitHub repo

Answers to the questions in [rev-5.md](rev-5.md), based on the actual build setup
([scripts/build-bundle.mjs](../../scripts/build-bundle.mjs), [README-BUNDLE.md](../../README-BUNDLE.md),
[docs/04-embedding.md](../../docs/04-embedding.md)).

---

## 1. What the four files in `build/` are

There are exactly two artifacts, each with a companion source map:

| File | What it is | Size (v0.1.0) |
|---|---|---|
| `build/speak-or-no-speak.esm.js` | Your whole project minified into **one ES module** — `import { createSpeakOrNoSpeak } from "..."` | 25.1 KB |
| `build/speak-or-no-speak.esm.js.map` | Source map for the ESM file — lets browser DevTools show readable stack traces / original source when debugging | 113 KB |
| `build/speak-or-no-speak.iife.js` | The same code as **one classic script** (IIFE = immediately-invoked function expression) that sets the global `window.SpeakOrNoSpeak` — used with a plain `<script src>` tag, no `type="module"` needed | 26.0 KB |
| `build/speak-or-no-speak.iife.js.map` | Source map for the IIFE file | 115 KB |

The `.map` files are **optional at runtime**. They are only read by DevTools when
you have them open; the bundles work without them. They must simply sit next to
the `.js` file if you want nice stack traces (each bundle ends with a
`//# sourceMappingURL=...` comment pointing at its map).

Both artifacts are produced by one command — `npm run build:bundle` — which runs
esbuild with `minify: true` over `src/index.js`. All 16 named exports are
preserved, so the bundle is API-identical to importing the source.

## 2. Your bundle is already minified — the header you quoted is from a different file

The

```
/*!
 * ONNX Runtime Web v1.22.0
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */
```

you saw is the **license banner of onnxruntime-web**, i.e. of a *third-party
package* that Microsoft publishes to npm. It is a different artifact from a
different project. You never build or ship it — your page loads it from
jsDelivr at runtime, like every other consumer of `ort`.

Your own bundle has the equivalent of that banner:

```
/* speak-or-no-speak v0.1.0 — single-file bundle (ESM). Docs: README-BUNDLE.md · rebuild: npm run build:bundle */
```

And yes — it is the same *kind* of thing as the two CDN files: a minified,
standalone browser bundle. Measured today (exact byte counts):

| File | Minified size | What's inside |
|---|---|---|
| `build/speak-or-no-speak.esm.js` (yours) | **25.1 KB** | only this project's code |
| `ort.wasm.min.js` (Microsoft) | 48.3 KB | only ORT's JS shell — the multi-MB `.wasm` binaries are fetched at runtime |
| `bundle.min.js` (@ricky0123/vad-web) | 69.3 KB | the full VAD library as a global build (`window.vad`) |

The reason yours is small is a deliberate design decision (D2 in the build
script header): the bundle contains **only your code**. `@ricky0123/vad-web` is
marked `external`; `onnxruntime-web` was never a dependency of `src/` at all.
Both arrive at runtime via the two pinned CDN `<script>` tags. Bundling them in
instead would blow the file up by ~1 MB+, pin you to their release cycle, and
mix third-party licenses into your artifact. The current split — *your code in
your file, their code from their CDN* — is exactly what those two CDN tags do
for you, and it is the standard pattern.

One important nuance you noticed correctly: the ort/vad CDN files are
"standalone" in the sense that a plain `<script src>` tag is all they need. That
works because they are **global builds** (IIFE/UMD) — executing them creates
`window.ort` and `window.vad`. Your `esm.js` is a module, and modules *do not
create globals* — which is exactly why your sketch does not work as written.

## 3. Why the sketch doesn't work as written

```html
<script src="https://my github link to/build/speak-or-no-speak.esm.js"></script>
<script type="module">
  import { createSpeakOrNoSpeak }            // ← would this work?
</script>
```

Three separate problems:

1. **A plain `<script src>` cannot load an ES module.** The file contains
   `export`/`import` statements; as a classic script that is a `SyntaxError`
   and nothing runs. (Only the **IIFE** build may be loaded this way.)
2. **Modules don't leak globals.** Even if it loaded, executing a module does
   not put `createSpeakOrNoSpeak` anywhere — its exports live in the module
   namespace and are only reachable through `import ... from <that module>`.
   The reason `<script src>` works for the ort/vad tags is that *those* files
   are built to create globals.
3. **`import { createSpeakOrNoSpeak }` with no `from` is not valid syntax** —
   and a *bare* import (`from "speak-or-no-speak"`) resolves against npm
   packages, not files. In a browser it fails unless the page declares an
   **import map** (§4 B).

## 4. The three ways that do work

All three keep the two pinned CDN tags — they are still required for the Silero
engine (they provide `window.ort` and `window.vad`; without them the facade
degrades to the energy engine).

### A. Full-URL ESM import — simplest, recommended

```html
<head>
  <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
</head>
<script type="module">
  import { createSpeakOrNoSpeak }
    from "https://cdn.jsdelivr.net/gh/YOUR-USER/speak-or-no-speak@v0.1.0/build/speak-or-no-speak.esm.js";
  // API from here on
</script>
```

The import URL is simply the file's public URL. No build step, no npm.

### B. Bare name — yes, this can work, with an import map

This is the direct answer to *"would `import { createSpeakOrNoSpeak }` work
then?"* — **yes, if the page first maps the bare name to your URL**:

```html
<script type="importmap">
  {
    "imports": {
      "speak-or-no-speak":
        "https://cdn.jsdelivr.net/gh/YOUR-USER/speak-or-no-speak@v0.1.0/build/speak-or-no-speak.esm.js"
    }
  }
</script>
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
<script type="module">
  import { createSpeakOrNoSpeak } from "speak-or-no-speak";  // ← bare name now resolves
  // API from here on
</script>
```

Import maps are supported in all current browsers (Safari ≥ 16.4). This is
purely cosmetic convenience; A does the same with one tag fewer.

### C. No modules at all — the IIFE build

```html
<script src="https://cdn.jsdelivr.net/gh/YOUR-USER/speak-or-no-speak@v0.1.0/build/speak-or-no-speak.iife.js"></script>
<script>
  const { createSpeakOrNoSpeak } = window.SpeakOrNoSpeak;
  // API from here on
</script>
```

This is the flavor that behaves like the ort/vad tags: `<script src>`, global,
no `type="module"`.

## 5. Hosting from your GitHub repo — without ever touching npm

You said you do not want to commit anything to `https://cdn.jsdelivr.net/npm` —
**you don't have to.** jsDelivr does not need to be "committed to" at all:

- The `/npm/` URLs in your sketch are jsDelivr **automatically mirroring other
  people's npm packages** — you consume them, you never publish to them.
- jsDelivr also **automatically serves any public GitHub repo** via its `/gh/`
  endpoint:

  ```
  https://cdn.jsdelivr.net/gh/<user>/<repo>@<tag>/<path-inside-repo>
  https://cdn.jsdelivr.net/gh/YOUR-USER/speak-or-no-speak@v0.1.0/build/speak-or-no-speak.esm.js
  ```

  So the only "shipping" step is: commit `build/`, push, tag a release. (Your
  `build/` is already git-tracked — `git ls-files build/` lists all four files,
  and `.gitignore` doesn't exclude it — so this is just a normal commit.)

Why the jsDelivr `/gh/` link rather than other GitHub URLs (verified today):

| URL type | Works as `<script>`/module source? | Why |
|---|---|---|
| `cdn.jsdelivr.net/gh/...` | **Yes** | serves `Content-Type: application/javascript`, `Access-Control-Allow-Origin: *`, immutable 1-year cache |
| GitHub Pages (`https://user.github.io/repo/...`) | **Yes** | correct JS MIME type, cross-origin reads allowed |
| `raw.githubusercontent.com/...` | **No** | served as `text/plain` with `nosniff` → the browser refuses to execute/import it |

`raw.githubusercontent.com` links are fine for **downloading** the file (users
can save it next to their page — that's mode 2/3 in the embedding docs), just
not for linking directly.

Two practical rules for the `/gh/` URL:

- **Pin a release tag** (`@v0.1.0`), not a branch. Tag URLs are cached
  permanently and can never change under a user; branch URLs (`@main`) serve
  whatever is on the branch behind a cache that may be stale either way.
- The two CDN tags stay pinned to npm versions exactly as before — nothing
  about your own publishing changes them.

## 6. Can you rename `speak-or-no-speak.esm.js` → `speak-or-no-speak.min.js`?

Functionally **yes** — the file is already minified; renaming changes nothing
about how it runs. Two caveats:

1. **The source map breaks.** The bundle's last line is
   `//# sourceMappingURL=speak-or-no-speak.esm.js.map`. After a rename, the
   browser looks for `speak-or-no-speak.min.js.map`, doesn't find it, and logs a
   DevTools warning (harmless, but noisy). If you rename, rename the `.map` too
   and keep them consistent — or better:
2. **Do the rename in the build script, not by hand.** The clean way is to
   change the two `outfile` paths in [scripts/build-bundle.mjs](../../scripts/build-bundle.mjs)
   and rerun `npm run build:bundle` — then file, map, and banner are all
   consistent, and the rename survives every rebuild. (Renaming by hand is
   undone the next time anyone rebuilds.)

But before renaming, reconsider the *name*: `.min.js` hides which **module
format** the file is, and that is the one thing a consumer must get right —
importing the IIFE file or `<script src>`-ing the ESM file both fail with a
`SyntaxError`. The current names put the format in the filename (`esm` /
`iife`), which is the common convention for exactly this reason. If you want
"min" visible, prefer `speak-or-no-speak.esm.min.js` and
`speak-or-no-speak.iife.min.js` over a bare `.min.js`.

## 7. Concrete recipe

1. *(Optional)* If you want different filenames, edit the `outfile` paths in
   `scripts/build-bundle.mjs`, then run `npm run build:bundle`.
2. Commit `build/` (already tracked), push, create a release tag, e.g. `v0.1.0`,
   and make the repo public.
3. Hand users one of the three snippets from §4 — for "just link one file",
   snippet A with the jsDelivr `/gh/` URL is the whole story.
4. Users who prefer to *download* instead of link: copy
   `build/speak-or-no-speak.esm.js` (+ `.map`) next to their page and import it
   with a relative path — that is mode 2 in [docs/04-embedding.md](../../docs/04-embedding.md).
5. Sanity-check a published tag once with
   [test/bundle-verify.html](../../test/bundle-verify.html) pointed at the CDN
   URL — it asserts all 16 exports are present and the API works.

Nothing is ever uploaded to jsDelivr or npm by any of this: jsDelivr reads your
public GitHub repo, and the two runtime-library tags remain other people's npm
packages.
