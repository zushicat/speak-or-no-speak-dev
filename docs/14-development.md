# Development: build, test & publish

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Troubleshooting](13-troubleshooting.md) · next: [Design background](15-design-background.md)

## Repository layout

```
demos/                the demo pages: index.html + main.js (the demo),
                      demo-esm-bundle.html / demo-iife-bundle.html /
                      demo-simplified-iife-bundle.html (bundle variants),
                      assets/ (ambient MP3s, agent-voice sample, favicon, sources.md),
                      simple-demos/stt-stub-server.py (dev-only STT stub)
src/                  the module itself
  index.js            the public export surface (the only module consumers import)
  speak-or-no-speak.js  the facade: createSpeakOrNoSpeak(options)
  config.js           DEFAULTS + mergeOptions
  errors.js           SpeakError + ERROR_CODES + humanMessage
  types.js            the typed contract as JSDoc @typedefs
  wav-export.js       zero-dependency WAV encoder (encodeWav / encodeWavBytes)
  vad/                engine interface + Silero adapter + energy fallback
                      + aec-scope.js (AEC-scope negotiation/classification)
  turn/               the pure state machine (turn-detector.js) + ring buffer
                      + echo-correlation.js (correlation echo gate)
  turn-model/         optional semantic end-of-turn model + its feature pipeline
  stt/                transcription plug point (interface + example adapter)
  agent-audio/        echo-reference-route.js — the cancelable agent-audio route
  gate/               agent-voice-gate.js + kaldi-fbank.js + the committed
                      agent-voice-profile.json — the voice gate (default off)
test/                 node --test suites, bundle verification, replay harness,
                      calibration recordings (gitignored)
scripts/              build-bundle.mjs (the bundle builder)
                      build-agent-voice-profile.mjs (voice-gate profile builder)
build/                prebuilt ESM + IIFE bundles (+ sourcemaps)
vendor/               gitignored local assets (Smart Turn weights,
                      speaker-embedding model, optional CDN mirror)
docs_new/             this documentation
```

