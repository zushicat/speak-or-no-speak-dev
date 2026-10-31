# Revision 2 Plan — Build Version: single-file bundle in `build/`

- **Date:** 2026-10-24 · **Status:** executed — WP-B1–B4 complete 2026-10-31, acceptance A1–A5 all green (see §5); WP-B5 optional, not started
- **Input:** [rev-2.md](rev-2.md) · Builds on the completed initial plan ([../initial/plan-initial.md](../initial/plan-initial.md), WP1–WP9)
- **Note:** rev-2.md still carries its draft wording ("Revision 1", plan path `plans/rev-1/plan-rev-1.md`). Revision 1 is the real-STT work already committed on branch `add_real_sst` (its plan: `plans/rev-1/plan-rev-1.md` in git history). Per your decision this plan lives in `plans/rev-2/` — the bundle task is **project revision 2**. Working branch: `build-version`.

---

## 0. Resolved decisions

| # | Decision | Resolution |
|---|---|---|
| D1 | Bundler tool | **esbuild** — the only new (dev) dependency. Bundles the existing plain-ESM sources as-is, emits ESM + IIFE from one entry, no config bloat, fast. |
| D2 | Bundle scope | **Our own code only** (your choice). `@ricky0123/vad-web` + `onnxruntime-web` stay runtime-CDN dependencies, exactly like today's Mode 1 — consumers add the two pinned `<script>` tags (see §2 F3). |
| D3 | Artifacts | `build/speak-or-no-speak.esm.js` (named exports preserved) and `build/speak-or-no-speak.iife.js` (global `window.SpeakOrNoSpeak`), minified, with sourcemaps and a one-line version banner. |
| D4 | Source policy | `src/` stays **untouched** in the core scope — the bundle must not fork behavior. Optional WP-B5 (configurable CDN asset base paths) only on request. |
| D5 | Docs | `README-BUNDLE.md` = the single usage guide for the bundle; `README.md` gets a one-line pointer in the Embedding section. |

## 1. Objective & scope

Produce an **all-in-one, single-link distribution** of the `speak-or-no-speak` module so that using it elsewhere means "copy/link one file (plus the two CDN tags), import, call `createSpeakOrNoSpeak()`" — no build step, no `node_modules`, no source checkout.

**Deliverables**

1. `build/` containing the bundle artifacts (D3) + sourcemaps, produced by a reproducible `npm run build:bundle`.
2. `README-BUNDLE.md` — complete how-to-use guide: quick starts (ESM + IIFE), full options/API reference, event payloads, error taxonomy, agent-integration contract, degradation flags, limitations.
3. A verification page proving the bundle works **standalone** (not importing `src/`), plus a cross-project smoke test ("link it elsewhere").

**Out of scope:** bundling vad-web/onnxruntime-web into the artifact (D2), the demo page/index.html redesign, STT endpoint work (rev-1), self-hosted ONNX/WASM assets (WP-B5, optional), publishing to npm.

## 2. Facts the bundle must respect (verified against the current tree)

| # | Fact | Consequence for the bundle |
|---|---|---|
| F1 | Public entry is `src/index.js`; **16 named runtime exports**: `createSpeakOrNoSpeak`, `SileroVadAdapter`, `EnergyVad`, `energyProbability`, `SpeakError`, `ERROR_CODES`, `humanMessage`, `SmartTurnModel`, `SttAdapter`, `CloudStubAdapter`, `TurnDetector`, `redemptionFor`, `encodeWav`, `encodeWavBytes`, `DEFAULTS`, `mergeOptions` | esbuild ESM output preserves named exports 1:1 — the bundle is API-identical to `src/index.js`. `types.js` is JSDoc-only and tree-shakes away. |
| F2 | The module graph is pure ESM with **zero npm dependencies** (`package.json` has no `dependencies`); raw source ≈ 88 KB over 15 files | esbuild needs no shims; expect a minified bundle of roughly **35–50 KB** (exact size reported at build time). |
| F3 | Runtime deps are pinned CDN globals: `<script>` tags for `onnxruntime-web@1.22.0/dist/ort.wasm.min.js` + `@ricky0123/vad-web@0.0.31/dist/bundle.min.js` (`index.html:28-29`); the adapter reads `window.vad` (`silero-vad-adapter.js:200`) and fetches the worklet + `silero_vad_v5.onnx` from `VAD_WEB_BASE`, ORT wasm from `ORT_WEB_BASE` (`silero-vad-adapter.js:47-49`) | Bundle consumers must include those same two tags (or bundle vad-web themselves). The README copies the tags verbatim with pinned versions. |
| F4 | `silero-vad-adapter.js:204` does a bare dynamic `import("@ricky0123/vad-web")` | Must be marked **external** in esbuild, else the build fails to resolve it. In the shipped browser bundle a bare specifier cannot resolve → the adapter catches it → `cdn-unavailable` → the facade's WP7 ladder (`speak-or-no-speak.js:78-95`) degrades to the energy engine. No code change needed; behavior must be verified (§6 A3). |
| F5 | Degradation ladder is built in: Silero fails → `EnergyVad` fallback, one-time `engine-fallback` warning, `degraded.engine = "energy"`; no-AEC mic → stricter barge-in gating, `degraded.aec = true` | The bundle keeps all degradation semantics; README-BUNDLE documents both flags and what they mean for the UI. |
| F6 | Error taxonomy is 9 stable codes (`src/errors.js`): fatal `mic-denied`, `mic-not-found`, `insecure-context`, `cdn-unavailable`, `engine-load-failed`; warnings `no-aec`, `engine-fallback`; runtime `audio-pipeline`, `vad-no-frames` | README-BUNDLE gets the full table with the fatal/warning/runtime classification. |
| F7 | `SmartTurnModel` (WP8) is optional: needs `window.ort` (or `options.ort`) and the 8 MB `vendor/smart-turn-v3.2-cpu.onnx` (gitignored, manual download per README-advanced), default `modelUrl "/vendor/…"` | It stays **in** the bundle (small, ~15 KB raw); the weights stay external. README documents `modelUrl`/`ort` options + the fail-open guarantee. |
| F8 | `config.js` is deliberately Node-safe; browser-only code guards `window` access at call time | The ESM bundle can be smoke-imported in Node (`node -e "import(…)"`) to verify the export surface without a browser (§6 A4). |
| F9 | `demo/` is UI wiring only, no detection logic | The bundle contains nothing from `demo/`; the verification page is a new minimal consumer, not a demo fork. |

