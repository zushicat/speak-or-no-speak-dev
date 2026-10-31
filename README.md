# Speak Or No Speak

Detects: speech start · turn end · barge-in interruption.

## Run the demo

    npm start            # python3 http.server on http://localhost:5173
    npm run start:serve  # alternative via npx serve

Open http://localhost:5173/demo/ (a secure context is required for microphone
access — `file://` will NOT work). Click **Start microphone** and allow the
prompt; the same button becomes **Stop microphone** and releases the mic again.

The **Background sound** row plays one of the ambient MP3s from `demo/assets/` on a
loop, with its own start/stop button and a live volume slider (default 50 %). It
is independent of the mic and is deliberately *not* agent output, so it reaches the
detector as ambient noise — useful for testing noise robustness. Because it is
`<audio>` playback in the same tab, AEC may partially cancel it; append
`?noaec=1` to compare the no-AEC path.

## Requirements

- Serving: Python 3 (default on macOS) — or Node + `npx serve` via `start:serve`.
- Tests: Node ≥ 18 (`node --test`, zero test dependencies).
- Browsers: a current Chromium browser and/or Safari.

## Layout (zero-build)

No bundler, no TypeScript compile — plain ES modules loaded straight from the
static server, runtime libraries pinned via CDN `<script>` tags.

    demo/index.html    demo page (green/orange listening indicator)
    demo/main.js       demo wiring — UI mapping only, no detection logic
    demo/assets/       background-noise MP3s (see demo/assets/sources.md)
    src/               the module (facade, VAD adapters, turn state machine)
    test/unit/         node --test suite · test/util/ + test/harness (later WPs)
    plans/             implementation plan & work packages (not published)

## Status

Work in progress — see plans/initial/plan-initial.md.

## Embedding (WP7 — two modes, same API)

> Prebuilt single-file distribution (no npm install, no bundler):
> [`build/speak-or-no-speak.esm.js`](build/speak-or-no-speak.esm.js) (+ IIFE
> variant) — see [README-BUNDLE.md](README-BUNDLE.md).

### Mode 1 · zero-build page (CDN script tags)

```html
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"></script>
<script type="module">
  import { createSpeakOrNoSpeak } from "./src/index.js";
  const sons = await createSpeakOrNoSpeak({
    onSpeechStart: () => console.log("user started"),
    onTurnEnd: (e) => console.log("turn end", e.durationMs, "ms"),
    onInterrupt: (i) => console.log("barge-in after", i.latencyMs, "ms"),
  });
  await sons.start(); // call from a user gesture (Safari)
</script>
```

### Mode 2 · bundler / npm

    npm i speak-or-no-speak @ricky0123/vad-web onnxruntime-web

```js
import { createSpeakOrNoSpeak } from "speak-or-no-speak";
// same API; the adapter auto-imports @ricky0123/vad-web when window.vad is absent
```

ESM-only (`"type": "module"`); the adapter resolves the library in this order:
`window.vad` (CDN) → `import("@ricky0123/vad-web")` (bundler) → energy fallback.
Serve over **https or localhost** — microphone access needs a secure context.

## Known limitations

- **Browser AEC cancels only browser-played audio** (TTS/`<audio>`/WebAudio in
  the same tab). Other apps' audio (TV, music players) relies on the
  confirm-window gating alone.
- **No AEC** (unsupported platform / forced off): the module auto-switches to
  stricter barge-in gating (`degraded.aec = true`); loud speakers may still
  cause false interrupts — recommend headphones.
- **Energy fallback** (`degraded.engine = "energy"`): noise-blind by design
  (RMS vs adaptive floor) — a degraded mode, always flagged, never silent.
- **Safari**: AudioWorklet module load can hang in some versions → the
  adapter auto-falls back to `ScriptProcessor` (verified path). iOS Safari: mic
  requires a user gesture; AEC quality unverified — mobile support out of scope
  for v1.

