# Chapter 1 — Introduction

> Part of the [Speak Or No Speak documentation](README.md) · next: [Chapter 2 — Getting started](02-getting-started.md)

## 1.1 What is Speak Or No Speak?

**Speak Or No Speak** is an embeddable JavaScript module for the browser that
listens to a microphone stream and detects the three moments a voice interface
needs to know about:

1. **the user starts speaking** (speech onset),
2. **the user has finished their utterance** (turn end / endpointing),
3. **the user interrupts the system while it is answering** (barge-in).

It is a **library, not a service**: plain ES modules you import from a static
server (or a prebuilt single-file bundle), running entirely **on-device** in the
browser — no backend, no keys, no audio leaving the machine for detection. Its
detection core is [Silero VAD](https://github.com/snakers4/silero-vad) (a small,
noise-robust neural speech detector) wrapped in an **adaptive turn-endpointing
state machine** with **browser echo cancellation (AEC)** as the echo-safety
groundwork.

The intended consumer is a **voice agent** — a chatbot or game avatar you talk
to — where this module is the "ears" of the loop: it tells your app *when* to
start listening for content, *when* the user is done, and *when* the user
interrupted your answer.

## 1.2 What it does

The problem looks like one thing ("detect speech") but is really **three
distinct detection problems plus one cross-cutting hazard**. The module treats
them separately, and each has its own event, latency budget, and failure mode:

| # | Detection | Event | What "good" means |
|---|---|---|---|
| **S1** | Speech onset — silence → speech transition | `onSpeechStart` | Fast enough to feel responsive: ≤ ~300 ms feels instant, > 500 ms feels laggy. Implemented as a 288 ms onset-confirm window (Chapter 7). |
| **S2** | Turn end — "the sentence is done" (classic **endpointing**) | `onTurnEnd` (carries the turn audio) | The hard one: a pause mid-sentence ("let me think… okay") must **not** end the turn, but real completion must be picked up quickly. A fixed timeout is either slow or cuts people off — so the window is **adaptive** (Chapter 7). |
| **S3** | Barge-in — user speaks again while the agent answers | `onInterrupt` | Within ~100–250 ms of *real* user speech, without firing on the agent's own voice. Implemented with a confirm window (~192 ms; ~300 ms without AEC) plus echo handling. |
| **E1** | Echo — the mic hears the system's own answer (cross-cutting hazard for S3) | — (handled, not emitted) | Without echo handling every answer re-triggers the detector — the classic runaway feedback loop of half-baked voice bots. Handled by browser AEC + confirmation gating; stricter gating when AEC is unavailable (Chapter 6). |

The module's job ends with the events: it hands you **discrete, actionable
events** (not raw probabilities), and for every completed turn it hands you the
**turn audio** itself — 16 kHz mono `Float32Array`, including a 200 ms
pre-speech pad — ready to feed into transcription, save as WAV, or replay.

### Non-functional requirements it is built against

| Requirement | How the design addresses it |
|---|---|
| Lightweight | ~2 MB Silero model + ONNX Runtime Web WASM (cached after first load); optional Smart Turn adds 8 MB. Detection runs in well under 1 ms per frame on the main thread. |
| Reliable in real rooms | Neural VAD (noise-robust), adaptive thresholds, a calibration harness with recorded scenarios, and a degradation ladder instead of brittle assumptions. |
| JavaScript module | Runs in the browser (primary) and stays importable in Node for tests; usable as a library, not a service. |
| Action-triggering | Emits `onSpeechStart` / `onTurnEnd` / `onInterrupt` — discrete events, not probability streams. |
| On-device / privacy | All detection is local and network-independent; nothing is uploaded by the module. Only an optional STT adapter you wire yourself might send audio anywhere (Chapter 13). |

## 1.3 What it is NOT

Boundaries matter as much as features. The module deliberately does **not**:

- **Transcribe speech.** There is no STT engine inside — transcription is a
  **plug point** (Chapter 13): you supply an adapter, the module hands you the
  turn audio at `onTurnEnd`. The shipped `CloudStubAdapter` is a ~50-line
  dev example, and the demo's Python server is a canned mockup, not a
  recognizer.
- **Speak, answer, or think.** No TTS, no LLM, no dialogue management. Your app
  produces the answers; the module only tells you when the user is talking
  (and calls `setAgentSpeaking(true/false)` to tell the module when *you* are).
- **Do wake-word, keyword spotting, or intent recognition.** "Speak or no
  speak" is about turn timing, not about *what* was said.