## 3. Build architecture

```
src/index.js ──esbuild──▶ build/speak-or-no-speak.esm.js    (ESM, minified, .map, banner)
   (16 exports,                 build/speak-or-no-speak.iife.js  (IIFE → window.SpeakOrNoSpeak, .map)
    @ricky0123/vad-web
    marked external)
```

**Build recipe** — new files:

- `scripts/build-bundle.mjs` — esbuild JS API, two builds from one entry:
  - ESM: `entryPoints: ["src/index.js"]`, `bundle`, `format: "esm"`, `platform: "browser"`, `target: "es2020"`, `minify`, `sourcemap`, `external: ["@ricky0123/vad-web"]`, `legalComments: "eof"`, `banner` with name/version/pointer to README-BUNDLE.md.
  - IIFE: same, but `format: "iife"`, `globalName: "SpeakOrNoSpeak"`. The external dynamic `import()` stays a runtime `import()` (es2020 target) — it fails harmlessly in classic-script pages per F4 and is caught by the adapter.
  - `metafile: true` → the script prints artifact sizes and the kept top-level modules (size report in the build log).
- `package.json`: `devDependencies: { esbuild }` (creates the first `package-lock.json` — commit it), plus `"build:bundle": "node scripts/build-bundle.mjs"`.

**Resulting tree**

```
build/
├── speak-or-no-speak.esm.js          # link this from <script type="module"> or an import
├── speak-or-no-speak.esm.js.map
├── speak-or-no-speak.iife.js         # or this from a classic <script>
└── speak-or-no-speak.iife.js.map
```

Artifacts are **committed** (that is the point of `build/` here — linkable/pinnable); they only change when `src/` changes, and `npm run build:bundle` regenerates them idempotently. (Alternative — gitignore `build/` — noted in §8.)

## 4. Work packages

### WP-B1 — Build tooling (D1/D3)
`scripts/build-bundle.mjs` + npm script + esbuild devDep. Acceptance: `npm run build:bundle` produces the 4 files, prints sizes, is idempotent, and fails loudly if a new bare import ever appears in `src/` without being externalized (F4 guard).

### WP-B2 — Standalone verification page
`test/bundle-verify.html` + `test/bundle-verify-main.js` — a minimal consumer (green/orange dot, start button, event log like the demo) importing **only** the bundle:
- default: `import("../build/speak-or-no-speak.esm.js")`;
- `?mode=iife`: classic `<script>` + `window.SpeakOrNoSpeak`;
- `?nocdn=1`: omits the two CDN tags → must end on the energy engine with the `engine-fallback` warning shown, never a crash (F4/F5).
Acceptance: both modes reach `degraded.engine === "silero"` with the tags present; events (`onSpeechStart`/`onTurnEnd`/`onLevel`) log; turn WAV save link works (`encodeWav`); no console errors.

