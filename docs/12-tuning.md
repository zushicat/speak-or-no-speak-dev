# Configuration & tuning

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Transcription](11-transcription.md) · next: [Troubleshooting](13-troubleshooting.md)

The reference tables are in [API reference](05-api-reference.md); this chapter
is the **why** and the **how to tune**.

## Options and how merging works

`mergeOptions(user, DEFAULTS)` ([`src/config.js`](../src/config.js)):

- **Plain objects merge recursively, per key.** So `mic: { echoCancellation:
  false }` disables *only* AEC and keeps `noiseSuppression` /
  `autoGainControl` / `channelCount` defaults.
- **Everything else replaces**: numbers, arrays, functions, `null`. Passing
  `thresholds: { redemptionMs: 400 }` merges into the other 12 threshold
  defaults.
- **`undefined` means "not provided"** and keeps the default.
- Inputs are never mutated; a new object is returned. No `window` access —
  the same code runs in Node tests.

## Every threshold explained

| Threshold (default) | Why this value |
|---|---|
| `onsetSpeechThreshold` (0.6) | The "is speech" bar for a frame. High enough that Silero's noise/music probabilities stay below it; the *upper* half of the hysteresis pair. |
| `negativeSpeechThreshold` (0.35) | The silence bar. The band between 0.35 and 0.6 is hysteresis — mid frames neither start nor end anything, which stops flicker at the boundary. |
| `onsetConfirmFrames` (9 ≈ 288 ms) | How long speech must persist before `onSpeechStart`. This single window filters coughs, clicks, and keyboard clatter — and defines your speech-onset latency. |
| `minSpeechMs` (250) | Second guard against short bursts: a turn with less speech is discarded silently. With defaults it rarely fires (a confirmed onset already carries ≥ 288 ms of counted speech — see [How detection works](07-how-detection-works.md#turn-boundaries-and-guards)); it matters when you *shrink* the confirm window. |
| `redemptionMs` (650) | The BASE silence that ends a turn. 650 ms is the middle of the classic 500–900 ms endpointing range; it is the *base*, adapted per turn ([tuning recipes](#tuning-recipes) / [How detection works](07-how-detection-works.md#adaptive-redemption-redemptionfor)). |
| `shortPauseMs` (250) | When interior silence opens the PAUSE sub-state. Below it, pauses are just silence inside listening. Interior pauses shorter than redemption never end the turn. |
| `preSpeechPadMs` (200) | Audio kept *before* the first confirmed-speech sample so word onsets are not clipped by the confirm window. |
| `bargeInConfirmFrames` (6 ≈ 192 ms) | How long speech must persist during agent speech before `onInterrupt`. Shorter than onset-confirm (barge-in is latency-critical) but long enough to reject echo tails; also the expected `latencyMs`. |
| `maxTurnMs` (30000) | Runaway guard: force-end absurdly long turns, deliver the audio with `truncated: true`. |
| `graceAfterInterruptMs` (500) | Post-interrupt silence that does not count toward redemption — keeps "hey, sto—" from being sliced mid-word. |
| `noAecBargeInConfirmMs` (300) | The wider barge-in confirm used when AEC is inactive — the extra margin against the agent's own leaked voice. |
| `noAecRmsFactor` (2) | Without AEC, a speech frame must also be **louder than 2× the rolling mean rms of the last second of agent-only playback** — a TTS-leakage guard that statistical confirmation alone cannot provide. |
| `modelTimeoutMs` (300) | Max wait for the semantic turn model before failing open — bounds how long the model can *hold* a turn. |
| `echoGate.correlationThreshold` (0.75) | Correlation echo gate (default **off**, `echoGate.enabled`): a frame correlating ≥ this against the recent agent-reference audio is classified as echo *regardless of its rms* — the loud-TTS case the `noAecRmsFactor` gate misses. Measured on real Chrome (AGC + room): real echo hovers near the threshold → ~50 % catch rate at 0.75; real user speech stays below (barge-in intact). **Lower it only with calibration data** — the cost of a false positive is swallowed user speech. |
| `echoGate.probeEveryFrames` (4) | Correlation probes per frame cadence; un-probed frames inherit the last verdict (echo bursts are contiguous). Raise to 8 if the CPU budget suffers (measured cost at 4: p95 0.102 ms/frame, budget 8 ms). |
| `echoGate.maxDelayMs` (500) | The render→capture delay search range (loopback jitter + D/A–A/D + acoustic path). Widen only if your output chain is slower than ~500 ms. |
| `echoGate.lagStride` (16 ≈ 1 ms) | Budget knob for the delay-search resolution. |
| `echoGate.suppressOnset` (false) | Phase 2 (opt-in): also reject echo in the READY state. Default off — a correlation false positive must never swallow real user speech before the agent flag is armed. |
| `voiceGate.threshold` (0.8) | Agent-voice gate (default **off**, `voiceGate.enabled`): cosine similarity vs the agent voice profile above which a completed turn is dropped (suppression). Measured separation: same-voice 0.945 · different-voice 0.393. Raise it to drop fewer turns (safer for users who resemble the agent voice); lower only with calibration data. |
| `voiceGate.profileUrl` / `modelUrl` | The committed profile JSON (`src/gate/agent-voice-profile.json`, built offline via `scripts/build-agent-voice-profile.mjs`) and the speaker-embedding ONNX (gitignored `/vendor/`, Smart-Turn-style manual download). Bundle your own profile for your agent's voice. |

## The 32 ms recalibration story

An early plan assumed vad-web's frames were **1536 samples ≈ 96 ms** (the
legacy-model default). Runtime verification showed that for **Silero v5** the
frame size is **model-derived: 512 samples = 32 ms**, and the `frameSamples`
option is ignored for MicVAD
([Engines and runtime libraries](09-engines-and-libraries.md#runtime-verified-vad-web-findings)).

Every frame-count threshold was therefore calibrated to preserve the intended
**wall-clock windows**: onset confirm ≡ 288 ms (9 × 32 ms); barge-in confirm ≡
192 ms (6 × 32 ms). If you change the frame-count thresholds yourself, think
in **milliseconds** (`frames × 32`), not in frame counts — and remember the
tests set explicit thresholds precisely so they document the machine, not the
defaults.

## Tuning recipes

Start from the defaults; change **one** thing at a time and replay the
calibration fixtures
([Development § replay](14-development.md#the-replay-harness-and-calibration-recordings)).

| Situation | First knob | Then | Watch out for |
|---|---|---|---|
| Noisy room / false onsets | `onsetConfirmFrames` ↑ (e.g. 12) | `onsetSpeechThreshold` ↑ slightly | Onset latency grows (confirm × 32 ms) |
| Feels laggy at turn end | `redemptionMs` ↓ (e.g. 500) | rely on the adaptive policy instead of forcing it low | hesitant speakers get cut off — check `stats.interiorPauses` |
| Speaker gets cut off mid-thought | `redemptionMs` ↑ (e.g. 800) or enable Smart Turn ([Smart Turn](10-smart-turn.md)) | `shortPauseMs` ↑ so hesitation opens PAUSE earlier | turn-end latency grows |
| Agent interrupt feels slow | `bargeInConfirmFrames` ↓ (e.g. 4–5) | only with AEC active | without AEC this invites echo false-positives |
| False interrupts from the agent's own voice (no AEC) | **route the agent audio** (`createAgentAudioRoute`, [API reference](05-api-reference.md#createagentaudiorouteoptions)) — measured 0 false starts/interrupts with the route or the `"all"` scope | keep `noAecBargeInConfirmMs` (300); the correlation echo gate (`echoGate: { enabled: true }`) halves the worst-case residual | very quiet users may not pass the rms gate; lowering `echoGate.correlationThreshold` without calibration risks swallowed speech |
| Kiosk / IVR (barge-in unwanted) | `halfDuplex: true` | headphones + OS AEC ([Agent integration](06-agent-integration.md#os-level-echo-cancellation)) | no barge-in while the agent talks — by design |
| Barge-in feels slow although AEC works | declare the route (`setAgentAudioRouted(true)`) or `strictGating: "off"` | check `degraded.aecScope` first — `"all"` already exempts | only safe when cancellation is actually working |
| Game avatar (fast commands) | `minSpeechMs` ↓ (e.g. 150) **and** `onsetConfirmFrames` ↓ (e.g. 6) | — | more cough/click sensitivity — that is the trade |
| Long dictation sessions | `maxTurnMs` ↑ (e.g. 60000) | — | memory: turn audio accumulates in RAM |

The `stats` on every `TurnEndEvent` (`speechMs`, `interiorPauses`,
`longestPauseMs`, `turnMs`) exists exactly for this: log it, look at the
rhythm of your real users, then tune.

## Surfacing degraded flags in your UI

`listener.degraded` has three fields, all meaningful:

- **`engine: "energy"`** — the neural engine could not load; detection is
  noise-blind. Tell the user ("running in reduced-accuracy mode") — quiet
  rooms work, noisy ones will not.
- **`aec: true`** — no echo cancellation on the mic track; barge-in gating is
  stricter, and loud speakers may still cause false interrupts. Recommend
  headphones.
- **`aecScope`** — the honest scope label (`"all" | "remote-only" | "unknown" |
  "none"`); `"unknown"` on Chromium is exactly the state where same-page audio
  leaks — route your agent audio ([Agent integration](06-agent-integration.md#echo-cancellation-scope--the-reference-signal-rule)).

All degradations also emit one-time warnings via `onError`
(`engine-fallback`, `no-aec`, `aec-scope-limited`, `aec-scope-fallback`) —
**the module never degrades silently**, and your UI shouldn't either. The demo
maps every code through `humanMessage` ([`demos/main.js`](../demos/main.js)).

## Debug traces

With `debug: true`, the detector records the last 100 state transitions:

```js
const listener = await createSpeakOrNoSpeak({ debug: true, /* … */ });
// after some interaction:
console.table(listener._detector.traces);
// [{ audioMs: 512,  event: "onSpeechStart" },
//  { audioMs: 2208, event: "enterPause", detail: 264 },
//  { audioMs: 2816, event: "onTurnEnd",  detail: 718.75 }, …]
```

Events you will see: `onSpeechStart`, `enterPause` (detail: silence ms),
`onInterrupt` (detail: latencyMs), `onTurnEnd` (detail: durationMs),
`turn-discarded`, `model-eval-start` / `model-incomplete` /
`model-eval-cancelled` / `model-eval-error`, all timestamped on the `audioMs`
timeline (ms of audio consumed). This is the fastest way to answer "why did it
end the turn there?" — pair it with the harness replay for determinism
([Development § replay](14-development.md#the-replay-harness-and-calibration-recordings)).

---

*Prev: [Transcription](11-transcription.md) · Next: [Troubleshooting](13-troubleshooting.md)*
