# Chapter 6 — Agent integration: barge-in & echo

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 5](05-api-reference.md) · next: [Chapter 7 — Detection methods](07-detection-methods.md)

This chapter is for **app authors building a talking agent**. It explains the
`setAgentSpeaking` contract, the barge-in event, and the echo handling that
keeps the agent from interrupting itself.

## 6.1 Why barge-in is hard: the echo hazard (E1)

When your agent answers through loudspeakers, the **microphone hears the
agent's own voice**. Without echo handling, every answer the system speaks
re-triggers the detector — the classic runaway feedback loop of half-baked
voice bots, and the single most common reason naive implementations fail.

Speak Or No Speak stacks three defenses:

1. **Browser AEC** — the mic is opened with `echoCancellation: true`, and the
   browser removes audio *it plays in the same tab* (your TTS) from the mic
   signal ([§6.6](#66-echo-cancellation-scope)).
2. **A confirmation window** — a "speech" burst must persist ~192 ms
   (`bargeInConfirmFrames: 6` × 32 ms) before an interrupt fires; echo tails
   and transients do not survive it.
3. **Stricter gating without AEC** — when the mic track reports no active echo
   cancellation, the confirm window widens to ~300 ms **and** the frame rms
   must exceed 2× the rolling mean rms of the agent-only playback
   ([§6.7](#67-without-aec--the-stricter-gating)).

## 6.2 The `setAgentSpeaking` contract

While your app produces audio output (TTS etc.), call
`sons.setAgentSpeaking(true)`; call `sons.setAgentSpeaking(false)` the moment
your output stops.

```js
const sons = await createSpeakOrNoSpeak({ onTurnEnd, onInterrupt });
await sons.start();

sons.setAgentSpeaking(true);   // agent starts talking
// … user barges in → onInterrupt → stop TTS playback …
sons.setAgentSpeaking(false);  // agent output ended — ALWAYS call this
```

- With the flag **armed**, **no `onTurnEnd` and no `onSpeechStart` fire**.
  Confirmed user speech triggers `onInterrupt` instead.
- **Forgetting to disarm permanently silences turn detection** — a turn that
  already reached its redemption window flushes at the moment you disarm, and
  nothing else will ever be emitted until you do.
- The flag is a *mode*, not a state: it does not appear in `sons.state`.

## 6.3 Behavior while the flag is armed

The detector keeps consuming frames, but the behavior matrix changes
([§7.5](07-detection-methods.md#75-the-state-machine)):

| Input while armed | Result |
|---|---|
| sustained speech (≥ onset threshold, passing the rms gate) | confirm frames accumulate → **`onInterrupt`** → the turn keeps accumulating |
| silence / mid frames | nothing is emitted; **no turn ends** |
| an already-open turn | accumulation continues throughout; it never ends while armed |

A subtlety: turn accumulation **continues during agent speech**. The
interrupting utterance is not lost — it arrives as the next `onTurnEnd` (with
`afterInterrupt: true`) once you disarm and the turn completes. And a turn
that reached its redemption window *while armed* is flushed at the moment you
disarm.

## 6.4 The interrupt event

```js
onInterrupt: (info) => {
  // info.atMs      — ms since the flag was armed
  // info.latencyMs — voice-onset → event (≈ confirm window actually waited)
}
```

`latencyMs` is measured from the **first above-onset frame** of the confirmed
run (`t_voice`) to the event (`t_event`) — with defaults it is ≈ 192 ms, in
no-AEC mode ≈ 300 ms. That is the *detection* latency; your total reaction
time adds your own TTS-cancellation speed, which is why the contract below
insists on cancelling first.

## 6.5 The post-interrupt contract (five rules)

1. **`onInterrupt` fires → immediately cancel your TTS/LLM stream.** This is
   the latency-sensitive path — do **not** await anything before cancelling.
2. **Call `setAgentSpeaking(false)` once your output is actually stopped** (not
   before, not much later).
3. **Turn accumulation continued throughout**: the interrupting utterance
   arrives as the next `onTurnEnd` with `afterInterrupt: true`.
4. **A 500 ms grace after the interrupt ignores silence** — the turn is not
   sliced mid-word ("hey, sto—" stays one turn).
5. **While the flag is set, `onTurnEnd`/`onSpeechStart` do not fire** — app
   code must not depend on them during agent speech.

## 6.6 Echo cancellation scope — the reference-signal rule

**A browser cancels exactly the audio it can reference.** What the mic track's
AEC references is decided per browser — the accepted `echoCancellation: true`
does NOT mean "everything my page plays". Measured per browser (rev-8.1
WP-E0–E2; full evidence: [analysis-rev-8 §3.1](../plans/rev-8/analysis-rev-8.md)):

| Browser (desktop) | Cancels your TTS (`speechSynthesis`/`<audio>`/WebAudio)? | Cancels other apps? | Scope verdict (`degraded.aecScope`) |
|---|---|---|---|
| Chrome / Edge / Ego (Chromium), default constraints | **NO** — WebRTC-remote audio only; `speechSynthesis` leaks (measured: label "listening" +605 ms into playback) | NO | `"unknown"` (settings report boolean `true` — unverifiable from JS) |
| Chromium with `echoCancellation: {ideal:"all"}` (the module default since rev-8.1) + the OS *Screen & System Audio Recording* permission | **YES** — system-wide capture; `speechSynthesis` no longer triggers speech (measured: 0 false starts) | YES | `"all"` (settings echo the string) |
| Chromium `"all"` WITHOUT the OS permission (macOS 15+) | stream may end by itself (Chromium 479234114) — the module falls back once (`aec-scope-fallback`) and reports `"unknown"` | NO | `"unknown"` |
| Safari | **YES** — the OS Voice-Processing AEC references system output; measured leak-free (0 false starts, 0 interrupts) | YES | `"unknown"` (Safari only ever reports boolean `true` — empirically system-wide, unverifiable from JS) |
| Firefox | only if mic and playback share one audio graph at the output's native rate | NO (OS reverse-stream "investigating") | `"none"`/`"unknown"` |

Practical recipes:

1. **The agent-audio route** (`createAgentAudioRoute()`, [§5.4a](05-api-reference.md#54a-createagentaudiorouteoptions)):
   play your TTS through a local WebRTC loopback so the browser classifies it
   as *remote participant* audio — the one source Chromium's AEC always
   references. Wire your source into `route.input` only, control volume on
   `route.gain.gain.value`, never play a second un-routed copy, and create it
   inside the same user gesture as the mic start. This is the fix that works
   regardless of the `"all"` scope.
2. **`speechSynthesis` cannot participate in any of this** on Chromium — its
   output cannot be captured into a route. Without the `"all"` scope + OS
   permission it leaks; prefer audio-buffer playback through the route.
3. **OS-level AEC** ([§6.10](#610-os-level-echo-cancellation)) covers
   everything, including other apps.

If the mic track reports no usable AEC (`degraded.aecScope === "none"` —
unsupported platform, forced off via options, or `?noaec=1` in the demo) —
the module does not fail: it switches to the stricter gating automatically
([§6.7](#67-without-aec--the-stricter-gating)) and reports it. An
`"unknown"` scope gets the `aec-scope-limited` warning: route your agent
audio (recipe 1) or enable the OS permission.

## 6.7 Without AEC — the stricter gating

Triggered by the scope-aware rule (rev-8.1 D5; the facade sets
`detector.noAecMode` after `start()` and re-evaluates it on
`setAgentAudioRouted`): stricter gating runs when `degraded.aecScope` is
`"none"`, or `"unknown"`/`"remote-only"` **without** an active agent-audio
route — with a route (or scope `"all"`), Chromium's AEC has a real reference
and the stricter window would only tax barge-in latency. `strictGating:
"on" | "off"` forces it either way ([§14.2](14-configuration-tuning.md#142-every-threshold-explained)).
Stricter means **both** of:

- a longer confirm window: `max(bargeInConfirmFrames,
  ceil(noAecBargeInConfirmMs / frameMs))` ≈ 300 ms;
- an rms requirement: the frame's rms must exceed
  `noAecRmsFactor (2)` × the **rolling mean rms of the last second of
  agent-only playback** (a 32-slot baseline sampled only while no confirm run
  is in progress, so the user's voice never pollutes it).

Expectation management: without AEC, loud speakers may still cause false
interrupts — recommend headphones, and surface `degraded.aec` in your UI
([§14.5](14-configuration-tuning.md#145-surfacing-degraded-flags-in-your-ui)).

## 6.8 A complete agent loop

```js
let ttsStream = null;

const sons = await createSpeakOrNoSpeak({
  onTurnEnd: async (e) => {
    const text = await transcribe(e.audio);        // your STT adapter (Chapter 13)
    ttsStream = await speakWithTts(answer(text));  // your agent answer
    sons.setAgentSpeaking(true);                   // armed while TTS plays
  },
  onInterrupt: (info) => {
    ttsStream?.cancel();        // rule 1: cancel FIRST, await nothing
    ttsStream = null;
    sons.setAgentSpeaking(false); // rule 2: disarm once actually stopped
  },
});
await sons.start();
```

The interrupting utterance then arrives as the next `onTurnEnd` with
`afterInterrupt: true` (rule 3) — handle it like any other turn.

## 6.9 Common pitfalls

| Pitfall | Consequence | Fix |
|---|---|---|
| Never calling `setAgentSpeaking(false)` | Turn detection permanently silent (only an already-redemption-eligible turn flushes at disarm) | Always disarm when output stops; wrap TTS stop in try/finally |
| Awaiting cleanup before cancelling TTS | The agent keeps talking over the user | Rule 1: cancel first, clean up after |
| Treating `onInterrupt` like `onTurnEnd` | No audio arrives with the interrupt | The utterance comes with the *next* `onTurnEnd` (`afterInterrupt: true`) |
| Relying on `onTurnEnd` while armed | Events never fire during agent speech | Rule 5; design your state machine around the flag |
| Assuming AEC covers the TV | False interrupts from other apps' audio | [§6.6](#66-echo-cancellation-scope) + [§6.10](#610-os-level-echo-cancellation); recommend headphones when `degraded.aecScope` is `"unknown"`/`"none"` |
| Playing the agent voice a second time (element + route) | One uncancelable copy leaks into the mic | Route discipline ([§5.4a](05-api-reference.md#54a-createagentaudiorouteoptions)): `route.input` is the ONLY wiring |

## 6.10 OS-level echo cancellation

The only techniques that cancel **everything** (other apps, other people's
devices, any TTS mechanism) live in the OS, keyed off `degraded.aecScope`:

| Platform | Technique | Notes |
|---|---|---|
| **macOS** | Voice Isolation mic mode: Control Center → Mic Mode (per app) | System-wide AEC + noise reduction for that app. Safari benefits by default; select it for Chrome/Ego when the `"all"` scope is unavailable. Requires the app to use the system mic path. |
| **Windows** | Voice Clarity (AI mic processing on supported hardware) / communicators-mode APOs | Set per input device in Settings → System → Sound. |
| **Linux (PipeWire/Pulse)** | `pactl load-module module-echo-cancel aec_method=webrtc` then select the `echo-cancel_source` as the browser's mic | Works everywhere; adds ~100–200 ms latency. |
| **Any** | **Headphones** | The always-works fallback: no acoustic path, no echo. Recommend whenever `degraded.aecScope` is `"unknown"`/`"none"` and barge-in matters. |

Decision guide: barge-in needed → route ([§5.4a](05-api-reference.md#54a-createagentaudiorouteoptions)) + scope `"all"` where available; barge-in not needed → `halfDuplex: true` ([§5.2](05-api-reference.md#52-options)); kiosk/IVR → headphones or OS AEC + half-duplex.

---

*Prev: [Chapter 5 — API reference](05-api-reference.md) · Next: [Chapter 7 — Detection methods](07-detection-methods.md)*