- **Run a server or a cloud dependency.** Detection is fully local. The only
  network use is loading pinned runtime libraries from a CDN (Chapter 11) — and
  even that degrades gracefully to a local fallback engine if the CDN is
  unreachable.
- **Support mobile.** Desktop Chromium and Safari are the v1 targets; iOS
  Safari is unverified and mobile support is out of scope for v1.
- **Record audio sessions.** It buffers only the current turn (for the
  `onTurnEnd` payload). You can export a turn as WAV, but the module is not a
  recorder.

## 1.4 Design goals and constraints

The goals below shape almost every implementation decision in later chapters:

1. **Lightweight.** Model + assets ≲ 10 MB, CPU low enough to coexist with a
   game or LLM app. This ruled out in-browser streaming STT as the detection
   backbone (tens of MB, laggy) and drove the choice of Silero VAD
   (Chapter 17 tells that story).
2. **Reliable over clever.** Real rooms have TVs, music, keyboards, and doors.
   The design prefers confirmed windows, hysteresis, and measured degradation
   over clever single-frame decisions.
3. **On-device and private.** Every real-time decision is local and
   network-independent. The module sends nothing anywhere, ever.
4. **Events, not probabilities.** Apps integrate against three events and one
   flag — not a frame stream they must interpret themselves.
5. **Zero-build source, zero forced toolchain.** No bundler, no TypeScript
   compile: plain ES modules loaded straight from a static server, runtime
   libraries pinned via CDN `<script>` tags (Chapter 4). A prebuilt single-file
   bundle exists for consumers who want exactly one file (Chapter 4, 16).
6. **Degrade, never die — and never silently.** If the neural engine cannot
   load, the module falls back to an energy-based engine and flags it
   (`degraded.engine = "energy"`). If echo cancellation is unavailable, it
   switches to stricter barge-in gating and flags it (`degraded.aec`). If the
   optional semantic turn model fails, the turn end emits anyway (fail-open).
   Every degradation is observable via `onError` + `degraded` (Chapter 15).
7. **No hidden constants.** Every timing threshold is an option with a
   documented default (Chapter 5, 14) — tunable per app.
8. **Testable without a microphone.** The detection core is a pure state
   machine (no `window`/`document` access), unit-tested in Node with recorded
   scenario fixtures (Chapter 16).

## 1.5 Where it fits in a voice-agent stack

The module owns the **real-time ear** of the loop; your app owns everything
else:

```
            ┌────────────────────────── your app ──────────────────────────┐
            │                                                              │
 user ──► mic ──► [ speak-or-no-speak ] ── onTurnEnd(audio) ──► your STT ─┐│
            │              ▲  │                                           ││
            │              │  └─ onSpeechStart / onInterrupt ──────────┐   │▼
            │   setAgentSpeaking(true/false)                          │   LLM
            │              │                                          ▼    │
            │              └────────────── your TTS ◄──────────────────────┘
            └──────────────────────────────────────────────────────────────┘
```

- While your agent **talks** (TTS playing), you arm the module with
  `setAgentSpeaking(true)`. It keeps listening silently; confirmed user speech
  fires `onInterrupt` so you can cancel the TTS/LLM stream immediately
  (Chapter 6).
- When a turn **ends** (`onTurnEnd`), the module hands you the turn audio; you
  transcribe it with whatever backend you like — strictly outside the
  real-time loop (Chapter 13) — and answer.
- The module never blocks on your app: transcription failures, slow LLMs, and
  TTS hiccups cannot affect detection.

## 1.6 Status, versioning, license

- **Version:** `0.1.0` — work in progress; the API is stable in shape but the
  project is young. See [`package.json`](../package.json).
- **License:** MIT. The bundle ships no third-party code; the two runtime
  libraries (vad-web, onnxruntime-web) are loaded at runtime under their own
  licenses (Chapter 11).
- **Package shape:** ESM-only (`"type": "module"`, entry `src/index.js`,
  exports field) — Chapter 9.
- **Planning documents** live in [`plans/`](../plans/) (implementation plans,
  work packages, the method analysis behind Chapter 7 and Chapter 17). They are
  development artifacts, not published with the npm package.
- **Documentation status:** this documentation set (rev-4) was generated from
  the sources and READMEs listed in the
  [coverage map](README.md#coverage-map--where-the-existing-material-lands).

---

*Prev: [Documentation index](README.md) · Next: [Chapter 2 — Getting started](02-getting-started.md)*
