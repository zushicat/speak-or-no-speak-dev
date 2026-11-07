# Degradation & troubleshooting

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Configuration & tuning](12-tuning.md) · next: [Development](14-development.md)

## The degradation ladder

The design principle: **degrade, never die — and never silently.** Every
degradation is automatic, flagged via `onError`, and visible in
`listener.degraded`:

1. **Silero engine fails to load** (`cdn-unavailable`, `engine-load-failed`,
   or `audio-pipeline` at start) → one-time `engine-fallback` warning via
   `onError` + `degraded.engine = "energy"` — the energy engine takes over
   ([Engines and runtime libraries](09-engines-and-libraries.md#energyvad--the-degraded-fallback)).
2. **Mic track reports no usable echo cancellation** (unsupported platform,
   forced off, `?noaec=1`) → `no-aec` warning + `degraded.aec = true`: ~300 ms
   barge-in confirm **and** the frame rms must exceed 2× the rolling
   agent-playback rms (TTS-leakage guard,
   [Agent integration](06-agent-integration.md#without-aec--the-stricter-gating)).
   An unverifiable scope (`"unknown"`) additionally emits
   `aec-scope-limited`; a failed system-wide request emits
   `aec-scope-fallback`.
3. **Turn model fails** (load error, rejection, 300 ms timeout) → the turn end
   emits anyway — fail-open ([Smart Turn](10-smart-turn.md#when-it-runs-and-fail-open-semantics)).

What is *not* in the ladder because no fallback can help: `mic-denied`,
`mic-not-found`, `insecure-context` — these fail `start()` fatally.

The energy engine is **noise-blind by design** (RMS vs adaptive floor,
[Engines and runtime libraries](09-engines-and-libraries.md#the-energy-probability-model))
— a degraded mode: fine for quiet rooms, wrong for noisy ones.

## Error codes reference

Delivered **both ways**: thrown from `start()` (as `SpeakError` with `.code`)
and emitted via `onError` (plain `{ code, message }`). `humanMessage(code)`
returns a ready-made UI sentence for every code
([API reference](05-api-reference.md#error-codes--humanmessage)).

| Code | Class | Meaning / consequence |
|---|---|---|
| `mic-denied` | fatal | permission rejected by user/OS — `start()` rejects |
| `mic-not-found` | fatal | no microphone device — `start()` rejects |
| `insecure-context` | fatal | not served over https/localhost — mic API unavailable |
| `cdn-unavailable` | fatal* | neither CDN scripts (`window.vad`) nor npm import available → *energy fallback* |
| `engine-load-failed` | fatal* | model/runtime load or start threw → *energy fallback* |
| `no-aec` | warning | echo cancellation not active — stricter barge-in gating active |
| `aec-scope-limited` | warning | AEC scope could not be verified (browser-decided `true`) — route agent audio via `createAgentAudioRoute()` or enable system-wide cancellation ([Agent integration](06-agent-integration.md#echo-cancellation-scope--the-reference-signal-rule)) |
| `aec-scope-fallback` | warning | system-wide AEC unavailable (missing OS permission) — fell back to the browser default (one re-request; Chromium bug 479234114) |
| `engine-fallback` | warning | running on the energy engine |
| `audio-pipeline` | runtime | AudioContext/capture failure at runtime |
| `vad-no-frames` | runtime | engine started but produced no frames within 5 s |

\* fatal for the Silero engine, but the facade degrades to the energy engine
instead of failing the page.

## Symptom → fix table

| Symptom | Fix |
|---|---|
| `insecure-context` | serve via `http://localhost` or https — `file://` never works |
| `mic-denied` / `mic-not-found` | allow mic access for the site / check devices (browser and OS privacy settings) |
| `cdn-unavailable` | network/CDN blocked (VPN, offline, strict CSP) — allow `cdn.jsdelivr.net`, or serve a local `/vendor/` mirror ([Engines and runtime libraries](09-engines-and-libraries.md#offline-and-blocked-cdn-operation)) |
| `vad-no-frames` | engine started but no audio arrived — reload the page |
| `no-aec` warning | platform without AEC or forced off — expect stricter gating; headphones recommended |
| `aec-scope-limited` warning | `degraded.aecScope === "unknown"`: the browser reports `echoCancellation: true` but its scope is unverifiable — on Chromium this is exactly the state where `speechSynthesis`/same-page audio leaks into the mic; route agent audio via `createAgentAudioRoute()` or enable the OS permission + `"all"` scope. Safari users can ignore it (empirically system-wide) |
| `aec-scope-fallback` warning | the OS *Screen & System Audio Recording* permission is missing (macOS/Chromium) — grant it and reload; without it the module fell back to the browser default and reports `"unknown"` |
| the mic hears the agent's TTS | check `degraded.aecScope`: `"unknown"` on Chromium → route the agent audio (the demo's "audio buffer (routed)" source shows the fix); `"none"` → AEC is off (stricter gating active); `"all"` → should not happen (measured clean) — file a report |
| false interrupts from loud speakers | without AEC the browser can only gate barge-in statistically — route the agent audio, lower speaker volume, use headphones, or set `halfDuplex: true` when barge-in is unwanted |
| Safari hangs at start | the adapter auto-retries with the ScriptProcessor path (check `listener._engine.processorTypeUsed`); the mic needs a user gesture — call `start()` from a click |
| stale demo behavior after editing `demos/main.js` | bump the `?v=` cache-bust query in `demos/index.html` (the dev server sends no `Cache-Control` header) |
| turns split on hesitant speech | enable Smart Turn ([Smart Turn](10-smart-turn.md)) or widen `redemptionMs` ([Tuning](12-tuning.md#tuning-recipes)) |
| coughs/clicks trigger turns | raise `onsetConfirmFrames`; `minSpeechMs` is the second guard |

## Browser quirks and platform notes

- **AudioWorklet hang** (automation Chromium, old Safari, embedded webviews):
  `addModule` never resolves → the adapter's 8 s timeout guard retries with
  the documented `processorType: "ScriptProcessor"` path
  ([Engines and runtime libraries](09-engines-and-libraries.md#the-audioworklet-hang-and-the-scriptprocessor-fallback)).
  Prefer the ScriptProcessor path inside workers too.
- **Safari / iOS Safari**: the mic requires a **user gesture** — always call
  `start()` from a click handler. AEC quality on iOS is unverified; mobile
  support is out of scope for now.
- **TTS `speechSynthesis` quirks** (async voice loading, `pause()` flakiness)
  affect **your app code**, not the module — but they interact with the
  agent-speaking contract ([Agent integration](06-agent-integration.md)):
  disarm only when your output *actually* stopped.
- **Multi-threaded WASM** (`ort-wasm-simd-threaded`) needs cross-origin
  isolation headers (COOP/COEP); single-threaded is the tested default
  ([Architecture](08-architecture.md#threading-model)).

## Known limitations

- **Browser AEC cancels only browser-playable audio** (TTS/`<audio>`/WebAudio
  in the same tab). Other apps' audio (TV, music players) relies on the
  confirm-window gating alone — semantic filtering ("is this speech directed
  at me?") is out of scope for now.
- **No AEC**: stricter barge-in gating activates automatically
  (`degraded.aec = true`); loud speakers may still cause false interrupts —
  recommend headphones.
- **Energy fallback** (`degraded.engine = "energy"`): noise-blind by design —
  a degraded mode, always flagged, never silent.
- **Pinned CDN dependency** for full accuracy: without network (and without a
  local mirror) you get the energy engine, not Silero
  ([Engines and runtime libraries](09-engines-and-libraries.md)).
- **Single-threaded WASM budget**: Smart Turn inference at p50 ≈ 141 ms meets
  the criterion only barely without COOP/COEP headers
  ([Smart Turn](10-smart-turn.md#measured-performance)).
- **Mobile** support is out of scope for now.

---

*Prev: [Configuration & tuning](12-tuning.md) · Next: [Development](14-development.md)*
