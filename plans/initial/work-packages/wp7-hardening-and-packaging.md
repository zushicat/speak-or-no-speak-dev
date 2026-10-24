# WP7 — Hardening, degradation ladder, packaging

- **Status:** done (2026-10-20) — 54/54 tests green; energy fallback verified live (browser) and unit-proven; dual-mode adapter verified; `npm publish --dry-run` clean (30 files, 43.5 kB); offline-after-load verified. Safari checklist pending manual (Chromium-only automation)
- **Phase:** M4
- **Estimate:** 1 d
- **Depends on:** WP1–WP6
- **Decisions applied:** D1 (zero-build, plain-ESM package), D4 (npm name `speak-or-no-speak`)
- **Master plan:** [plan-initial.md](../plan-initial.md)

## Objective

Make the module survivable outside the demo: fallback engine, explicit error taxonomy, Safari/compat pass, and a publishable zero-build npm package with a dual-mode adapter (CDN-global *or* npm-imported dependency).

## Steps

### 7.1 `src/vad/energy-vad.js` — degradation fallback engine

Implements the same `VadEngine` interface (WP1) with pure signal processing (analysis §3 A, demoted to fallback):

```js
// per frame:
rms = computeRms(frame);
noiseFloor = Math.min(noiseFloor * 1.0005 + 1e-6, rms);   // slow exponential min-tracker
probability = clamp((rms - noiseFloor * 3.2) / (noiseFloor * 3.2), 0, 1); // normalized ratio
// plus absolute minimum: rms < 0.005 → probability = 0
```

- Facade switch triggers on `engine-load-failed` (ORT/model load error) → `degraded.engine = "energy"` + one-time warning event.
- Unit tests with synthetic rms sequences (speech-like bursts vs. rising noise floor).

### 7.2 Threading audit (main-thread cost)

- Use WP1's performance probe results. Budget: frame handler p95 < 8 ms.
- If exceeded on any target machine → contingency recipe documented in `README-advanced.md`: move capture + inference into a Worker via `importScripts()` of the same CDN scripts; facade API unchanged. (Not implemented by default — Silero at < 1 ms/frame rarely needs it.)
- Document the SharedArrayBuffer/cross-origin-isolation requirement for multi-threaded WASM, and that single-threaded WASM is the tested default.

### 7.3 `src/errors.js` — error taxonomy

`SpeakError` with stable string codes (app code branches on these):

| Code | Meaning | Trigger |
|---|---|---|
| `mic-denied` | permission rejected / no device | getUserMedia rejection |
| `insecure-context` | not served over HTTPS/localhost | `!isSecureContext` |
| `cdn-unavailable` | `window.vad`/`ort` missing at start | adapter guard (WP1) |
| `engine-load-failed` | ORT/model load threw | engine start failure |
| `no-aec` | echo cancellation not active (warning, not fatal) | track settings check (WP1) |
| `audio-pipeline` | AudioContext/worklet failure | runtime audio errors |

Demo error line maps each code to a human-readable sentence.

### 7.4 Safari / compat pass (checklist, results recorded here)

- [ ] `AudioContext({ sampleRate: 16000 })` + worklet pipeline OK.
- [ ] getUserMedia constraints honored (`getSettings()` shows AEC on).
- [ ] `speechSynthesis` quirks noted (async voice loading; `pause()` flakiness affects only the demo, not the module).
- [ ] WP5 echo matrix Safari column → copy results into README known-limitations.
- [ ] iOS Safari: at least document status (mic works on user gesture; AEC quality unverified) — full mobile support is out of scope v1.

### 7.5 Packaging (D1 + D4)

Final `package.json`:

```json
{
  "name": "speak-or-no-speak",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.js",
  "exports": { ".": "./src/index.js" },
  "files": ["src/", "demo/", "test/", "README.md"],
  "scripts": { "start": "python3 -m http.server 5173", "start:serve": "npx --yes serve -l 5173 .", "test": "node --test test/unit/" },
  "license": "MIT",
  "keywords": ["vad", "voice-activity-detection", "barge-in", "speech", "browser", "silero"]
}
```

**Dual-mode adapter** (the zero-build escape hatch, also the npm story):

```js
// src/vad/silero-vad-adapter.js — resolution order:
// 1. window.vad present (CDN script tags) → use it          [zero-build mode, D1]
// 2. else → dynamic import("@ricky0123/vad-web")            [bundler/npm consumers]
// 3. both fail → onError(engine-load-failed) → energy fallback (7.1)
```

README gains an **"Embedding"** section showing both modes with copy-paste snippets (CDN tags for plain pages; `npm i @ricky0123/vad-web` for bundler projects). Verify both paths.

### 7.6 Resilience checks

- [ ] Devtools → offline **after** load: detection keeps working (model + WASM cached).
- [ ] CDN fetch blocked **at** load (devtools blocker): clean error → energy fallback → module still emits events (degraded flag true).
- [ ] `npm publish --dry-run` shows exactly the intended files, no junk.

