# Chapter 5 — API reference

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 4](04-embedding.md) · next: [Chapter 6 — Agent integration](06-agent-integration.md)

This is the single source of truth for options, events, errors, and exports.
The typed contract lives in [`src/types.js`](../src/types.js) (JSDoc
`@typedef`s, resolved by editors with TS language support — no TS compile).

## 5.1 `createSpeakOrNoSpeak(options?)`

```js
const sons = await createSpeakOrNoSpeak(options);
```

Async factory returning `Promise<SpeakOrNoSpeak>`. It merges options over the
defaults (`mergeOptions`, [§14.1](14-configuration-tuning.md#141-options-and-how-merging-works)),
constructs the engine and the `TurnDetector`, and wires the frame stream. It
does **not** touch the microphone — that happens in `start()`. All options are
optional; fatal misconfiguration rejects with a `SpeakError` carrying a stable
`code` ([§5.6](#56-error-codes--humanmessage)).

## 5.2 Options

| Option | Type / default | Meaning |
|---|---|---|
| `mic` | `MediaTrackConstraints`, default widest AEC scope | Merged **per key** over the defaults `{ channelCount: 1, echoCancellation: { ideal: "all" }, noiseSuppression: true, autoGainControl: true }` (WP-E1 D1 — requests system-wide AEC as an *ideal*; never fails the request). E.g. `mic: { echoCancellation: false }` disables only AEC (activates stricter barge-in gating, [Chapter 6](06-agent-integration.md)) |
| `strictGating` | `"auto" \| "on" \| "off"`, default `"auto"` | Stricter barge-in gating override (WP-E1 D5): `"auto"` = stricter when `degraded.aecScope` is `"none"`, or `"unknown"`/`"remote-only"` without an active agent-audio route; `"on"`/`"off"` force it |
| `halfDuplex` | `boolean`, default `false` | WP-E5 (M6 escape hatch): while the agent flag is armed, speech detection is suspended entirely — no barge-in, no interrupts. For IVR-style flows where barge-in is unwanted. Costs barge-in (∞ while armed — by design); not the same as engine `pause()` |
| `thresholds` | `Partial<Thresholds>`, merged over defaults | Detection thresholds — table in [§5.3](#53-thresholds) |
| `engine` | `VadEngine` | Advanced: inject a custom engine (tests, experiments). Injecting one disables the automatic energy fallback unless you also pass `energyEngine` |
| `energyEngine` | `VadEngine` | Advanced: replaces the default `EnergyVad` as the fallback target |
| `turnModel` | `TurnModel` | Optional semantic end-of-turn model — [Chapter 12](12-smart-turn.md) |
| `debug` | `boolean`, default `false` | Records state-transition traces on the detector (read via `sons._detector.traces`, [§14.6](14-configuration-tuning.md#146-debug-traces)) |
| `onSpeechStart` | `() => void` | **S1** — user started speaking |
| `onTurnEnd` | `(e: TurnEndEvent) => void` | **S2** — utterance complete (carries the turn audio) |
| `onInterrupt` | `(info: InterruptInfo) => void` | **S3** — user barged in while the agent speaks |
| `onLevel` | `(rms: number) => void` | Per-frame loudness 0..1 (~31 events/s at Silero v5's 32 ms frames) |
| `onError` | `(e: EngineError) => void` | Engine problems — codes in [§5.6](#56-error-codes--humanmessage) |

## 5.3 Thresholds

Defaults ([`src/config.js`](../src/config.js#L16-L57)); frame counts are
calibrated for Silero v5's **32 ms** frames:

| Key | Default | Meaning |
|---|---|---|
| `onsetSpeechThreshold` | `0.6` | frame "is speech" level |
| `negativeSpeechThreshold` | `0.35` | hysteresis floor |
| `onsetConfirmFrames` | `9` | × 32 ms = **288 ms** onset confirm window |
| `minSpeechMs` | `250` | discard coughs/clicks shorter than this |
| `redemptionMs` | `650` | BASE silence that ends a turn — adapted per turn by the redemption policy, clamped 350–1200 ms ([§7.7](07-detection-methods.md#77-adaptive-redemption-redemptionfor)) |
| `shortPauseMs` | `250` | interior silence that opens the PAUSE sub-state (never ends the turn) |
| `preSpeechPadMs` | `200` | audio before onset kept in the turn audio |
| `bargeInConfirmFrames` | `6` | × 32 ms ≈ **192 ms** barge-in confirm (echo protection) |
| `maxTurnMs` | `30000` | force-end long turns (`truncated: true`) |
| `graceAfterInterruptMs` | `500` | post-interrupt silence ignored (keeps one utterance whole) |
| `noAecBargeInConfirmMs` | `300` | stricter barge-in window without AEC |
| `noAecRmsFactor` | `2` | without AEC: frame rms must exceed 2× the rolling agent-playback rms |
| `modelTimeoutMs` | `300` | max wait for the semantic turn model before failing open |

Rationale and tuning recipes: [Chapter 14](14-configuration-tuning.md).

## 5.4 The facade members

| Member | Meaning |
|---|---|
| `start()` → `Promise<void>` | Opens the mic and starts detection. Resolves when the first frame arrives; rejects on fatal errors ([§5.6](#56-error-codes--humanmessage)). May transparently degrade to the energy engine ([Chapter 15](15-troubleshooting.md)) |
| `stop()` | Stops the engine, releases the mic, resets state. Idempotent |
| `setAgentSpeaking(active)` | Arm/disarm barge-in mode while your app plays audio — [Chapter 6](06-agent-integration.md). **Always disarm** when your output stops |
| `setAgentAudioRouted(active)` | Declare your agent audio plays through a cancelable route ([`createAgentAudioRoute`](#54a-createagentaudiorouteoptions) — WP-E2). While a route is active, an `"unknown"`/`"remote-only"` AEC scope no longer forces the stricter barge-in gating. Reset by `stop()` |
| `state` → `"idle" \| "ready" \| "listening"` | `"idle"` = not started, `"ready"` = listening for onset, `"listening"` = speech detected (interior pauses stay listening — the turn is still open) |
| `degraded` → `{ aec: boolean, engine: "silero" \| "energy", aecScope: "all" \| "remote-only" \| "unknown" \| "none" }` | Degradation flags — surface all in your UI. `aec` stays `true`-means-no-usable-cancellation (scope `"none"`); `aecScope` is the honest scope label ([Chapter 6 §6.6](06-agent-integration.md)) |
| `_detector`, `_engine` | Advanced/testing only — **not a stable API** (detector traces, engine internals such as `processorTypeUsed`) |

## 5.4a `createAgentAudioRoute(options?)` — cancelable agent audio (WP-E2)

Makes **page-played agent audio cancelable** on browsers whose AEC scope is
too narrow: the agent voice is played through a local WebRTC loopback, so the
browser classifies it as "remote participant" audio — the one source its AEC
always references. WebKit runs **direct** (no loopback — its system AEC
already references everything).

```js
const route = await createAgentAudioRoute();   // inside the same click that starts the mic
instance.setAgentAudioRouted(true);            // feed the stricter-gating rule
// … wire your TTS source:
mySourceNode.connect(route.input);             // the ONLY wiring — never also to ctx.destination
route.gain.gain.value = 0.8;                   // volume lives HERE (route.gain is the GainNode;
                                               // its .gain AudioParam holds the value; D8)
// … later:
await route.stop();
instance.setAgentAudioRouted(false);
```

| Member | Meaning |
|---|---|
| `input` → `GainNode` | connect your TTS source here — the only contract |
| `gain` → `GainNode` | volume control (pre-loopback, inside the AEC reference — [D8]): set `route.gain.gain.value` (the AudioParam) |
| `element` / `outputElement` | the audible `<audio autoplay playsinline>` (loopback only); do not re-route or re-volume it |
| `mode` → `"loopback" \| "direct"` | resolved mode: `"auto"` = WebKit→direct, else loopback; explicit `"loopback"`/`"direct"` wins (`?routemode=` in the demo) |
| `ready` | resolves when the route carries audio |
| `getReferenceNode()` | the node whose output is the audible (AEC-referenced) signal — hook for reference-correlation gating (WP-E3) |
| `stop()` | idempotent teardown (peer connections, element, owned context) |

Options: `{ audioContext?, gain? = 1, mode? = "auto" }`. Create it inside a
user-gesture call chain (same click as the mic start) — `element.play()`
needs it. Failures throw `audio-pipeline` — keep your plain playback path and
let the stricter gating stay armed. See [Chapter 6](06-agent-integration.md)
for when to use the route vs. `echoCancellation: "all"`.

## 5.5 Events & payloads

### `onSpeechStart` (S1)

No arguments. Fired when the onset-confirm window fills
([§7.4](07-detection-methods.md#74-onset-confirmation)). **Never fires for a
barge-in** — an interrupt *is* the onset ([§7.10](07-detection-methods.md#710-barge-in-confirmation-and-grace)).

### `onTurnEnd` — `TurnEndEvent` (S2, the main event)

| Field | Type | Meaning |
|---|---|---|
| `audio` | `Float32Array` | 16 kHz mono, includes the 200 ms pre-speech pad — feed to STT, save as WAV, replay |
| `durationMs` | `number` | speech + pad duration (audio length) |
| `truncated` | `boolean` | force-ended at `maxTurnMs` |
| `afterInterrupt` | `boolean` | this turn started with a barge-in |
| `stats` | `{ speechMs, interiorPauses, longestPauseMs, turnMs }` | turn rhythm (tuning/telemetry input, [§7.7](07-detection-methods.md#77-adaptive-redemption-redemptionfor)) |

### `onInterrupt` — `InterruptInfo` (S3)

| Field | Meaning |
|---|---|
| `atMs` | ms since the agent-speaking flag was armed |
| `latencyMs` | voice-onset → event latency (≈ the confirm window actually waited; larger in no-AEC mode) |

### `onLevel`

`(rms: number)` per frame, 0..1 — a cheap UI meter (~31 events/s).

### `onError` — `EngineError`

`{ code: string, message: string }` — codes in [§5.6](#56-error-codes--humanmessage).
Errors are delivered **both ways**: thrown from `start()` (as `SpeakError`)
and emitted via `onError`.

## 5.6 Error codes & `humanMessage`

Stable string codes app code branches on ([`src/errors.js`](../src/errors.js));
messages are prose, the codes are the contract.

| Code | Class | Meaning |
|---|---|---|
| `mic-denied` | fatal | permission rejected by user/OS |
| `mic-not-found` | fatal | no microphone device |
| `insecure-context` | fatal | not served over https/localhost — mic API unavailable |
| `cdn-unavailable` | fatal* | neither the CDN scripts (`window.vad`) nor the npm package could be loaded → *the facade falls back to the energy engine* |
| `engine-load-failed` | fatal* | ORT/model/MicVAD load or start threw → *energy fallback* |
| `no-aec` | warning | echo cancellation not active on the mic track — stricter barge-in gating active, headphones recommended |
| `aec-scope-limited` | warning | AEC scope unverifiable (browser-decided `true`) — the state where same-page audio leaks on Chromium; route agent audio ([§5.4a](#54a-createagentaudiorouteoptions)) or enable system-wide cancellation |
| `aec-scope-fallback` | warning | system-wide AEC unavailable (missing OS permission) — fell back to the browser default (one re-request) |
| `engine-fallback` | warning | running on the energy engine (`degraded.engine === "energy"`) |
| `audio-pipeline` | runtime | AudioContext/capture failure at runtime |
| `vad-no-frames` | runtime | engine started but produced no frames within 5 s — try reloading |

\* fatal for the Silero engine, but the facade degrades to the energy engine
instead of failing the page. `humanMessage(code)` returns a ready-made UI
sentence for every code — the demo maps all errors through it.

## 5.6b `AgentVoiceGate` — the agent-voice-profile gate (WP-E4, stretch)

Optional voice-identity suppression (D9, default **off**): completed turns are
embedded through a speaker-verification model and compared against a profile
built offline from the agent's own voice; agent-similar turns are dropped
(suppression, never a hard gate — worst case: user speech briefly discounted,
R7). Fail-open on any model error: the turn is emitted ungated.

```js
// one-time offline: build the profile from your agent voice sample
//   node scripts/build-agent-voice-profile.mjs   → src/gate/agent-voice-profile.json
// (model: vendor/wespeaker_en_voxceleb_resnet34.onnx — manual download, gitignored)
const sons = await createSpeakOrNoSpeak({
  voiceGate: { enabled: true },   // threshold 0.8 default; profileUrl/modelUrl overridable
});
```

- Scoring runs at TURN END only (~33 ms native / ~100–300 ms wasm per turn —
  never in the frame path); the first scored turn pays the model load.
- Measured separation (reference machine): same-voice **0.945** ·
  different-voice **0.393** → default threshold **0.8** (conservative —
  higher drops fewer turns, i.e. safer for user speech).
- `sons._voiceGate` exposes `{ scored, dropped }` for telemetry.
- Knobs: [§14.2](14-configuration-tuning.md#142-every-threshold-explained)
  (`voiceGate.*`).

## 5.7 All 20 exports

`import { … } from "speak-or-no-speak"` (npm) / `./src/index.js`
([`src/index.js`](../src/index.js)) / `./speak-or-no-speak.esm.js` (bundle) /
`window.SpeakOrNoSpeak.…` (IIFE):

| Export | One-liner |
|---|---|
| `createSpeakOrNoSpeak` | the facade factory ([§5.1](#51-createspeakornospeakoptions)) — all you need for standard use |
| `createAgentAudioRoute` | cancelable agent-audio route ([§5.4a](#54a-createagentaudiorouteoptions) — WP-E2) |
| `AgentVoiceGate` | agent-voice-profile gate ([§5.6b](#56b-agentvoicegate--the-agent-voice-profile-gate-wp-e4-stretch) — WP-E4) |
| `isAgentVoice` / `cosineSimilarity` | the gate's pure decision helpers (unit-testable) |
| `SileroVadAdapter` | default Silero v5 engine adapter (advanced: construct + pass as `engine`) |
| `EnergyVad` | energy-based fallback engine (degraded, noise-blind) |
| `energyProbability` | pure RMS-vs-noise-floor probability helper (unit-testable) |
| `SpeakError` | `Error` subclass carrying the stable `code` |
| `ERROR_CODES` | the 9 stable codes ([§5.6](#56-error-codes--humanmessage)) |
| `humanMessage` | human-readable sentence per code for UI surfaces |
| `SmartTurnModel` | optional semantic end-of-turn model ([Chapter 12](12-smart-turn.md)) |
| `SttAdapter` | transcription plug-point interface ([Chapter 13](13-transcription.md)) |
| `CloudStubAdapter` | shipped STT example: WAV POST → `{text, confidence}` |
| `TurnDetector` | the pure turn state machine (advanced/unit testing) |
| `redemptionFor` | adaptive redemption-window policy (advanced) |
| `encodeWav` | Float32 → WAV `Blob` (browser) / `Buffer` (Node) |
| `encodeWavBytes` | Float32 → WAV `ArrayBuffer` (pure bytes) |
| `DEFAULTS` | the full default options object ([`src/config.js`](../src/config.js)) |
| `mergeOptions` | the recursive merge helper used for options |

## 5.8 Debug & advanced handles

- `sons._detector` — the `TurnDetector`: with `debug: true`, `traces` holds the
  last 100 state transitions (`{ audioMs, event, detail }`) — see
  [§14.6](14-configuration-tuning.md#146-debug-traces).
- `sons._engine` — the running engine; e.g. `processorTypeUsed`
  (`"audio-worklet" | "script-processor"`) explains which capture path the
  browser took ([§10.4](10-vad-engines.md#104-the-audioworklet-hang-and-the-scriptprocessor-fallback)).
- `window.__sons` — set by the demo while the mic runs (tooling convenience).

These are explicitly **not** a stable API; they exist for tests and debugging.

---

*Prev: [Chapter 4 — Embedding](04-embedding.md) · Next: [Chapter 6 — Agent integration](06-agent-integration.md)*
