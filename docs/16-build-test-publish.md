# Chapter 16 — Build, test & publish

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 15](15-troubleshooting.md) · next: [Chapter 17 — Background](17-background.md)

## 16.1 The bundle artifacts

[`build/`](../build) holds the single-file distributions (work package WP-B1,
rev-2):

| File | Use it when | Size (v0.1.0, minified) |
|---|---|---|
| `speak-or-no-speak.esm.js` | your page uses `<script type="module">` / `import` | 25.1 KB (+ sourcemap) |
| `speak-or-no-speak.iife.js` | you want a plain `<script>` and the global `window.SpeakOrNoSpeak` | 26.0 KB (+ sourcemap) |

- Both are **minified builds of `src/index.js`** with all **16 named exports**
  preserved — API-identical to importing the source (verified: Node import
  smoke + live browser check, [§16.3](#163-rebuilding--verification)).
- The bundle contains **only this project's code** — the two runtime libraries
  are loaded from pinned CDN tags at runtime ([Chapter 11](11-runtime-libraries.md)).
- Each artifact starts with a version banner:
  `/* speak-or-no-speak v0.1.0 — single-file bundle (ESM). Docs: README-BUNDLE.md · rebuild: npm run build:bundle */`
- Sourcemaps (`.js.map`) sit next to the artifacts — keep them in the same
  folder for readable stack traces.

## 16.2 The build script

[`scripts/build-bundle.mjs`](../scripts/build-bundle.mjs) runs esbuild twice
(ESM + IIFE targets) with shared options:

- entry `src/index.js`, `platform: "browser"`, `target: "es2020"`,
  `bundle: true`, sourcemaps, `legalComments: "eof"`;
- **`external: ["@ricky0123/vad-web"]`** — the whitelist guard (F4): any *new*
  bare import in `src/` that is not externalized makes esbuild **fail loudly**
  — dependencies are never silently dropped;
- the IIFE build sets `globalName: "SpeakOrNoSpeak"` (exports →
  `window.SpeakOrNoSpeak.*`);
- a per-format version banner is injected;
- **idempotent**: same `src/` → byte-identical artifacts (no timestamps);
- prints a size report plus the largest bundled modules (from the esbuild
  metafile).

## 16.3 Rebuilding & verification

```bash
npm run build:bundle                 # minified (default)
npm run build:bundle -- --no-minify  # readable, for debugging
```

Verification consumer: [`test/bundle-verify.html`](../test/bundle-verify.html)
(+ [`bundle-verify-main.js`](../test/bundle-verify-main.js)) — a page that
imports **only** the bundle (never `../src/`), checks all 16 exports, and runs
detection live:

- default → ESM mode; `?mode=iife` → IIFE global; `?nocdn=1` omits the CDN
  tags and must degrade to the energy engine with an `engine-fallback`
  warning — a warning, never a crash (F5).

## 16.4 Unit tests

```bash
npm test        # node --test — zero test dependencies, Node ≥ 18
```

The suites ([`test/unit/`](../test/unit)) document the machine with synthetic
frame sequences (512 samples @ 16 kHz = 32 ms; explicit thresholds so they
test behavior, not defaults):

| Suite | Covers |
|---|---|
| `config.test.js` | `DEFAULTS` shape, `mergeOptions` semantics |
| `facade.test.js` | facade wiring with an injected mock engine: lifecycle, state getter, event forwarding, agent flag, degraded reporting (WP3 t13) |
| `ring-buffer.test.js` | push/flush/clear, wrap-around, oversized frames |
| `turn-detector.test.js` | the state machine t01–t12: onset confirm, turn end, discard, hysteresis |
| `wp4-endpointing.test.js` | adaptive redemption (≥ 5 branch cases) + PAUSE sub-state transitions |
| `wp5-barge-in.test.js` | no-AEC stricter confirm, rms-vs-baseline gate, interrupt latency (`t_voice → t_event`) |
| `wp7-hardening.test.js` | energy fallback engine + degradation ladder |
| `wp8-turn-model.test.js` | `TurnModel` integration with mocked models (fail-open, cancellation) |
| `wp9-stt.test.js` | STT plug point (adapter interface, `CloudStubAdapter`) |
| `util/wav-export.test.js` | WAV encoder byte-level correctness |

The Node-importability rule ([§8.3](08-architecture.md#83-the-engine-abstraction))
is what makes this possible: engine and detector modules never touch
`window`/`navigator` at the top level.

## 16.5 The replay harness and calibration recordings

**Harness** ([`test/harness.html`](../test/harness.html) +
[`harness-main.js`](../test/harness-main.js), WP6): a calibration UI with a
live timeline canvas, a scenario recorder with ground-truth marks, and offline
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

The headline WP6 result: **0 premature turn-ends** in the clean scenarios
(s1/s2/s9), but the hesitant scenario (s3) split into 2 turns in 100 % of
recordings — the evidence that passed the WP8 Smart Turn gate
([§12.6](12-smart-turn.md#126-when-to-use-it-and-when-not)).

**Spike page**: [`test/spike-smart-turn.html`](../test/spike-smart-turn.html) —
the WP8 experiment bench (feature parity + inference timing).

## 16.6 Publishing

```bash
npm publish --dry-run   # verify the file list (recordings excluded)
npm publish             # ships speak-or-no-speak@0.1.0 (ESM-only)
```

The `files` field in [`package.json`](../package.json) ships `src/`, `demo/`,
`assets/`, the harness/test utilities, and the two READMEs — it **excludes**
`test/recordings/` (calibration audio) and `vendor/` (optional local mirror).
`plans/` and `docs/` are development artifacts and not part of the package.

---

*Prev: [Chapter 15 — Troubleshooting](15-troubleshooting.md) · Next: [Chapter 17 — Background & decisions](17-background.md)*
