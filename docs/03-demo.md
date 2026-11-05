# Chapter 3 — The demo page

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 2](02-getting-started.md) · next: [Chapter 4 — Embedding](04-embedding.md)

The demo at <http://localhost:5173/demos/simple-demos/> is the showcase of the
module. It is deliberately **wiring only**:
[`demos/simple-demos/main.js`](../demos/simple-demos/main.js) maps module
events to the DOM and contains **no detection logic** — all onset/turn/barge-in
decisions live in the facade's `TurnDetector`. That makes the demo a template
for your own integration (Chapter 4).

## 3.1 Page anatomy

Every element of [`demos/simple-demos/index.html`](../demos/simple-demos/index.html), top to bottom:

| Element | id | Purpose |
|---|---|---|
| Indicator dot | `#dot` | 120 px circle; orange (`#f59e0b`) idle, green (`#22c55e`) while a turn is open |
| Status label | `#label` | `press start` → `starting…` → `listening` / `not listening` (aria-live) |
| Mic button | `#start` | Start/stop toggle — stays visible, switches label and `aria-pressed` |
| Smart Turn checkbox | `#smartTurn` | Enable the optional semantic end-of-turn model (+8 MB asset) |
| Error line | `#err` | Red text; human-readable message from `humanMessage(code)` |
| Debug line | `#dbg` | Dimmed mono line: `turn: 1.4 s`, `barge-in after …`, etc. |
| Background sound row | `#bgRow` | Ambient MP3 select + start/stop button + volume slider |
| STT row | `#sttRow` | Hidden until the mic runs: "transcribe turns" checkbox + endpoint field |
| Event log | `#log` | Timestamped lines (newest first, last 20): turns, barge-ins, STT results, errors |

In `<head>`, the two **pinned CDN tags** load the runtime libraries
(`ort.wasm.min.js` @ 1.22.0, `bundle.min.js` @ 0.0.31). They register the
globals `ort` and `vad`, which are read **only** inside
[`src/vad/silero-vad-adapter.js`](../src/vad/silero-vad-adapter.js) —
[Chapter 11](11-runtime-libraries.md).

## 3.2 The listening indicator

The dot and label are direct mappings of module events:

