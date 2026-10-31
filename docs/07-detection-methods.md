# Chapter 7 — How detection works: the methods

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 6](06-agent-integration.md) · next: [Chapter 8 — Architecture](08-architecture.md)

This chapter explains **what is implemented and why** — the detection method
itself. The reference implementation is
[`src/turn/turn-detector.js`](../src/turn/turn-detector.js); the method
rationale descends from the initial method analysis
([`plans/initial/problem-analysis-initial.md`](../plans/initial/problem-analysis-initial.md),
recapped in [Chapter 17](17-background.md)).

## 7.1 The problem decomposition

"Detect speech" is really **three detection problems plus one hazard**, and
each needs its own method:

| # | Problem | Why it is its own problem |
|---|---|---|
| **S1** | Speech onset | Must be fast (≤ ~300 ms feels instant) *and* immune to clicks, coughs, keyboard clatter |
| **S2** | Turn end (endpointing) | Must not cut people off mid-sentence, yet react quickly when they are done; a fixed timeout is either slow or trigger-happy |
| **S3** | Barge-in | Must react within ~100–250 ms of real speech *while ignoring the agent's own voice* |
| **E1** | Echo | The mic hears the system's answer; without handling, every answer re-triggers the detector |

## 7.2 Frames and speech probability

Audio arrives as **frames**: 16 kHz mono chunks of **512 samples = 32 ms**
(Silero v5's model-derived frame size — [§10.3](10-vad-engines.md#103-runtime-verified-vad-web-findings)),
about **31 frames per second**. Each frame carries a `VadFrame`:

```js
{
  probability: 0.87,   // P(speech) for this frame, 0..1 — from Silero
  frame: Float32Array, // the raw 16 kHz mono samples of this frame
  rms: 0.042,          // loudness 0..1 (computed from the frame)
  durationMs: 32       // real audio time — drives all timing in the machine
}
```

Two things to note:

- **The probability comes from a neural model** — it distinguishes speech from
  noise, music, and keyboards (which a pure energy VAD cannot;
  [Chapter 10](10-vad-engines.md)).
- **All timing is audio-time-based** (`durationMs`), not wall-clock. Frame
  delivery is bursty (ScriptProcessor buffers deliver 2–3 frames at once), but
  that cannot skew the state machine's timing ([§8.7](08-architecture.md#87-threading-model)).

## 7.3 Hysteresis: two thresholds

A single threshold ("speech if p > 0.5") flickers at the boundary. The machine
therefore uses **two**:

- `onsetSpeechThreshold` (0.6): a frame counts as **speech** at or above this,
- `negativeSpeechThreshold` (0.35): a frame counts as **silence** at or below
  this,
- frames **in between** ("mid") are hysteresis: they change nothing — speech
  continues during a turn, silence continues during a pause.

## 7.4 Onset confirmation

In `ready` state, one loud frame means nothing. Speech must persist
**`onsetConfirmFrames` (9) × 32 ms ≈ 288 ms** at/above the onset threshold
before `onSpeechStart` fires. One quiet frame resets the counter. This window
is what makes coughs, door slams, and single keyboard clatters non-events —
and it is the main contributor to S1 latency (0.3 s to *confirm*, plus frame
granularity).

## 7.5 The state machine

The whole detector is **one state × one boolean** — deliberately tiny:

```
states:  "ready" | "listening" | "pause"     flag: agentSpeaking
"pause" is a SUB-state of listening: the turn is still open,
only the endpointing gets patient.
```

Behavior matrix (`agentSpeaking = false`):

| State | silence (≤ negative) | speech (≥ onset) | mid (between) |
|---|---|---|---|
| `ready` | count confirm frames → `onSpeechStart` | confirm / accumulate | no change |
| `listening` | silence ≥ `shortPauseMs` → PAUSE; silence ≥ redemption → **turn end** | resume / accumulate | no change (hysteresis) |
| `pause` | silence ≥ redemption → **turn end** | speech → LISTENING (turn continues) | stay in pause (hysteresis) |

With `agentSpeaking = true` (barge-in mode): stay put, **no turn ends**, no
speech-start events; speech frames accumulate interrupt-confirm frames →
**`onInterrupt`** → `listening` (accumulation continues).

Why a hand-written machine instead of vad-web's own `onSpeechStart`/
`onSpeechEnd`? Because vad-web's segmentation is a fixed silence timeout — it
has no adaptive endpointing, no barge-in mode, no turn audio with pad control,
and no pause sub-state. The adapter reads vad-web **frames only** and owns the
turn semantics ([§8.8](08-architecture.md#88-design-decisions-and-their-reasons)).

## 7.6 Turn endpointing: the redemption window

After the onset, the question is *when is the user done?* The naive answer is
a fixed silence timeout — 700 ms either feels slow or cuts people off
([§17.2](17-background.md#172-the-candidate-solutions-ah-and-their-scores)).
The machine instead ends the turn when consecutive silence reaches the
**redemption window** — starting from a **base** of `redemptionMs` (650 ms)
that is then adapted per turn:

## 7.7 Adaptive redemption (`redemptionFor`)

The policy ([`src/turn/turn-detector.js`](../src/turn/turn-detector.js#L59-L65))
reads the **current turn's rhythm stats** at every silence check — patient
when the user hesitates, snappy when they are fluent, the way humans decide
"are they done?":

| Condition (current turn) | Window | Reading |
|---|---|---|
| `speechMs ≥ 2000` and `interiorPauses === 0` | base **− 200 ms** (450) | fluent long turn → snappy |
| `interiorPauses ≥ 2` **or** `speechMs < 600` | base **+ 200 ms** (850) | hesitant turn → patient |
| `longestPauseMs ≥ 800` | **max(ms, base + 250)** (900) | user pauses a lot → patient |
| always | clamped to **350–1200 ms** | hard floor/ceiling |

The stats (`speechMs`, `interiorPauses`, `longestPauseMs`) are also shipped on
every `TurnEndEvent.stats` for tuning and telemetry.

## 7.8 Interior pauses

Silence inside a turn is **not** the end of the turn until redemption is
reached:

- silence ≥ `shortPauseMs` (250 ms) opens the **PAUSE sub-state** — the turn
  stays open, the indicator stays green;
- speech resumes → the pause is counted (`interiorPauses++`,
  `longestPauseMs` updated) and the machine returns to `listening`;
- silence keeps growing → redemption eventually ends the turn.

So *"let me think … okay"* is one turn, and the pause itself feeds the
adaptive window (a thinker gets a *longer* next window).

## 7.9 Turn boundaries and guards

**`minSpeechMs` (250) — the discard rule, with a subtlety.** A turn whose
speech time is below `minSpeechMs` is discarded **silently** (no event, state
back to `ready`) — that is the cough/click guard. The subtlety
(decision **D-WP3-1**): `speechMs` **includes the confirm-window speech**.
With 32 ms frames the confirm window is 288 ms of *real, confirmed* speech;
counting only post-confirm speech discarded genuine short commands live
("one" → green dot, no turn end). With defaults, any confirmed onset already
carries ≥ 288 ms of counted speech, so `minSpeechMs` acts as a second,
user-tunable guard (relevant if you shrink the confirm window).

**`preSpeechPadMs` (200) — never clip word onsets.** Every frame's audio is
pushed into a fixed-capacity **ring buffer**
([`src/turn/ring-buffer.js`](../src/turn/ring-buffer.js)); at onset the buffer
is flushed as the turn's *pad*. The capacity is sized
`preSpeechPadMs + onsetConfirmFrames × frameDuration`, so the pad contains the
200 ms *before* the first confirmed-speech sample **plus the confirmed onset
frames themselves** — nothing of the utterance start is lost even though
confirmation took 288 ms.

**`maxTurnMs` (30000) — the runaway guard.** A turn longer than 30 s is
force-ended with `truncated: true` (the audio is still delivered).

## 7.10 Barge-in confirmation and grace

While `agentSpeaking` is armed ([Chapter 6](06-agent-integration.md)):

- Speech frames (≥ onset threshold, passing the optional rms gate) increment
  the **interrupt-confirm counter**; silence decrements it. At
  `bargeInConfirmFrames` (6 ≈ 192 ms) — or ~300 ms in no-AEC mode — the
  interrupt fires.
- `latencyMs` is measured from the first above-onset frame of the run
  (`t_voice`) to the event: it *is* the confirm window actually waited.
- The interrupt **never emits `onSpeechStart`** — it *is* the onset (rule 2 of
  the machine). If the agent flag was armed during an open turn, accumulation
  continues seamlessly; if armed during `ready`, the turn starts from the
  flushed ring pad.
- `graceAfterInterruptMs` (500): for 500 ms after the interrupt, silence does
  **not** count toward redemption — "hey, sto—" is not sliced mid-word, and
  the whole utterance arrives as one `onTurnEnd` with `afterInterrupt: true`.
- New speech cancels a pending semantic-model evaluation and the turn
  continues (see [§12.2](12-smart-turn.md#122-when-it-runs-and-fail-open-semantics)).

## 7.11 Worked examples

**Fluent command** — *"one two three"* (~1.2 s, no pauses): confirm 288 ms →
`onSpeechStart`; silence starts; redemption = 650 − 0 = 650 ms? No — fluent
long turn requires ≥ 2 s speech, so base 650 applies → `onTurnEnd` ~0.94 s
after speech end, `stats.interiorPauses = 0`.

**Hesitant speaker** — *"um … let me think … okay, go now"*: two interior
pauses → after the second pause `interiorPauses ≥ 2` → redemption widens to
850 ms; the pauses count in `longestPauseMs` (≥ 800 → max 900 ms). Still one
turn. (With the silence-only baseline this class of speech *did* split — that
evidence is what admitted Smart Turn through the WP8 gate, [§12.6](12-smart-turn.md#126-when-to-use-it-and-when-not).)

**Barge-in** — agent talking (armed), user says *"hey, stop"*: frames pass
onset + rms gate; after ~192 ms `onInterrupt` (latencyMs ≈ 192); TTS cancelled,
flag disarmed; 500 ms grace ignores the trailing silence; the utterance
arrives as one `onTurnEnd` with `afterInterrupt: true`.

**A cough** — single 150 ms burst: never fills the 288 ms confirm → machine
stays in `ready`, no event at all.

**A 35 s monologue**: at 30 s the turn force-ends with `truncated: true`;
audio delivered so far.

## 7.12 What the turn audio contains

At `onTurnEnd` the event's `audio` is one `Float32Array`: **pre-speech pad +
confirm frames + all accumulated turn frames**, 16 kHz mono.
`durationMs = audio.length / 16000 × 1000` (speech + pad). Helpers:

- `encodeWav(audio)` → WAV `Blob` (browser) / `Buffer` (Node)
- `encodeWavBytes(audio)` → raw WAV `ArrayBuffer`

The demo's "save last turn" pattern and the calibration harness replay both
build on this ([Chapter 16](16-build-test-publish.md)).

---

*Prev: [Chapter 6 — Agent integration](06-agent-integration.md) · Next: [Chapter 8 — Architecture](08-architecture.md)*