## Adding transcription (WP9 plug point)

STT lives **strictly outside the real-time loop**: adapters are called only
with `onTurnEnd` audio (16 kHz mono, incl. the pre-speech pad) and never
touch detection. The module ships **no** STT engine — you supply the adapter:

```js
import { createSpeakOrNoSpeak, CloudStubAdapter } from "speak-or-no-speak";

const stt = new CloudStubAdapter({
  endpoint: "https://your-stt.example/transcribe", // POST, WAV body → {text, confidence}
  token: "…",                                      // from YOUR config, never hardcoded
});

const sons = await createSpeakOrNoSpeak({
  onTurnEnd: (e) => {
    stt.transcribe(e.audio, { language: "en-US" })
      .then((t) => console.log("💬", t.text))
      .catch((err) => console.warn("STT failed (detection unaffected):", err.message));
  },
});
```

- The shipped example: `CloudStubAdapter` (~50 lines, WAV POST + JSON) — the
  demo wires it with a local stub (`demo/stt-stub-server.py`, dev-only).
- **Zero-backend option:** the Web Speech API (`SpeechRecognition`) can run
  in parallel with listening and harvest the final result matching the turn
  window — Chromium-only, server-backed (not Baseline per MDN), and the audio
  leaves the machine (privacy caveat). Zero audio plumbing, though — a good
  prototyping shortcut.
- The hard rule: **no STT in the real-time path.** An adapter failure must
  never affect `onSpeechStart`/`onTurnEnd`/`onInterrupt` — wrap at YOUR level
  (the demo shows the pattern).

## Agent integration (read this, app authors!)

While your app plays audio (TTS etc.), call `setAgentSpeaking(true)`; call
`setAgentSpeaking(false)` the moment your output stops.

- With the flag **armed**, no `onTurnEnd` and no `onSpeechStart` events fire.
  Confirmed user speech triggers `onInterrupt` instead (barge-in, S3).
- Forgetting to **disarm** permanently silences turn detection — a turn that
  already reached its redemption window flushes at the moment you disarm.
- The interrupt carries `{ atMs, latencyMs }` (ms since the flag was armed /
  voice-onset-to-event latency).

```js
const sons = await createSpeakOrNoSpeak({ onTurnEnd, onInterrupt, /* … */ });
await sons.start();
sons.setAgentSpeaking(true);   // agent starts talking
// … user barges in → onInterrupt → stop TTS playback …
sons.setAgentSpeaking(false);  // agent output ended — ALWAYS call this
```

### Post-interrupt contract (WP5)

1. `onInterrupt` fires → **immediately cancel your TTS/LLM stream**. This is
   the latency-sensitive path — do not await anything before cancelling.
2. Call `setAgentSpeaking(false)` once your output is actually stopped.
3. Turn accumulation continued throughout: the interrupting utterance arrives
   as the next `onTurnEnd` with `afterInterrupt: true`.
4. A 500 ms grace after the interrupt ignores silence — the turn is not
   sliced mid-word ("hey, sto—" stays one turn).
5. While the flag is set, `onTurnEnd`/`onSpeechStart` do not fire — app code
   must not depend on them during agent speech.

### Echo cancellation scope (important!)

Browser AEC (`echoCancellation: true`) removes **audio played by the same
browser tab** — TTS via `speechSynthesis` or `<audio>`/WebAudio playback.
Audio from *other apps* (music players, other people's TVs) is **not**
cancelled; barge-in gating (confirm windows) is the only protection there.

If the mic track reports `echoCancellation !== true` (unsupported platform,
forced off, or `?noaec=1` in the demo), the module switches to stricter
gating automatically (`degraded.aec === true`): ~300 ms barge-in confirm AND
the frame rms must exceed 2× the rolling mean rms of the last second of
agent-only playback. Without AEC, loud speakers may still cause false
interrupts — recommend headphones and surface `degraded.aec` in your UI.

