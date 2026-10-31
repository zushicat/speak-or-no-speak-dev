# README-BUNDLE — the single-file distribution

`speak-or-no-speak` packaged as **one JavaScript file you link and import** —
no npm install, no bundler, no source checkout. Detection of speech start,
turn end, and barge-in from a microphone stream (Silero VAD + adaptive
endpointing + browser AEC).

> This document is about the **prebuilt bundle in `build/`**. For the
> zero-build source layout, npm mode, and development docs see
> [README.md](README.md) and [README-advanced.md](README-advanced.md).

---

## 1. What this is

| File | Use it when | Size (v0.1.0, minified) |
|---|---|---|
| [`build/speak-or-no-speak.esm.js`](build/speak-or-no-speak.esm.js) | your page uses `<script type="module">` / `import` | 25.1 KB (+ sourcemap) |
| [`build/speak-or-no-speak.iife.js`](build/speak-or-no-speak.iife.js) | you want a plain `<script>` and the global `window.SpeakOrNoSpeak` | 26.0 KB (+ sourcemap) |

- Both are **minified builds of `src/index.js`** with all 16 named exports
  preserved — API-identical to importing `src/index.js` (verified: Node
  import smoke + live browser check, see `test/bundle-verify.html`).
- The bundle contains **only this project's code**. The two runtime libraries
  the Silero engine needs (`@ricky0123/vad-web`, `onnxruntime-web`) are
  **loaded from pinned CDN `<script>` tags at runtime** — you add two tags,
  see §2. No other setup.
- Each file starts with a version banner:
  `/* speak-or-no-speak v0.1.0 — single-file bundle (ESM). Docs: README-BUNDLE.md · rebuild: npm run build:bundle */`
- Sourcemaps (`.js.map`) sit next to the artifacts — keep them in the same
  folder for readable stack traces. Rebuild at any time:

      npm run build:bundle                 # minified (default)
      npm run build:bundle -- --no-minify  # readable, for debugging

  The build is idempotent (byte-identical for unchanged sources) and fails
  loudly if a new bare import ever appears in `src/` without being accounted
  for — dependencies are never silently dropped.

## 2. Quick start — ESM (recommended)

Copy `build/speak-or-no-speak.esm.js` (and the `.map`) next to your page, then:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <!-- Pinned CDN runtime deps — REQUIRED for the Silero engine (see §4) -->
  <script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
</head>
<body>
  <button id="start">Start microphone</button>
  <script type="module">
    import { createSpeakOrNoSpeak } from "./speak-or-no-speak.esm.js";

    const sons = await createSpeakOrNoSpeak({
      onSpeechStart: () => console.log("user started"),
      onTurnEnd: (e) => console.log("turn end", e.durationMs, "ms"),
      onInterrupt: (i) => console.log("barge-in after", i.latencyMs, "ms"),
    });

    // Call start() from a user gesture (Safari requires it for mic access).
    document.getElementById("start").addEventListener("click", () => sons.start());
  </script>
</body>
</html>
```

**Serve the page over `http://localhost` or `https`** — microphone access
needs a secure context; `file://` will NOT work.

## 3. Quick start — IIFE (classic script, no modules)

Same two CDN tags; then the bundle defines a global:

```html
<script src="./speak-or-no-speak.iife.js"></script>
<script>
  const { createSpeakOrNoSpeak } = window.SpeakOrNoSpeak;
  // identical API from here on
</script>
```

## 4. Requirements

- **Secure context** — serve via `https://` or `http://localhost` (never
  `file://`), otherwise `getUserMedia` is unavailable (`insecure-context`).