**Zero-build**: no bundler and no TypeScript compile for development — plain
ES modules loaded straight from the static server; the runtime libraries are
pinned via CDN `<script>` tags. Types are JSDoc `@typedef`s
([`src/types.js`](../src/types.js)) that editors resolve without a build. (The
prebuilt bundle for consumers is a *release* artifact, built on demand —
[below](#the-bundle-artifacts).)

## The bundle artifacts

[`build/`](../build) holds the single-file distributions:

| File | Use it when | Size (minified, + sourcemap) |
|---|---|---|
| `speak-or-no-speak.esm.js` | your page uses `<script type="module">` / `import` | ≈ 42 KB |
| `speak-or-no-speak.iife.js` | you want a plain `<script>` and the global `window.SpeakOrNoSpeak` | ≈ 43 KB |

- Both are **minified builds of `src/index.js`** with all **20 named exports**
  preserved — API-identical to importing the source (verified: Node import
  smoke + live browser check, [below](#rebuilding--verification)).
- The bundle contains **only this project's code** — the two runtime libraries
  are loaded from pinned CDN tags at runtime
  ([Engines and runtime libraries](09-engines-and-libraries.md)).
- Each artifact starts with a version banner:
  `/* speak-or-no-speak v0.1.0 — single-file bundle (ESM). Docs: README-BUNDLE.md · rebuild: npm run build:bundle */`
- Sourcemaps (`.js.map`) sit next to the artifacts — keep them in the same
  folder for readable stack traces.

## The build script

[`scripts/build-bundle.mjs`](../scripts/build-bundle.mjs) runs esbuild twice
(ESM + IIFE targets) with shared options:

- entry `src/index.js`, `platform: "browser"`, `target: "es2020"`,
  `bundle: true`, sourcemaps, `legalComments: "eof"`;
- **`external: ["@ricky0123/vad-web"]`** — a whitelist guard: any *new* bare
  import in `src/` that is not externalized makes esbuild **fail loudly** —
  dependencies are never silently dropped;
- the IIFE build sets `globalName: "SpeakOrNoSpeak"` (exports →
  `window.SpeakOrNoSpeak.*`);
- a per-format version banner is injected;
- **idempotent**: same `src/` → byte-identical artifacts (no timestamps);
- prints a size report plus the largest bundled modules (from the esbuild
  metafile).

## Rebuilding & verification

```bash
npm run build:bundle                 # minified (default)
npm run build:bundle -- --no-minify  # readable, for debugging
```

Verification consumer: [`test/bundle-verify.html`](../test/bundle-verify.html)
(+ [`bundle-verify-main.js`](../test/bundle-verify-main.js)) — a page that
imports **only** the bundle (never `../src/`), checks all 20 exports, and runs
detection live:

- default → ESM mode; `?mode=iife` → IIFE global; `?nocdn=1` omits the CDN
  tags and must degrade to the energy engine with an `engine-fallback`
  warning — a warning, never a crash.

## Unit tests

```bash
npm test        # node --test — zero test dependencies, Node ≥ 18
```

The suites ([`test/unit/`](../test/unit)) document the machine with synthetic
frame sequences (512 samples @ 16 kHz = 32 ms; explicit thresholds so they
test behavior, not defaults):

| Suite topic | Covers |
|---|---|
| Configuration | `DEFAULTS` shape, `mergeOptions` semantics |
| Facade | wiring with an injected mock engine: lifecycle, state getter, event forwarding, agent flag, degraded reporting |
| Ring buffer | push/flush/clear, wrap-around, oversized frames |
| Turn detector core | onset confirm, turn end, discard, hysteresis |
| Endpointing | adaptive redemption (all branch cases) + PAUSE sub-state transitions |
| Barge-in | no-AEC stricter confirm, rms-vs-baseline gate, interrupt latency (voice-onset → event) |
| AEC scope | scope classification from track settings, the stricter-gating rule (scope × route × override) |
| Agent-audio route | route mode resolution (WebKit → direct, else loopback), option validation |
| Echo gate | the correlation classifier against reference audio |
| Voice gate | profile comparison, `cosineSimilarity`/`isAgentVoice` helpers |
| Half duplex | armed frames are non-speech, no interrupts |
| Hardening | energy fallback engine + degradation ladder |
| Turn model | `TurnModel` integration with mocked models (fail-open, cancellation) |
| STT plug point | adapter interface, `CloudStubAdapter` |
| Replay | deterministic replay of calibration recordings |
| WAV export | encoder byte-level correctness |

The Node-importability rule ([Architecture](08-architecture.md#the-engine-abstraction))
is what makes this possible: engine and detector modules never touch
`window`/`navigator` at the top level.

## The replay harness and calibration recordings

**Harness** ([`test/harness.html`](../test/harness.html) +
[`harness-main.js`](../test/harness-main.js)): a calibration UI with a live
timeline canvas, a scenario recorder with ground-truth marks, and offline
replay + metrics.

**Replay** ([`test/harness/replay.js`](../test/harness/replay.js)): a
recording is `{ name, createdAt, browser, noaec, frames, events, marks }` —
frames `{t, prob, rms}` recorded from the live detector's input stream (so
replay is deterministic), events from the live detector, marks the human
ground truth. Replay feeds a **fresh `TurnDetector`** over the frames
(instant, no mic) with the current config and recomputes events + metrics —
the regression tool: *same recording + new config → new events → new metrics*.

**Recordings** ([`test/recordings/`](../test/recordings), gitignored —
calibration audio is not committed): the scenario set that drove threshold
decisions —

`s1-short-commands` · `s2-fluent` · `s3-hesitant` · `s5-music-synth` ·
`s6-typing-synth` · `s7-agent-noise` · `s8-speak-over-agent` · `s9-distance-2m`

The headline calibration result: **0 premature turn-ends** in the clean
scenarios (short commands, fluent speech, distance), but the hesitant scenario
split into 2 turns in 100 % of recordings — the evidence that motivated the
optional Smart Turn model ([Smart Turn](10-smart-turn.md#when-to-use-it-and-when-not)).

**Spike page**: [`test/spike-smart-turn.html`](../test/spike-smart-turn.html) —
the feature-parity + inference-timing experiment bench used while integrating
the model.

## Publishing

```bash
npm publish --dry-run   # verify the file list (recordings excluded)
npm publish             # ships speak-or-no-speak@0.1.0 (ESM-only)
```

The `files` field in [`package.json`](../package.json) controls what ships
(the source, demo files, test utilities, READMEs). It **excludes**
`test/recordings/` (calibration audio) and `vendor/` (optional local mirror),
and it does not include the documentation directories — always confirm the
exact list with `npm publish --dry-run` before publishing.

---

*Prev: [Troubleshooting](13-troubleshooting.md) · Next: [Design background](15-design-background.md)*
