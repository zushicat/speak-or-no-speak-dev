# Chapter 2 — Getting started

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 1](01-introduction.md) · next: [Chapter 3 — The demo page](03-demo.md)

This chapter gets you from a fresh checkout to a working demo in about two
minutes. The demo is the fastest way to see all three detections (S1 onset,
S2 turn end, S3 barge-in) live.

## 2.1 Requirements

| Requirement | Details |
|---|---|
| **Serving** | Python 3 (default on macOS) for `npm start`, or Node + `npx serve` for `npm run start:serve`. A static file server is all you need — there is no build step. |
| **Tests** (optional) | Node ≥ 18 — the test suite runs on `node --test` with zero test dependencies. |
| **Browsers** | A current Chromium browser (Chrome, Edge, Brave…) and/or Safari. Mobile browsers are out of scope for v1. |
| **Secure context** | The page must be served over `https://` **or** `http://localhost` — the microphone API (`getUserMedia`) is unavailable otherwise. `file://` will **not** work. |
| **Network (first load)** | The pinned runtime libraries load from `cdn.jsdelivr.net` (Chapter 11). After the first successful load the browser cache covers offline use; if the CDN is blocked at load time the module degrades to the energy-based fallback engine instead of failing (Chapter 15). |
| **Optional: Smart Turn weights** | The semantic end-of-turn model needs one manual download (~8 MB) into `vendor/` — see [Chapter 12](12-smart-turn.md). The demo works without it. |

## 2.2 Starting the HTTP server

From the repository root:

```bash
npm start            # python3 http.server on http://localhost:5173
```

or the Node alternative:

```bash
npm run start:serve  # npx --yes serve -l 5173 .
```

Then open **<http://localhost:5173/demos/simple-demos/>**.

Why a server at all? Two reasons: ES modules do not load over `file://`, and
microphone access requires a **secure context** — which `http://localhost`
satisfies. Nothing is compiled or bundled for the demo; the server just serves
the plain source files (the *zero-build* layout, [Chapter 9](09-source-files.md)).

## 2.3 Optional: the Python STT stub server

If you want to try the **transcription plug point** (the demo's "transcribe
turns" row), start the dev-only stub in a second terminal:

```bash
python3 demos/simple-demos/stt-stub-server.py          # listens on http://localhost:6000
python3 demos/simple-demos/stt-stub-server.py 6001     # custom port
```

Important expectations, up front:

- It is a **mockup**. It accepts a `POST /transcribe` with a WAV body and
  returns a **canned** JSON answer (`"(stub) recognized turn audio"`,
  confidence 0.9) — it does **not** run speech recognition of any kind.
- It exists so the demo's STT wiring (POST → JSON → log line) can be exercised
  end-to-end without a real backend. See [§3.7](03-demo.md#37-the-python-script-what-it-does-and-what-it-does-not-do)
  and [Chapter 13](13-transcription.md).

You can skip this entirely for detection testing — the stub never affects
detection behavior.

## 2.4 First run walkthrough

1. Open <http://localhost:5173/demos/simple-demos/>.
2. Click **Start microphone** (this is a user gesture — Safari requires one for
   mic access).
3. Allow the microphone permission prompt.
4. The label changes to **not listening** and the dot is orange: the detector
   is running, hearing silence.
5. Say something, e.g. *"one, two, three"*:
   - after ~288 ms of confirmed speech the dot turns **green** and the label
     reads **listening** (`onSpeechStart`);
   - it stays green through short interior pauses (< 650 ms adaptive window);
   - after you stop and the redemption window elapses, the dot returns
     **orange**, the label reads **not listening**, and a log line appears:
     `turn: 1.4 s` (`onTurnEnd`).
6. Click **Stop microphone** to release the mic. The button toggles between
   start/stop and stays visible.

## 2.5 What you should see (and hear)

A normal utterance produces this event sequence:

| Moment | UI | Underlying event |
|---|---|---|
| You click start | "starting…" → orange dot, "not listening" | `start()` resolves when the first audio frame arrives |
| You begin speaking (after ~0.3 s) | dot turns green, "listening" | `onSpeechStart` (S1) |
| You pause mid-sentence briefly | dot **stays green** | interior pause — turn still open (PAUSE sub-state) |
| You finish speaking (~0.35–1.2 s later, adaptive) | dot orange, "not listening", log line `turn: N s` | `onTurnEnd` (S2) with the turn audio |
| Coughs / clicks < 250 ms | nothing happens | turn discarded silently (`minSpeechMs`) |

With **Smart Turn** enabled (checkbox), the turn-end moment can be slightly
delayed: at the silence point the optional semantic model is asked "is the
utterance complete?" and an *incomplete* verdict keeps the turn open
([Chapter 12](12-smart-turn.md)).

To exercise **barge-in** you need an agent that talks — the demo deliberately
does **not** simulate one. Instead, the **Background sound** row plays ambient
noise that reaches the detector (it is *not* armed as "agent speaking"), which
lets you test noise robustness; see [§3.4](03-demo.md#34-background-sound-row--ambient-noise-on-purpose)
and the `setAgentSpeaking` contract in [Chapter 6](06-agent-integration.md).

## 2.6 Quick troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `insecure-context` error | Page opened via `file://` or a non-localhost host | Serve via `http://localhost:5173` (or https) |
| `mic-denied` | Permission rejected | Allow mic access for the site (browser site settings) and reload |
| `mic-not-found` | No microphone device | Check devices / OS privacy settings |
| `cdn-unavailable` + energy-fallback warning | jsDelivr blocked (offline, VPN, strict CSP) | Allow the CDN, or serve a local mirror from `/vendor/` ([Chapter 11](11-runtime-libraries.md)) |
| Safari hangs on start | AudioWorklet module-load quirk | Wait — the adapter auto-retries with the ScriptProcessor path ([Chapter 10](10-vad-engines.md)); always call `start()` from a click |
| `vad-no-frames` | Engine started but produced no audio | Reload the page |

The full error-code reference and the degradation ladder are in
[Chapter 15](15-troubleshooting.md).

---

*Prev: [Chapter 1 — Introduction](01-introduction.md) · Next: [Chapter 3 — The demo page](03-demo.md)*
