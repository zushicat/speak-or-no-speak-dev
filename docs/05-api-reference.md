# API reference

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Use it in your own app](04-use-in-your-app.md) · next: [Agent integration](06-agent-integration.md)

This chapter is the single source of truth for options, events, errors, and
exports. The typed contract lives in [`src/types.js`](../src/types.js) as
JSDoc `@typedef`s — editors with TypeScript language support resolve them in
plain JS, no compile step involved.

## `createSpeakOrNoSpeak(options?)`

```js
const listener = await createSpeakOrNoSpeak(options);
```

Async factory returning `Promise<SpeakOrNoSpeak>`. It merges the options over
the defaults (`mergeOptions` — see [Tuning](12-tuning.md)), constructs the
engine and the turn detector, and wires the frame stream. It does **not** touch
the microphone — that happens in `start()`. All options are optional; fatal
misconfiguration rejects with a `SpeakError` carrying a stable `code`
([error codes](#error-codes--humanmessage)).

## Options

| Option | Type / default | Meaning |
|---|---|---|
| `mic` | `MediaTrackConstraints`, default widest AEC scope | Merged **per key** over the defaults `{ channelCount: 1, echoCancellation: { ideal: "all" }, noiseSuppression: true, autoGainControl: true }` — the widest browser echo-cancellation scope is requested as an *ideal*, so the request never fails. E.g. `mic: { echoCancellation: false }` disables only AEC and activates stricter barge-in gating ([Agent integration](06-agent-integration.md)) |
| `strictGating` | `"auto" \| "on" \| "off"`, default `"auto"` | Stricter barge-in gating override: `"auto"` = stricter when the AEC scope is `"none"`, or `"unknown"`/`"remote-only"` without an active agent-audio route; `"on"`/`"off"` force it either way |
| `halfDuplex` | `boolean`, default `false` | Escape hatch for walkie-talkie flows: while the agent flag is armed, speech detection is suspended entirely — no barge-in, no interrupts. Costs barge-in (infinite latency while armed — by design); not the same as engine `pause()` |
| `thresholds` | `Partial<Thresholds>`, merged over defaults | Detection thresholds — table below |
| `engine` | `VadEngine` | Advanced: inject a custom engine (tests, experiments). Injecting one disables the automatic energy fallback unless you also pass `energyEngine` |
| `energyEngine` | `VadEngine` | Advanced: replaces the default `EnergyVad` as the fallback target |
| `turnModel` | `TurnModel` | Optional semantic end-of-turn model — [Smart Turn](10-smart-turn.md) |
| `echoGate` | object, default **off** | Optional correlation-based echo gate (defense in depth on top of AEC): `enabled`, `correlationThreshold` (0.75), `maxDelayMs` (500), `windowMs` (250), `decimation` (2), `lagStride` (16), `probeEveryFrames` (4), `suppressOnset` (false). See [Tuning](12-tuning.md#every-threshold-explained) |
| `voiceGate` | object, default **off** | Optional agent-voice-profile gate: completed turns similar to the agent's own voice are dropped. `enabled`, `threshold` (0.8), `profileUrl`, `modelUrl`. See [below](#agentvoicegate--the-agent-voice-profile-gate) |
| `debug` | `boolean`, default `false` | Records state-transition traces on the detector (read via `listener._detector.traces`, [Tuning § debug traces](12-tuning.md#debug-traces)) |
| `onSpeechStart` | `() => void` | **Speech start** — the user began speaking |
| `onTurnEnd` | `(e: TurnEndEvent) => void` | **Turn end** — the utterance is complete (carries the turn audio) |
| `onInterrupt` | `(info: InterruptInfo) => void` | **Interrupt** — the user barged in while the agent speaks |
| `onLevel` | `(rms: number) => void` | Per-frame loudness 0..1 (~31 events/s at Silero v5's 32 ms frames) |
| `onError` | `(e: EngineError) => void` | Engine problems — codes in [error codes](#error-codes--humanmessage) |

## Thresholds

Defaults ([`src/config.js`](../src/config.js)); frame counts are calibrated for
Silero v5's **32 ms** frames:

| Key | Default | Meaning |
|---|---|---|
| `onsetSpeechThreshold` | `0.6` | frame "is speech" level |
| `negativeSpeechThreshold` | `0.35` | hysteresis floor |
| `onsetConfirmFrames` | `9` | × 32 ms = **288 ms** onset confirm window |
| `minSpeechMs` | `250` | discard coughs/clicks shorter than this |
| `redemptionMs` | `650` | BASE silence that ends a turn — adapted per turn by the redemption policy, clamped 350–1200 ms ([How detection works](07-how-detection-works.md#adaptive-redemption-redemptionfor)) |
| `shortPauseMs` | `250` | interior silence that opens the pause sub-state (never ends the turn) |
| `preSpeechPadMs` | `200` | audio before onset kept in the turn audio |
| `bargeInConfirmFrames` | `6` | × 32 ms ≈ **192 ms** barge-in confirm (echo protection) |
| `maxTurnMs` | `30000` | force-end long turns (`truncated: true`) |
| `graceAfterInterruptMs` | `500` | post-interrupt silence ignored (keeps one utterance whole) |
| `noAecBargeInConfirmMs` | `300` | stricter barge-in window without AEC |
| `noAecRmsFactor` | `2` | without AEC: frame rms must exceed 2× the rolling agent-playback rms |
| `modelTimeoutMs` | `300` | max wait for the semantic turn model before failing open |

Rationale and tuning recipes: [Tuning](12-tuning.md).

## The facade members

| Member | Meaning |
|---|---|
| `start()` → `Promise<void>` | Opens the mic and starts detection. Resolves when the first frame arrives; rejects on fatal errors. May transparently degrade to the energy engine ([Troubleshooting](13-troubleshooting.md)) |
| `stop()` | Stops the engine, releases the mic, resets state. Idempotent |
| `setAgentSpeaking(active)` | Arm/disarm barge-in mode while your app plays audio — [Agent integration](06-agent-integration.md). **Always disarm** when your output stops |
| `setAgentAudioRouted(active)` | Declare that your agent audio plays through a cancelable route ([`createAgentAudioRoute`](#createagentaudiorouteoptions)). While a route is active, an `"unknown"`/`"remote-only"` AEC scope no longer forces the stricter barge-in gating. Reset by `stop()` |
| `setAgentAudioReference(reference)` | Register the route as the **echo reference** data source for the optional correlation echo gate (`echoGate`). Accepts the route object returned by `createAgentAudioRoute()`. Unsubscribed by `stop()` |
| `state` → `"idle" \| "ready" \| "listening"` | `"idle"` = not started, `"ready"` = listening for onset, `"listening"` = speech detected (interior pauses stay listening — the turn is still open) |
| `degraded` → `{ aec, engine, aecScope }` | Degradation flags — surface them in your UI. `aec` is `true` when there is no usable cancellation (scope `"none"`); `engine` is `"silero"` or `"energy"`; `aecScope` is the honest scope label (`"all" \| "remote-only" \| "unknown" \| "none"`) — [Agent integration § AEC scope](06-agent-integration.md#echo-cancellation-scope--the-reference-signal-rule) |
| `_detector`, `_engine`, `_voiceGate` | Advanced/testing only — **not a stable API** (detector traces, engine internals such as `processorTypeUsed`, voice-gate stats) |

## `createAgentAudioRoute(options?)`

Makes **page-played agent audio cancelable** on browsers whose AEC scope is too
narrow: the agent voice is played through a local WebRTC loopback, so the
browser classifies it as "remote participant" audio — the one source its AEC
always references. Safari runs **direct** (no loopback — its system AEC
already references everything).

```js
const route = await createAgentAudioRoute();   // inside the same click that starts the mic
listener.setAgentAudioRouted(true);            // feed the stricter-gating rule
listener.setAgentAudioReference(route);        // data feed for the optional echo gate
// … wire your TTS source:
mySourceNode.connect(route.input);             // the ONLY wiring — never also to ctx.destination
route.gain.gain.value = 0.8;                   // volume lives HERE
// … later:
await route.stop();
listener.setAgentAudioRouted(false);
```

| Member | Meaning |
|---|---|
| `input` → `GainNode` | connect your TTS source here — the only contract |
| `gain` → `GainNode` | volume control (pre-loopback, inside the AEC reference): set `route.gain.gain.value` |
| `element` / `outputElement` | the audible `<audio autoplay playsinline>` (loopback only); do not re-route or re-volume it |
| `mode` → `"loopback" \| "direct"` | resolved mode: `"auto"` = Safari → direct, else loopback; explicit `"loopback"`/`"direct"` wins (`?routemode=` in the demo) |
| `ready` | resolves when the route carries audio |
| `getReferenceNode()` | the node whose output is the audible (AEC-referenced) signal — hook for reference-correlation gating |
| `stop()` | idempotent teardown (peer connections, element, owned context) |

Options: `{ audioContext?, gain? = 1, mode? = "auto" }`. Create it inside a
user-gesture call chain (the same click as the mic start) — the route's audio
element needs it. Failures throw `audio-pipeline` — keep your plain playback
path and let the stricter gating stay armed. See
[Agent integration](06-agent-integration.md) for when to use the route vs.
`echoCancellation: "all"`.

## Events & payloads

### `onSpeechStart`

No arguments. Fired when the onset-confirm window fills
([How detection works](07-how-detection-works.md#onset-confirmation)). **Never
fires for a barge-in** — an interrupt *is* the onset.

### `onTurnEnd` — `TurnEndEvent` (the main event)

| Field | Type | Meaning |
|---|---|---|
| `audio` | `Float32Array` | 16 kHz mono, includes the 200 ms pre-speech pad — feed to STT, save as WAV, replay |
| `durationMs` | `number` | speech + pad duration (audio length) |
| `truncated` | `boolean` | force-ended at `maxTurnMs` |
| `afterInterrupt` | `boolean` | this turn started with a barge-in |
| `stats` | `{ speechMs, interiorPauses, longestPauseMs, turnMs }` | turn rhythm (tuning/telemetry input) |

### `onInterrupt` — `InterruptInfo`

| Field | Meaning |
|---|---|
| `atMs` | ms since the agent-speaking flag was armed |
| `latencyMs` | voice-onset → event latency (≈ the confirm window actually waited; larger in no-AEC mode) |

### `onLevel`

`(rms: number)` per frame, 0..1 — a cheap UI meter (~31 events/s).

### `onError` — `EngineError`

`{ code: string, message: string }` — codes below. Errors are delivered **both
ways**: thrown from `start()` (as `SpeakError`) and emitted via `onError`.

## Error codes & `humanMessage`

Stable string codes app code branches on ([`src/errors.js`](../src/errors.js));
messages are prose, the codes are the contract. `humanMessage(code)` returns a
ready-made UI sentence for every code — the demo maps all errors through it.

| Code | Class | Meaning |
|---|---|---|
| `mic-denied` | fatal | permission rejected by user/OS |
| `mic-not-found` | fatal | no microphone device |
| `insecure-context` | fatal | not served over https/localhost — mic API unavailable |
| `cdn-unavailable` | fatal* | neither the CDN scripts (`window.vad`) nor the npm package could be loaded → *the facade falls back to the energy engine* |
| `engine-load-failed` | fatal* | model/runtime load or start threw → *energy fallback* |
| `no-aec` | warning | echo cancellation not active on the mic track — stricter barge-in gating active, headphones recommended |
| `aec-scope-limited` | warning | AEC scope unverifiable (browser-decided `true`) — the state where same-page audio leaks on Chromium; route agent audio or enable system-wide cancellation |
| `aec-scope-fallback` | warning | system-wide AEC unavailable (missing OS permission) — fell back to the browser default (one re-request) |
| `engine-fallback` | warning | running on the energy engine (`degraded.engine === "energy"`) |
| `audio-pipeline` | runtime | AudioContext/capture failure at runtime |
| `vad-no-frames` | runtime | engine started but produced no frames within 5 s — try reloading |

\* fatal for the Silero engine, but the facade degrades to the energy engine
instead of failing the page.

## `AgentVoiceGate` — the agent-voice-profile gate

Optional voice-identity suppression (default **off**): completed turns are
embedded through a speaker-verification model and compared against a profile
built offline from the agent's own voice; agent-similar turns are dropped
(suppression, never a hard gate — worst case: user speech briefly
discounted). Fail-open on any model error: the turn is emitted ungated.

```js
// one-time offline: build the profile from your agent voice sample
//   node scripts/build-agent-voice-profile.mjs   → src/gate/agent-voice-profile.json
// (model: vendor/wespeaker_en_voxceleb_resnet34.onnx — manual download, gitignored)
const listener = await createSpeakOrNoSpeak({
  voiceGate: { enabled: true },   // threshold 0.8 default; profileUrl/modelUrl overridable
});
```

- Scoring runs at **turn end only** (~33 ms native / ~100–300 ms wasm per
  turn — never in the frame path); the first scored turn pays the model load.
- Measured separation (reference machine): same-voice **0.945** ·
  different-voice **0.393** → default threshold **0.8** (conservative — higher
  drops fewer turns, i.e. safer for user speech).
- `listener._voiceGate` exposes `{ scored, dropped }` for telemetry.
- Knobs: `voiceGate.*` in [Tuning](12-tuning.md#every-threshold-explained).

## All 20 exports

`import { … } from "speak-or-no-speak"` (npm) / `./src/index.js`
([`src/index.js`](../src/index.js)) / `./speak-or-no-speak.esm.js` (bundle) /
`window.SpeakOrNoSpeak.…` (IIFE):

| Export | One-liner |
|---|---|
| `createSpeakOrNoSpeak` | the facade factory — all you need for standard use |
| `createAgentAudioRoute` | cancelable agent-audio route |
| `AgentVoiceGate` | agent-voice-profile gate (optional, default off) |
| `isAgentVoice` / `cosineSimilarity` | the gate's pure decision helpers (unit-testable) |
| `SileroVadAdapter` | default Silero v5 engine adapter (advanced: construct + pass as `engine`) |
| `EnergyVad` | energy-based fallback engine (degraded, noise-blind) |
| `energyProbability` | pure RMS-vs-noise-floor probability helper (unit-testable) |
| `SpeakError` | `Error` subclass carrying the stable `code` |
| `ERROR_CODES` | the 11 stable codes |
| `humanMessage` | human-readable sentence per code for UI surfaces |
| `SmartTurnModel` | optional semantic end-of-turn model ([Smart Turn](10-smart-turn.md)) |
| `SttAdapter` | transcription plug-point interface ([Transcription](11-transcription.md)) |
| `CloudStubAdapter` | shipped STT example: WAV POST → `{text, confidence}` |
| `TurnDetector` | the pure turn state machine (advanced/unit testing) |
| `redemptionFor` | adaptive redemption-window policy (advanced) |
| `encodeWav` | Float32 → WAV `Blob` (browser) / `Buffer` (Node) |
| `encodeWavBytes` | Float32 → WAV `ArrayBuffer` (pure bytes) |
| `DEFAULTS` | the full default options object ([`src/config.js`](../src/config.js)) |
| `mergeOptions` | the recursive merge helper used for options |

## Debug & advanced handles

- `listener._detector` — the `TurnDetector`: with `debug: true`, `traces`
  holds the last 100 state transitions (`{ audioMs, event, detail }`) — see
  [Tuning § debug traces](12-tuning.md#debug-traces).
- `listener._engine` — the running engine; e.g. `processorTypeUsed`
  (`"audio-worklet" | "script-processor"`) explains which capture path the
  browser took ([Engines and runtime libraries](09-engines-and-libraries.md)).
- `listener._voiceGate` — the voice-gate instance or `null` (stats + tests).
- `window.__sons` — set by the demo while the mic runs (tooling convenience).

These are explicitly **not** a stable API; they exist for tests and debugging.

---

*Prev: [Use it in your own app](04-use-in-your-app.md) · Next: [Agent integration](06-agent-integration.md)*