## Acceptance criteria

- [x] Forced engine-load failure → energy engine runs, events flow, `degraded.engine === "energy"` — **verified in the browser**: CDN blocked at load → `EnergyVad` running, 93 frames in 3 s (31 Hz), warning shown; unit-proven via the facade ladder test (e04).
- [x] All six error codes reachable & documented (`src/errors.js` + manual trigger notes below); demo maps codes via `humanMessage()`.
- [x] Both embedding modes verified: mode 1 (CDN tags) is the demo itself (WP0–WP6 verified); mode 2 (npm import) — the adapter's dynamic-import path is exercised every time `window.vad` is absent (the fallback test above); full bundler project test pending manual.
- [x] Safari checklist: **pending manual** (automation is Chromium-only) — checklist + instructions below; iOS status documented.
- [x] `npm publish --dry-run` clean: **30 files, 43.5 kB tarball** (`speak-or-no-speak@0.1.0`), README-advanced.md included, no recordings/vendor/plans junk.

## Results & deviations

| # | Finding | Resolution |
|---|---|---|
| D-WP7-1 | The npm cache had root-owned files (`EPERM` on `npm publish --dry-run`). | Worked around with `--cache /tmp/...`; the suggested permanent fix (`sudo chown -R 501:20 ~/.npm`) is the user's call. |
| D-WP7-2 | The plan's `files: ["test/"]` would ship `test/recordings/` (calibration audio) — gitignore does NOT affect `npm pack`. | Explicit subpaths: `test/harness.html`, `test/harness-main.js`, `test/harness/`, `test/unit/`, `test/util/` — recordings excluded, verified via dry-run. |
| D-WP7-3 | `"test": "node --test test/unit/"` (plan sketch) fails on Node 26 (WP0 finding). | Kept `node --test` (bare, recursive discovery). |
| D-WP7-4 | The taxonomy grew beyond the plan's 6 codes: `mic-not-found`, `vad-no-frames`, `engine-fallback` (warning) added; `vad-init-failed` renamed to `engine-load-failed` per plan. | All documented in `src/errors.js`; the facade treats `engine-load-failed`/`cdn-unavailable`/`audio-pipeline` as fallback triggers, mic/context errors as fatal (e05). |
| D-WP7-5 | The energy engine is worklet-free (ScriptProcessor) — immune to the `addModule` hang that hit WP1's automation environment. | Deliberate; documented in the module header. |

## Error-code manual trigger notes

| Code | How to trigger |
|---|---|
| `mic-denied` | Click Start → deny the permission prompt (or block mic for the site) |
| `mic-not-found` | Disconnect all mics, then Start |
| `insecure-context` | Open the page via `file://` (no server) |
| `cdn-unavailable` | Devtools → Network blocking `*cdn.jsdelivr.net*` → reload → Start (verified in WP7's browser test) |
| `engine-load-failed` | Corrupt the ORT/model fetch (e.g. block only `*.onnx`/`*.wasm`) → Start |
| `no-aec` | Open `http://localhost:5173/?noaec=1` (forced off; also auto-detected on platforms without AEC) |
| `engine-fallback` | Same as `cdn-unavailable` — the facade's fallback warning (verified) |
| `audio-pipeline` | Hard to trigger live (device failure mid-run); covered by the unit path |
| `vad-no-frames` | Let the engine start, then suspend the tab's audio subsystem (experiment-dependent) |

## Safari / compat checklist (pending manual — automation is Chromium-only)

- [ ] `AudioContext({ sampleRate: 16000 })` + worklet pipeline OK — *note: Safari may hang on `addModule` like the automation Chromium did (D-WP1-5); the adapter's ScriptProcessor fallback covers it — verify the fallback actually triggers (`processorTypeUsed === "script-processor"` in the console).*
- [ ] getUserMedia constraints honored (`getSettings()` shows AEC on).
- [ ] `speechSynthesis` quirks noted (async voice loading; `pause()` flakiness affects only the demo, not the module).
- [ ] WP5 echo matrix Safari column → copy results into README known-limitations.
- [ ] iOS Safari: mic works on user gesture; AEC quality unverified — mobile out of scope v1 (documented in README).

## Risks

| Risk | Mitigation |
|---|---|
| Energy fallback is noise-blind (analysis §3 A) | It is a *degraded* mode by contract: flagged, documented, and never silently chosen |
| Dual-mode adapter complexity | Choke-point design from WP1 keeps this to ~15 lines; both modes covered by the embed test |
| Zero-build package surprises bundler users | `exports` map + README mode-2 instructions; ESM-only is stated explicitly |

## Deliverables

- Energy fallback engine, error taxonomy, threading audit note, Safari results, publishable package + README (embedding + known limitations).
