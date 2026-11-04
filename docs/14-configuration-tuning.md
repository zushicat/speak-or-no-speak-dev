# Chapter 14 — Configuration & tuning

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 13](13-transcription.md) · next: [Chapter 15 — Troubleshooting](15-troubleshooting.md)

The reference tables are in [Chapter 5](05-api-reference.md); this chapter is
the **why** and the **how to tune**.

## 14.1 Options and how merging works

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

## 14.2 Every threshold explained

| Threshold (default) | Why this value |
|---|---|
| `onsetSpeechThreshold` (0.6) | The "is speech" bar for a frame. High enough that Silero's noise/music probabilities stay below it; the *upper* half of the hysteresis pair. |
| `negativeSpeechThreshold` (0.35) | The silence bar. The band between 0.35 and 0.6 is hysteresis — mid frames neither start nor end anything, which stops flicker at the boundary. |
| `onsetConfirmFrames` (9 ≈ 288 ms) | How long speech must persist before `onSpeechStart`. This single window filters coughs, clicks, and keyboard clatter — and defines your S1 latency. |
| `minSpeechMs` (250) | Second guard against short bursts: a turn with less speech is discarded silently. With defaults it rarely fires (a confirmed onset already carries ≥ 288 ms of counted speech — D-WP3-1, [§7.9](07-detection-methods.md#79-turn-boundaries-and-guards)); it matters when you *shrink* the confirm window. |
| `redemptionMs` (650) | The BASE silence that ends a turn. 650 ms is the middle of the classic 500–900 ms endpointing range; it is the *base*, adapted per turn ([§14.4](#144-tuning-recipes) / [§7.7](07-detection-methods.md#77-adaptive-redemption-redemptionfor)). |
| `shortPauseMs` (250) | When interior silence opens the PAUSE sub-state. Below it, pauses are just silence inside listening. Interior pauses shorter than redemption never end the turn. |
| `preSpeechPadMs` (200) | Audio kept *before* the first confirmed-speech sample so word onsets are not clipped by the confirm window. |
| `bargeInConfirmFrames` (6 ≈ 192 ms) | How long speech must persist during agent speech before `onInterrupt`. Shorter than onset-confirm (barge-in is latency-critical) but long enough to reject echo tails; also the expected `latencyMs`. |
| `maxTurnMs` (30000) | Runaway guard: force-end absurdly long turns, deliver the audio with `truncated: true`. |
| `graceAfterInterruptMs` (500) | Post-interrupt silence that does not count toward redemption — keeps "hey, sto—" from being sliced mid-word. |
| `noAecBargeInConfirmMs` (300) | The wider barge-in confirm used when AEC is inactive — the extra margin against the agent's own leaked voice. |
| `noAecRmsFactor` (2) | Without AEC, a speech frame must also be **louder than 2× the rolling mean rms of the last second of agent-only playback** — a TTS-leakage guard that statistical confirmation alone cannot provide. |
| `modelTimeoutMs` (300) | Max wait for the semantic turn model before failing open — bounds how long the model can *hold* a turn. |
| `echoGate.correlationThreshold` (0.75) | WP-E3 (default **off**, `echoGate.enabled`): a frame correlating ≥ this against the recent agent-reference audio is classified as echo *regardless of its rms* — the loud-TTS case the `noAecRmsFactor` gate misses. Measured on real Chrome (AGC + room): real echo hovers near the threshold → ~50 % catch rate at 0.75; real user speech stays below (barge-in intact, 30/30 interrupts in the WP-E3 control). **Lower it only with calibration data** — the cost of a false positive is swallowed user speech. |
| `echoGate.probeEveryFrames` (4) | Correlation probes per frame cadence; un-probed frames inherit the last verdict (echo bursts are contiguous). Raise to 8 if the CPU budget suffers (measured cost at 4: p95 0.102 ms/frame, budget 8 ms). |
| `echoGate.maxDelayMs` (500) | The render→capture delay search range (loopback jitter + D/A–A/D + acoustic path). Widen only if your output chain is slower than ~500 ms. |
| `echoGate.lagStride` (16 ≈ 1 ms) | Budget knob for the delay-search resolution. |
| `echoGate.suppressOnset` (false) | Phase 2 (opt-in): also reject echo in the READY state. Default off — a correlation false positive must never swallow real user speech un-armed. |
| `voiceGate.threshold` (0.8) | WP-E4 (default **off**, `voiceGate.enabled`): cosine similarity vs the agent voice profile above which a completed turn is dropped (suppression, R7). Measured separation: same-voice 0.945 · different-voice 0.393. Raise it to drop fewer turns (safer for users who resemble the agent voice); lower only with calibration data. |
| `voiceGate.profileUrl` / `modelUrl` | The committed profile JSON (`src/gate/agent-voice-profile.json`, built offline via `scripts/build-agent-voice-profile.mjs`) and the speaker-embedding ONNX (gitignored `/vendor/`, SmartTurnModel-style manual download). Bundle your own profile for your agent's voice. |

## 14.3 The 32 ms recalibration story

The original plan assumed vad-web's frames were **1536 samples ≈ 96 ms**
(the legacy-model default). WP1 verified at runtime that for **Silero v5** the
frame size is **model-derived: 512 samples = 32 ms**, and the `frameSamples`
option is ignored for MicVAD (deviation **D-WP1-1**,
[§10.3](10-vad-engines.md#103-runtime-verified-vad-web-findings)).

Every frame-count threshold was therefore recalibrated to preserve the same
**wall-clock windows**: onset confirm 3 × 96 ms ≡ 9 × 32 ms = 288 ms; barge-in
confirm 2 × 96 ms ≡ 6 × 32 ms ≈ 192 ms. If you change the frame-count
thresholds yourself, think in **milliseconds** (`frames × 32`), not in frame
counts — and remember the tests set explicit thresholds precisely so they
document the machine, not the defaults.

## 14.4 Tuning recipes

Start from the defaults; change **one** thing at a time and replay the
calibration fixtures ([§16.5](16-build-test-publish.md#165-the-replay-harness-and-calibration-recordings)).

| Situation | First knob | Then | Watch out for |
|---|---|---|---|
| Noisy room / false onsets | `onsetConfirmFrames` ↑ (e.g. 12) | `onsetSpeechThreshold` ↑ slightly | S1 latency grows (confirm × 32 ms) |
| Feels laggy at turn end | `redemptionMs` ↓ (e.g. 500) | rely on the adaptive policy instead of forcing it low | hesitant speakers get cut off — check `stats.interiorPauses` |
| Speaker gets cut off mid-thought | `redemptionMs` ↑ (e.g. 800) or enable Smart Turn ([Chapter 12](12-smart-turn.md)) | `shortPauseMs` ↑ so hesitation opens PAUSE earlier | turn-end latency grows |
| Agent interrupt feels slow | `bargeInConfirmFrames` ↓ (e.g. 4–5) | only with AEC active | without AEC this invites echo false-positives |
| False interrupts from the agent's own voice (no AEC) | **route the agent audio** (`createAgentAudioRoute`, [§5.4a](05-api-reference.md#54a-createagentaudiorouteoptions)) — measured 0 false starts/interrupts with the route or the `"all"` scope | keep `noAecBargeInConfirmMs` (300); the coherence echo gate (`echoGate: { enabled: true }`) halves the worst-case residual | very quiet users may not pass the rms gate; lowering `echoGate.correlationThreshold` without calibration risks swallowed speech |
| Kiosk / IVR (barge-in unwanted) | `halfDuplex: true` | headphones + OS AEC ([§6.10](06-agent-integration.md#610-os-level-echo-cancellation)) | no barge-in while the agent talks — by design |
| Barge-in feels slow although AEC works | declare the route (`setAgentAudioRouted(true)`) or `strictGating: "off"` | check `degraded.aecScope` first — `"all"` already exempts | only safe when cancellation is actually working |
| Game avatar (fast commands) | `minSpeechMs` ↓ (e.g. 150) **and** `onsetConfirmFrames` ↓ (e.g. 6) | — | more cough/click sensitivity — that is the trade |
| Long dictation sessions | `maxTurnMs` ↑ (e.g. 60000) | — | memory: turn audio accumulates in RAM |

The `stats` on every `TurnEndEvent` (`speechMs`, `interiorPauses`,
`longestPauseMs`, `turnMs`) exists exactly for this: log it, look at the
rhythm of your real users, then tune.

## 14.5 Surfacing degraded flags in your UI

`sons.degraded` has two flags, both meaningful:

- **`engine: "energy"`** — the neural engine could not load; detection is
  noise-blind. Tell the user ("running in reduced-accuracy mode") —
  quiet rooms work, noisy ones will not.
- **`aec: true`** — no echo cancellation on the mic track; barge-in gating is
  stricter, and loud speakers may still cause false interrupts. Recommend
  headphones.

Both degradations also emit one-time warnings via `onError`
(`engine-fallback`, `no-aec`) — **the module never degrades silently**, and
your UI shouldn't either. The demo maps both to `humanMessage` text
([`demo/main.js`](../demo/main.js)).

## 14.6 Debug traces

With `debug: true`, the detector records the last 100 state transitions:

```js
const sons = await createSpeakOrNoSpeak({ debug: true, /* … */ });
// after some interaction:
console.table(sons._detector.traces);
// [{ audioMs: 512,  event: "onSpeechStart" },
//  { audioMs: 2208, event: "enterPause", detail: 264 },
//  { audioMs: 2816, event: "onTurnEnd",  detail: 718.75 }, …]
```

Events you will see: `onSpeechStart`, `enterPause` (detail: silence ms),
`onInterrupt` (detail: latencyMs), `onTurnEnd` (detail: durationMs),
`turn-discarded`, `model-eval-start` / `model-incomplete` /
`model-eval-cancelled` / `model-eval-error`, all timestamped on the `audioMs`
timeline (ms of audio consumed). This is the fastest way to answer "why did
it end the turn there?" — pair it with the harness replay for determinism
([§16.5](16-build-test-publish.md#165-the-replay-harness-and-calibration-recordings)).

---

*Prev: [Chapter 13 — Transcription](13-transcription.md) · Next: [Chapter 15 — Troubleshooting](15-troubleshooting.md)*