### WP-B3 — `README-BUNDLE.md` (D5)
Sections (outline):
1. **What this is** — one-file distribution; artifact table; rebuild command; version banner meaning.
2. **Quick start ESM** — copy-paste HTML: the two pinned CDN tags (`index.html:28-29` verbatim) + `<script type="module">` importing the bundle; serve over **localhost/https**; call `start()` from a user gesture (Safari).
3. **Quick start IIFE** — classic script + `const { createSpeakOrNoSpeak } = SpeakOrNoSpeak`.
4. **Requirements** — secure context, CDN reachability (vad-web 0.0.31, ORT 1.22.0, silero_vad_v5.onnx), browser support.
5. **API reference** — `createSpeakOrNoSpeak(options)` → `Promise<SpeakOrNoSpeak>`; full options table (`mic`, all 13 `thresholds` with defaults from `src/config.js`, `engine`, `energyEngine` (advanced, `speak-or-no-speak.js:85-91`), `turnModel`, `debug`, the five callbacks); facade members `start`/`stop`/`setAgentSpeaking`/`state` (`"idle"|"ready"|"listening"`)/`degraded` (`{aec, engine}`) + advanced `_detector`/`_engine`.
6. **Event payloads** — `TurnEndEvent` (`audio`, `durationMs`, `truncated`, `afterInterrupt`, `stats{speechMs, interiorPauses, longestPauseMs, turnMs}`), `InterruptInfo` (`atMs`, `latencyMs`), `EngineError` (`code`, `message`) — from `src/types.js`.
7. **Error codes** — the 9-code table (F6) with fatal/warning/runtime classification + `humanMessage()` mapping.
8. **All 16 exports** — one-liner table (F1), incl. advanced ones (`TurnDetector`, `redemptionFor`, `DEFAULTS`, `mergeOptions`, `encodeWav`/`encodeWavBytes`).
9. **Agent integration** — `setAgentSpeaking(true/false)` contract + the 5 post-interrupt rules (condensed from README.md, incl. "forgetting to disarm permanently silences detection").
10. **STT plug point** — `CloudStubAdapter` example; the hard rule: no STT in the real-time loop, wrap failures at the app level.
11. **Smart Turn (optional)** — `SmartTurnModel({ modelUrl, ort, threshold })`, 8 MB vendor asset manual download → README-advanced pointer, fail-open semantics.
12. **Degradation & troubleshooting** — silero→energy ladder, `degraded.aec` meaning + headphone advice, `?nocdn` behavior, `insecure-context` fix (serve, never `file://`).
13. **Using the ESM bundle inside your own bundler** — `import("@ricky0123/vad-web")` must then resolve → `npm i @ricky0123/vad-web onnxruntime-web`, or keep the CDN tags.
14. **Known limitations** — carried over from README.md (AEC scope, energy fallback blindness, Safari quirks).
Plus: a one-line pointer added to README.md §Embedding.

### WP-B4 — Acceptance (§6) and cross-project check
The true "only have to link it" test: minimal consumer project in a temp dir with **only** the two bundle files + a tiny page, served on a second port, verified in the browser (ESM and IIFE).

## 5. Verification & acceptance

- **A1 Tests:** `npm test` (`node --test`) stays fully green — core scope touches no `src/` code.
- **A2 Export surface:** Node smoke import of `build/speak-or-no-speak.esm.js` prints exactly the 16 named exports of F1 (F8 makes this safe).
- **A3 Browser, both modes:** verification page (WP-B2) — silero engine active, speech/turn/barge-in events fire, degraded flags correct, `?nocdn=1` degrades gracefully instead of crashing. Browser automation via the session's ego-browser skill, or manual click-through.
- **A4 Cross-project:** temp consumer project linking only `build/` artifacts (A-copy, not the repo) — start + events work from the copied file in both modes.
- **A5 Size report:** artifact sizes recorded in the build log (and quoted back in the completion summary).

## 6. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | esbuild cannot resolve `import("@ricky0123/vad-web")` | Marked external (D2/F4); the build fails loudly on any future unresolved bare import instead of silently dropping it. |
| R2 | IIFE consumers without the CDN tags get a confusing failure | `cdn-unavailable` → energy fallback + visible `onError` warning; documented in README-BUNDLE §12 and exercised via `?nocdn=1` (A3). |
| R3 | Minified bundle is hard to debug | Sourcemaps ship next to each artifact; a `--no-minify` flag on the build script gives a readable rebuild. |
| R4 | Committing generated artifacts causes diff churn | Artifacts change only when `src/` changes; regeneration is one command; alternative (gitignore) in §8. |
| R5 | CDN version drift breaks consumers silently | README-BUNDLE pins the exact versions in copy-paste tags (F3) and lists the URLs the adapter fetches assets from. |

## 7. Execution order

WP-B1 → WP-B2 → WP-B4 (A1–A5) → WP-B3 (README written last, so it documents the verified artifact and real sizes) → final review of `build/` + docs.

## 8. Open points — defaults applied unless you object

1. **Commit `build/` artifacts** (default: yes, per §3; say the word and I gitignore them instead).
2. **WP-B5 (optional):** make the CDN asset base paths (`VAD_WEB_BASE`/`ORT_WEB_BASE`, `silero-vad-adapter.js:47-49`) configurable via facade options for fully self-hosted assets — only if you want offline/self-hosted operation; not in core scope (D4).