| UI state | Trigger | Meaning |
|---|---|---|
| orange, "press start" | page load / stop | mic not running |
| orange, "not listening" | after start / after `onTurnEnd` | detector running, no open turn |
| green, "listening" | `onSpeechStart` | open turn |
| green (unchanged) | interior pause | the turn is **still open** — short pauses never end it (PAUSE sub-state, [§7.8](07-detection-methods.md#78-interior-pauses)) |

Note what the indicator does *not* show: discarded turns (coughs shorter than
`minSpeechMs`) flip it back to orange **without** an event — the facade's
`state` getter is authoritative for that reason ([§5.4](05-api-reference.md#54-the-facade-members)).

## 3.3 Microphone start/stop toggle

The button persists and toggles (`toggleMicrophone` in
[`demos/simple-demos/main.js`](../demos/simple-demos/main.js)):

- **Start**: creates a fresh facade instance, wires the callbacks, `start()`s
  it, exposes it as `window.__sons` (debug handle for tooling), disables the
  Smart Turn checkbox, and reveals the STT row.
- **Stop**: `sons.stop()` (releases the mic, resets detector state), clears the
  debug handle, re-enables the Smart Turn checkbox.
- On any start failure the instance is stopped and the UI fully reset; the
  error line shows the `humanMessage` for the error code.
- On `pagehide` (reload / bfcache) the mic and background audio are released
  automatically.

## 3.4 Background sound row — ambient noise on purpose

The row plays one of five ambient MP3s from
[`demos/simple-demos/assets/`](../demos/simple-demos/assets/sources.md)
on a loop, with its own start/stop button and a live volume slider (default
50 %):

| Demo label | File | Length |
|---|---|---|
| Street Protest | `street-protest.mp3` | 1:59.6 |
| Crowd | `crowd.mp3` | 0:20.0 |
| Street Sounds | `street-sounds.mp3` | 0:56.6 |
| Playground | `playground.mp3` | 1:11.1 |
| Street Sounds With People Talking | `street-sounds-people-talking.mp3` | 0:12.3 |

All sounds are from [Pixabay](https://pixabay.com/) under the Pixabay Content
License (see [`demos/simple-demos/assets/sources.md`](../demos/simple-demos/assets/sources.md) for the
original filenames and license notes).

Two design points worth understanding:

1. **The background sound is deliberately *not* `setAgentSpeaking`.** It is
   supposed to reach the detector as ambient noise, so you can test noise
   robustness: the detector should *not* produce turns from a protest crowd.
   (`setAgentSpeaking(true)` would suppress turn events entirely — the opposite
   of what this row is for. See [Chapter 6](06-agent-integration.md).)
2. **What AEC actually cancels here is browser-dependent (measured).** This is
   `<audio>` playback in the same tab: on Safari it is cancelled (system AEC);
   on Chromium with the module's `"all"` scope + the OS permission it is
   cancelled (system-wide capture); on Chromium *without* that scope the mic
   hears it — the demo's simplified page shows the measured scope live
   (`engine: … · aec scope: …`). Append **`?noaec=1`** to compare the no-AEC
   path ([§3.8](#38-url-parameters)); see
   [Chapter 6 §6.6](06-agent-integration.md#66-echo-cancellation-scope) for
   the measured per-browser table.

## 3.4a The simplified voice demo (`demos/simple-demos/demo-simplified-voice-iife-bundle.html`)

The minimal AEC-experiment page (used for the rev-8.1 measurements):

- Loads the pinned CDN bundle by default; **`?local=1`** swaps in the repo
  build (`../../build/speak-or-no-speak.iife.js`) so `src/` changes are testable
  without a CDN push (note: the dev server's clean-URL redirect drops query
  strings — use the extension-less URL
  `/demos/simple-demos/demo-simplified-voice-iife-bundle?local=1`).
- **Voice source toggle** — `speechSynthesis` (cannot be routed; on Chromium
  it leaks without the `"all"` scope + OS permission) vs **audio buffer
  (routed)** — plays `demos/simple-demos/agent-voice-sample.wav` through
  `createAgentAudioRoute()` (the route is created in the mic-start click,
  gesture-scoped).
- **AEC status line** — `(engine: … · aec scope: …)` after start, plus the
  scope warnings.
- URL params: **`?routemode=loopback|direct`** (forces the route mode),
  **`?echogate=1`** (coherence echo gate, WP-E3), **`?strictgating=on|off`**
  (gating override), **`?noaec=1`**, **`?voicegate=1`** (voice-profile gate,
  WP-E4 — default off everywhere).

## 3.5 Smart Turn checkbox

The **Smart Turn (+8 MB, semantic end-of-turn)** checkbox enables the optional
`SmartTurnModel` for the session ([Chapter 12](12-smart-turn.md)). One model
instance is cached across start/stop cycles, so the ONNX session loads once.
If the weights are missing from `/vendor/`, the model fails open: turn ends
emit anyway and the checkbox just has no effect. The checkbox is disabled while
the mic runs.

## 3.6 Transcription row & event log

Once the microphone runs, the STT row appears:

- **"transcribe turns"** checkbox — enables transcription of every completed
  turn.
- **Endpoint field** — default `http://localhost:6000/transcribe`, i.e. the
  stub server from [§2.3](02-getting-started.md#23-optional-the-python-stt-stub-server).
  Any endpoint accepting a WAV POST and answering
  `{ "text": "…", "confidence": 0..1 }` works.

The wiring is the reference pattern of the STT plug point
([Chapter 13](13-transcription.md)): `onTurnEnd` → fire-and-forget
`CloudStubAdapter.transcribe(e.audio)` with a `.catch` that logs — an STT
failure can never affect detection.

The **event log** (`#log`) records turn ends, barge-ins
(`barge-in after NNNN ms (latency NNN ms)`), STT results
(`💬 "…" (90%)`), STT failures, and background-sound errors — each with a
timestamp. It keeps the last 20 lines.

## 3.7 The Python script: what it does and what it does NOT do

[`demos/simple-demos/stt-stub-server.py`](../demos/simple-demos/stt-stub-server.py) is a **dev-only STT
stub endpoint** ("WP9 verification"). Its entire behavior:

- Listens on `http://localhost:6000/transcribe` (port configurable as the first
  CLI argument).
- **`POST /transcribe`**: reads the request body, checks whether it starts with
  the `RIFF` magic (i.e. is a WAV), and answers **200** with a canned JSON
  payload:
  - WAV body → `{ "text": "(stub) recognized turn audio", "confidence": 0.9, "bytes": <n>, "wav": true }`
  - anything else → `{ "text": "(stub) turn received", …, "wav": false }`
- **`OPTIONS /transcribe`**: answers 204 with permissive CORS headers
  (`Access-Control-Allow-Origin: *`, methods `POST, OPTIONS`, headers
  `Content-Type, Authorization, X-Language`) so the browser demo can call it.

What it is **NOT**:

- **Not a speech recognizer.** It runs no model and does no audio processing —
  the "transcription" is a fixed string. Its only real check is the 4-byte
  `RIFF` magic.
- **Not part of the package.** It is a development fixture for verifying the
  STT wiring end-to-end (POST → JSON → UI), never shipped by npm.
- **Not a translation service.** Despite the "translate mockup" nickname, it
  neither translates nor transcribes; it echoes canned text.
- **Not a security reference.** Wide-open CORS and no auth are fine for a
  localhost dev stub, wrong for production (see [§13.6](13-transcription.md#136-privacy-and-security-notes)).

## 3.8 URL parameters

| Parameter | Effect |
|---|---|
| `?noaec=1` | Forces `echoCancellation: false` on the mic constraints — exercises the no-AEC branch (`no-aec` warning, stricter barge-in gating, `degraded.aec = true`) on any machine. Useful to compare AEC on/off ([Chapter 6](06-agent-integration.md)). |

(The demo also cache-busts its module with `main.js?v=3` — a version query
bumping the stale module cache while the dev server sends no `Cache-Control`
header. Bump it when `demos/simple-demos/main.js` changes.)

## 3.9 Suggested experiments

1. **Noise robustness:** start the mic, play *Street Protest* at 50 %, and
   speak — turns should still be your speech, not the crowd.
2. **AEC comparison:** repeat with and without `?noaec=1`; without AEC the
   background track is louder in the detector's ears.
3. **Endpointing:** say *"let me think … okay, go now"* — with the default
   adaptive redemption the whole thing should arrive as **one** turn; with
   Smart Turn enabled, even longer thinking pauses should not split it
   ([Chapter 12](12-smart-turn.md)).
4. **Timing:** watch `turn: N s` and the `stats` of the `TurnEndEvent` via the
   console (`window.__sons._detector.traces` with `debug: true`).
5. **Distance:** step 2 m away from the mic (scenario s9 in the calibration
   set, [§16.5](16-build-test-publish.md#165-the-replay-harness-and-calibration-recordings)).

**Bundle variants of this demo:** the exact same UI and wiring also ships as
two single-file pages that load **only the prebuilt bundle** instead of
[`src/`](../src/index.js) —
[`demos/simple-demos/demo-esm-bundle.html`](../demos/simple-demos/demo-esm-bundle.html) (ESM import,
[§4.3](04-embedding.md#43-mode-2--prebuilt-esm-bundle)) and
[`demos/simple-demos/demo-iife-bundle.html`](../demos/simple-demos/demo-iife-bundle.html) (classic script +
`window.SpeakOrNoSpeak` global,
[§4.4](04-embedding.md#44-mode-3--prebuilt-iife-bundle-classic-script-no-modules)).
Serve the checkout (`npm start`) and open
`http://localhost:5173/demos/simple-demos/demo-esm-bundle.html` or
`http://localhost:5173/demos/simple-demos/demo-iife-bundle.html` — everything in this chapter
(page anatomy, the `?noaec=1` parameter, suggested experiments) applies to both
unchanged.

---

*Prev: [Chapter 2 — Getting started](02-getting-started.md) · Next: [Chapter 4 — Embedding](04-embedding.md)*