- **CDN reachability at runtime** (pinned versions):
  - the two `<script>` tags above: `onnxruntime-web@1.22.0`,
    `@ricky0123/vad-web@0.0.31`;
  - vad-web then fetches the Silero model (`silero_vad_v5.onnx`) and the
    audio-worklet from `cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/`
    and the ORT WASM binaries from
    `cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/` (paths pinned inside
    the bundle's engine adapter).
  - If the CDN is unreachable, the module **degrades to the energy-based
    fallback engine** (§12) instead of failing the page.
- **Browsers:** a current Chromium browser and/or Safari (same support matrix
  as the source project; mobile is out of scope for v1).
- **License:** MIT. The bundle ships no third-party code — the CDN tags bring
  in vad-web/onnxruntime-web under their own licenses at runtime.

## 5. API reference

### `createSpeakOrNoSpeak(options?) → Promise<SpeakOrNoSpeak>`

Async factory. Does **not** touch the microphone yet — that happens in
`start()`. All options are optional.

| Option | Type / default | Meaning |
|---|---|---|
| `mic` | `MediaTrackConstraints`, default AEC on | Merged **per key** over the defaults `{ channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }` — e.g. `mic: { echoCancellation: false }` disables only AEC (activates stricter barge-in gating, §12) |
| `thresholds` | `Partial<Thresholds>`, merged over defaults | Detection thresholds — see table below |
| `engine` | `VadEngine` | Advanced: inject a custom engine (tests, experiments). Injecting one disables the automatic energy fallback unless you also pass `energyEngine` |
| `energyEngine` | `VadEngine` | Advanced: replaces the default `EnergyVad` as the fallback target |
| `turnModel` | `TurnModel` | Optional semantic end-of-turn model — see §11 |
| `debug` | `boolean`, default `false` | Records state-transition traces on the detector (read via `sons._detector.traces`) |
| `onSpeechStart` | `() => void` | **S1** — user started speaking |
| `onTurnEnd` | `(e: TurnEndEvent) => void` | **S2** — utterance complete (carries the turn audio) |
| `onInterrupt` | `(info: InterruptInfo) => void` | **S3** — user barged in while the agent speaks |
| `onLevel` | `(rms: number) => void` | Per-frame loudness 0..1 (~31 events/s at Silero v5's 32 ms frames) |
| `onError` | `(e: EngineError) => void` | Engine problems — codes in §7 |

**Thresholds** (defaults; frame counts are calibrated for Silero v5's 32 ms frames):

| Key | Default | Meaning |
|---|---|---|
| `onsetSpeechThreshold` | 0.6 | frame "is speech" level |
| `negativeSpeechThreshold` | 0.35 | hysteresis floor |
| `onsetConfirmFrames` | 9 | ×32 ms = 288 ms onset confirm window |
| `minSpeechMs` | 250 | discard coughs/clicks shorter than this |
| `redemptionMs` | 650 | BASE silence that ends a turn (adapted per turn by the redemption policy, clamped 350–1200 ms) |
| `shortPauseMs` | 250 | interior silence that opens the PAUSE sub-state (never ends the turn) |
| `preSpeechPadMs` | 200 | audio before onset kept in the turn audio |
| `bargeInConfirmFrames` | 6 | ×32 ms ≈ 192 ms barge-in confirm (echo protection) |
| `maxTurnMs` | 30000 | force-end long turns (`truncated: true`) |
| `graceAfterInterruptMs` | 500 | post-interrupt silence ignored (keeps one utterance whole) |
| `noAecBargeInConfirmMs` | 300 | stricter barge-in window without AEC |
| `noAecRmsFactor` | 2 | without AEC: frame rms must exceed 2× the rolling agent-playback rms |
| `modelTimeoutMs` | 300 | max wait for the semantic turn model before failing open |

### The facade

| Member | Meaning |
|---|---|
| `start()` → `Promise<void>` | Opens the mic and starts detection. Resolves when the first frame arrives; rejects on fatal errors (§7). May transparently degrade to the energy engine (§12) |
| `stop()` | Stops the engine, releases the mic, resets state. Idempotent |
| `setAgentSpeaking(active)` | Arm/disarm barge-in mode while your app plays audio — see §9 (**always disarm**, see below) |
| `state` → `"idle" \| "ready" \| "listening"` | `"idle"` = not started, `"ready"` = listening, `"listening"` = speech detected (interior pauses stay "listening") |
| `degraded` → `{ aec: boolean, engine: "silero" \| "energy" }` | Degradation flags — surface both in your UI (§12) |
| `_detector`, `_engine` | Advanced/testing only — not a stable API |

## 6. Event payloads

**`TurnEndEvent`** (S2 — the main event):

| Field | Type | Meaning |
|---|---|---|
| `audio` | `Float32Array` | 16 kHz mono, includes the 200 ms pre-speech pad — feed to STT, save as WAV, replay |
| `durationMs` | `number` | speech + pad duration (audio length) |
| `truncated` | `boolean` | force-ended at `maxTurnMs` |
| `afterInterrupt` | `boolean` | this turn started with a barge-in |
| `stats` | `{ speechMs, interiorPauses, longestPauseMs, turnMs }` | turn rhythm (tuning/telemetry) |

**`InterruptInfo`** (S3): `atMs` (ms since the agent flag was armed),
`latencyMs` (voice-onset → event; ≈ the confirm window actually waited).

**`EngineError`**: `{ code: string, message: string }` — codes in §7.

## 7. Error codes

Delivered both ways: **thrown** from `start()` (as `SpeakError` with `.code`)
and **emitted** via `onError` (plain `{ code, message }`).

| Code | Class | Meaning |
|---|---|---|
| `mic-denied` | fatal | permission rejected by user/OS |
| `mic-not-found` | fatal | no microphone device |
| `insecure-context` | fatal | not served over https/localhost — mic API unavailable |
| `cdn-unavailable` | fatal* | neither the CDN scripts (`window.vad`) nor the npm package could be loaded → *the facade falls back to the energy engine (§12)* |
| `engine-load-failed` | fatal* | ORT/model/MicVAD load or start threw → *energy fallback* |
| `no-aec` | warning | echo cancellation not active on the mic track — stricter barge-in gating active, headphones recommended |
| `engine-fallback` | warning | running on the energy engine (`degraded.engine === "energy"`) |
| `audio-pipeline` | runtime | AudioContext/capture failure at runtime |
| `vad-no-frames` | runtime | engine started but produced no frames within 5 s — try reloading |

\* fatal for the Silero engine, but the facade degrades to the energy engine
instead of failing the page. `humanMessage(code)` returns a ready-made UI
sentence for every code.

## 8. All exports (16)

`import { … } from "./speak-or-no-speak.esm.js"` — or
`window.SpeakOrNoSpeak.…` in IIFE mode:

| Export | One-liner |
|---|---|
| `createSpeakOrNoSpeak` | the facade factory (§5) — all you need for standard use |
| `SileroVadAdapter` | default Silero v5 engine adapter (advanced: construct + pass as `engine`) |
| `EnergyVad` | energy-based fallback engine (degraded, noise-blind) |
| `energyProbability` | pure RMS-vs-noise-floor probability helper (unit-testable) |
| `SpeakError` | `Error` subclass carrying the stable `code` |
| `ERROR_CODES` | the 9 stable codes (§7) |
| `humanMessage` | human-readable sentence per code for UI surfaces |
| `SmartTurnModel` | optional semantic end-of-turn model (§11) |
| `SttAdapter` | transcription plug-point interface (§10) |
| `CloudStubAdapter` | shipped STT example: WAV POST → `{text, confidence}` (§10) |
| `TurnDetector` | the pure turn state machine (advanced/unit testing) |
| `redemptionFor` | adaptive redemption-window policy (advanced) |
| `encodeWav` | Float32 → WAV `Blob` (browser) / `Buffer` (Node) |
| `encodeWavBytes` | Float32 → WAV `ArrayBuffer` (pure bytes) |
| `DEFAULTS` | the full default options object (§5) |
| `mergeOptions` | the recursive merge helper used for options |

## 9. Agent integration (read this, app authors!)

While your app plays audio (TTS etc.), call `setAgentSpeaking(true)`; call
`setAgentSpeaking(false)` the moment your output stops.

- With the flag **armed**, no `onTurnEnd` and no `onSpeechStart` fire.
  Confirmed user speech triggers `onInterrupt` instead (barge-in).
- **Forgetting to disarm permanently silences turn detection** — a turn that
  already reached its redemption window flushes at the moment you disarm.
- The interrupt carries `{ atMs, latencyMs }`.

```js
const sons = await createSpeakOrNoSpeak({ onTurnEnd, onInterrupt });
await sons.start();
sons.setAgentSpeaking(true);   // agent starts talking
// … user barges in → onInterrupt → stop TTS playback …
sons.setAgentSpeaking(false);  // agent output ended — ALWAYS call this
```

**Post-interrupt contract:**

1. `onInterrupt` fires → **immediately cancel your TTS/LLM stream** (the
   latency-sensitive path — do not await anything before cancelling).
2. Call `setAgentSpeaking(false)` once your output is actually stopped.
3. Turn accumulation continued throughout: the interrupting utterance arrives
   as the next `onTurnEnd` with `afterInterrupt: true`.
4. A 500 ms grace after the interrupt ignores silence — the turn is not
   sliced mid-word ("hey, sto—" stays one turn).
5. While the flag is set, `onTurnEnd`/`onSpeechStart` do not fire — app code
   must not depend on them during agent speech.

## 10. Adding transcription (STT plug point)

STT lives **strictly outside the real-time loop**: adapters are called only
with `onTurnEnd` audio (16 kHz mono, incl. the pre-speech pad) and never touch
detection. The module ships **no** STT engine — you supply the adapter.

```js
import { createSpeakOrNoSpeak, CloudStubAdapter } from "./speak-or-no-speak.esm.js";

const stt = new CloudStubAdapter({
  endpoint: "https://your-stt.example/transcribe", // POST, WAV body → {text, confidence}
  token: "…",                                      // from YOUR config, never hardcoded
});

const sons = await createSpeakOrNoSpeak({
  onTurnEnd: (e) => {
    stt.transcribe(e.audio, { language: "en-US" })
      .then((t) => console.log("💬", t.text))
      .catch((err) => console.warn("STT failed (detection unaffected):", err.message));
  },
});
```

- `CloudStubAdapter({ endpoint, token?, language? })` POSTs the turn as a
  16-bit PCM WAV body (built with the bundle's own `encodeWav`) and expects
  `{ text, confidence? }` JSON back. It is a ~50-line **dev example** —
  implement `SttAdapter` (`async transcribe(audio, { language }) →
  Promise<{ text, confidence? }>`) for any real backend.
- The hard rule: **no STT in the real-time path.** An adapter failure must
  never affect `onSpeechStart`/`onTurnEnd`/`onInterrupt` — wrap at YOUR level
  (as above).
- Zero-backend option: the Web Speech API (`SpeechRecognition`) can run in
  parallel and harvest final results matching the turn window — Chromium-only
  and server-backed (audio leaves the machine; privacy caveat), but zero audio
  plumbing.

## 11. Smart Turn — optional semantic end-of-turn model (WP8)

`SmartTurnModel` wraps an 8 MB int8 ONNX model (Whisper-Tiny backbone) that
judges whether an utterance is **semantically complete** — passes it via
`turnModel`:

```js
import { createSpeakOrNoSpeak, SmartTurnModel } from "./speak-or-no-speak.esm.js";

const sons = await createSpeakOrNoSpeak({
  turnModel: new SmartTurnModel({
    modelUrl: "/vendor/smart-turn-v3.2-cpu.onnx", // default; wherever you host the weights
    ort: window.ort,                              // default; from the onnxruntime-web CDN tag
    threshold: 0.5,
  }),
});
```

- Called **only at silence points**; the real-time frame budget is untouched.
- Lazy session init (~120 ms local); inference p50 ≈ 141 ms (single-threaded
  WASM, reference machine).
- **Fails open**: a load failure, rejection, or the 300 ms `modelTimeoutMs`
  emits the turn end anyway — the model can only *hold* a turn, never lose one.
- The weights are NOT in the bundle and NOT in the repo (`vendor/` is
  gitignored) — one manual download, documented in
  [README-advanced.md](README-advanced.md). Requires the
  `onnxruntime-web` CDN tag (§2) or a passed `ort` namespace.

## 12. Degradation & troubleshooting

**Degradation ladder** (automatic, always flagged — never silent):

1. Silero engine fails to load (`cdn-unavailable` / `engine-load-failed` /
   `audio-pipeline`) → one-time `engine-fallback` warning via `onError` +
   `degraded.engine = "energy"`.
2. Mic track reports `echoCancellation !== true` → `no-aec` warning +
   `degraded.aec = true`: ~300 ms barge-in confirm AND the frame rms must
   exceed 2× the rolling agent-playback rms (TTS-leakage guard).

The energy engine is **noise-blind by design** (RMS vs adaptive floor) — a
degraded mode, fine for quiet rooms, wrong for noisy ones.

| Symptom | Fix |
|---|---|
| `insecure-context` | serve via `http://localhost` or https — `file://` never works |
| `mic-denied` / `mic-not-found` | allow mic access for the site / check devices |
| `cdn-unavailable` | network/CDN blocked (VPN, offline, strict CSP) — allow `cdn.jsdelivr.net`, or see §13 |
| `vad-no-frames` | engine started but no audio arrived — reload |
| `no-aec` warning | platform without AEC or forced off — expect stricter gating; headphones recommended |
| false interrupts from loud speakers | without AEC the browser can only gate barge-in statistically — lower speaker volume or use headphones |
| Safari hangs at start | the adapter auto-retries with the ScriptProcessor path (see `processorTypeUsed` via `sons._engine`); mic needs a user gesture — call `start()` from a click |

## 13. Using the ESM bundle inside your own bundler

You can import the ESM bundle from an app built with Vite/webpack/esbuild
etc. The bundle contains exactly one bare dynamic import — the Silero
adapter's `import("@ricky0123/vad-web")` — and your build must decide how to
treat it. The adapter resolves the engine in this order at runtime:
**`window.vad` (CDN tag) → dynamic npm import → energy fallback (§12)**.

- **CDN tags present (§2):** mark `@ricky0123/vad-web` as **external** in
  your bundler config so your build doesn't try to resolve the bare import.
  At runtime `window.vad` is checked first, so the dynamic import is never
  reached — full Silero accuracy, no npm packages needed.
- **No CDN tags:** `npm i @ricky0123/vad-web onnxruntime-web` in your app and
  let your bundler resolve (and inline) the dynamic import. The tags become
  unnecessary; the ONNX model and WASM binaries are still fetched from the
  CDN, since the adapter pins those asset paths.
- **Neither:** your bundler either errors on the unresolvable import (loud,
  at build time) or leaves it failing at runtime — in which case the adapter
  catches it and the facade degrades to the energy engine (§12). A working
  setup is one of the two above.

## 14. Known limitations

- **Browser AEC cancels only browser-played audio** (TTS/`<audio>`/WebAudio in
  the same tab). Other apps' audio (TV, music players) relies on the
  confirm-window gating alone.
- **No AEC** (unsupported platform / forced off): stricter barge-in gating
  activates automatically (`degraded.aec = true`); loud speakers may still
  cause false interrupts — recommend headphones.
- **Energy fallback** (`degraded.engine = "energy"`): noise-blind by design —
  a degraded mode, always flagged, never silent.
- **Safari:** TTS `speechSynthesis` quirks (async voice loading, `pause()`
  flakiness) affect app code, not the module; iOS Safari needs a user gesture
  for the mic; mobile support out of scope for v1.
- The bundle pins vad-web 0.0.31 + onnxruntime-web 1.22.0 **via the CDN tags
  you add** — keep the pinned versions from §2 in sync when upgrading.

---

*Built from `src/` at v0.1.0 (rev-2, WP-B1) · rebuild: `npm run build:bundle`
· worked example with all three load modes:
[`test/bundle-verify.html`](test/bundle-verify.html)*
