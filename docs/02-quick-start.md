# Quick start — the demo in two minutes

> Part of the [Speak Or No Speak documentation](README.md) · prev: [What is this?](01-plain-english.md) · next: [The demo page](03-demo-page.md)

The fastest way to understand the module is to watch it work. The repository
ships a demo page that shows all three detections live: speech start, turn
end, and (with a little setup) interruption and echo behavior.

## What you need

| Requirement | Details |
|---|---|
| **A static file server** | Python 3 (`npm start`) or Node (`npm run start:serve`). There is no build step. |
| **A current browser** | Chrome, Edge, Brave, or Safari on desktop. |
| **A microphone** | Any built-in or external mic. |
| **A secure context** | The page must be served over `https://` **or** `http://localhost` — browsers only expose the microphone there. Opening the file directly (`file://`) will **not** work. |
| **Network on first load** | The demo loads two small runtime libraries and the speech model from the CDN `cdn.jsdelivr.net`. After the first successful load, the browser cache usually covers offline use. If the CDN is unreachable, the module degrades to a simpler built-in detector instead of failing (see [Troubleshooting](13-troubleshooting.md)). |

## Start the server

From the repository root:

```bash
npm start            # serves the checkout at http://localhost:5173
```

or, if you prefer Node:

```bash
npm run start:serve  # same thing via npx serve
```

## Open the demo

Open **<http://localhost:5173/demos/>** in your browser and click
**Start microphone**. Allow the microphone permission when the browser asks.

## What you should see

1. The big dot is **orange** and the label reads **press start** — the page is idle.
2. After clicking **Start microphone** (and allowing the mic), the label reads
   **not listening** — the detector is running and hears silence.
3. Say something, e.g. *"one, two, three"*:
   - after roughly a third of a second of confirmed speech the dot turns
     **green** and the label reads **listening** — this is the **speech
     started** event;
   - the dot stays green through short pauses inside your sentence — the turn
     is still open;
   - after you stop and a short silence passes, the dot returns **orange** and
     the debug line shows `turn: 1.4 s` (or similar) — this is the **turn
     ended** event, and the utterance's audio was delivered to the page.
4. Short noises (a cough, a click) produce **nothing** — they never confirm as speech.

That is the whole loop: *speech started → turn ended, with the audio attached.*

## Things to try on the demo page

- **Add noise.** Under *Add noise* you can play one of five ambient street or
  crowd recordings. Keep talking over it — turns should still be *your*
  speech, not the crowd. This tests noise robustness.
- **Computer voice.** The *Start computer voice* button makes the page speak a
  sentence out loud. Watch the dot while it talks: on browsers with working
  echo cancellation the dot stays orange (the mic does not hear the computer's
  voice as "user speech"); on a default Chromium setup without the OS
  recording permission you will see the dot react to the computer's voice —
  exactly the echo hazard this module is built around. See
  [Agent integration](06-agent-integration.md) for the full story.
- **`?noaec=1`.** Open the demo as
  <http://localhost:5173/demos/?noaec=1> to force echo cancellation off and
  compare the two worlds.
- **Transcribe turns.** Once the microphone runs, an extra row appears: tick
  *transcribe turns* and every finished utterance is sent to a transcription
  endpoint you configure. See [the demo page chapter](03-demo-page.md) and
  [Transcription](11-transcription.md).

## Optional: the transcription stub server

To see the transcription row do something without any real speech-recognition
backend, start the dev-only stub in a second terminal:

```bash
python3 demos/simple-demos/stt-stub-server.py        # listens on http://localhost:6000
python3 demos/simple-demos/stt-stub-server.py 6001   # custom port
```

It is a **mockup**: it accepts the audio and replies with a fixed canned
sentence. It exists so you can exercise the wiring end-to-end. It never
affects detection.

## Optional: the Smart Turn model

The demo's **Smart Turn** checkbox enables an optional extra: a small
(≈ 8 MB) semantic model that is asked "is this utterance actually finished?"
at every pause point — useful for hesitant speakers ("um… let me think… okay,
go now"). The weights are a one-time manual download into `vendor/`; without
them the checkbox simply has no effect. See [Smart Turn](10-smart-turn.md).

## Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `insecure-context` error | Page opened via `file://` or a non-localhost host | Serve via `http://localhost:5173` (or https) |
| `mic-denied` | Permission rejected | Allow mic access for the site in the browser settings and reload |
| `mic-not-found` | No microphone | Check devices / OS privacy settings |
| `cdn-unavailable` warning | jsDelivr blocked (offline, VPN, strict company network) | Allow the CDN, or serve the libraries locally from `/vendor/` (see [Runtime libraries](09-engines-and-libraries.md)) |
| Safari hangs on start | A known browser capture quirk | Just wait — the module retries automatically with a fallback path; always click the start button yourself |
| `vad-no-frames` | Engine started but produced no audio | Reload the page |

The full error list lives in [Troubleshooting](13-troubleshooting.md).

---

*Prev: [What is Speak Or No Speak?](01-plain-english.md) · Next: [The demo page](03-demo-page.md)*
