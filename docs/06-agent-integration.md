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

## 6.6 Echo cancellation scope

**Browser AEC removes only audio played by the same browser tab** — TTS via
`speechSynthesis`, `<audio>`, or WebAudio playback of your page. It has no
effect on:

- audio from **other apps** (a music player, another browser window, a TV),
- audio from **other people** in the room.

For those, the confirm-window gating (and, without AEC, the rms-vs-baseline
gate) is the only protection. Semantic filtering ("is this speech directed at
me?") is out of scope for v1.

If the mic track reports `echoCancellation !== true` — unsupported platform,
forced off via options, or `?noaec=1` in the demo — the module does not fail:
it switches to the stricter gating automatically and reports it.

## 6.7 Without AEC — the stricter gating

Triggered when `engine.aecDegraded` is true (checked after `start()`; the
adapter emits the `no-aec` warning): the facade sets `detector.noAecMode`,
which changes barge-in gating to **both** of:

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
| Assuming AEC covers the TV | False interrupts from other apps' audio | [§6.6](#66-echo-cancellation-scope); recommend headphones when `degraded.aec` |

---

*Prev: [Chapter 5 — API reference](05-api-reference.md) · Next: [Chapter 7 — Detection methods](07-detection-methods.md)*
