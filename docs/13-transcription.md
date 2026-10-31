# Chapter 13 — Transcription plug point (STT)

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 12](12-smart-turn.md) · next: [Chapter 14 — Configuration & tuning](14-configuration-tuning.md)

Speak Or No Speak ships **no** STT engine. It ships a **plug point** — and one
hard rule about where transcription belongs.

## 13.1 The hard rule: STT outside the real-time loop

**STT lives strictly outside the real-time loop.** Concretely:

- Adapters are called **only** with `onTurnEnd` audio (16 kHz mono, including
  the pre-speech pad) — **never** with live frames.
- The **module itself never calls an adapter**. The wiring belongs to the
  embedding app (the demo shows the pattern).
- **An adapter failure must never affect detection**: `onSpeechStart` /
  `onTurnEnd` / `onInterrupt` keep flowing no matter what your transcription
  does. Wrap your calls at *your* level.

Why: STT is slow (hundreds of ms at best) and can fail in a dozen ways; the
detection loop is 32 ms frames and must never wait on it. This separation is
also what made the "lightweight" goal achievable — the method analysis
explicitly rejected local streaming STT as the detection backbone
([§17.2](17-background.md#172-the-candidate-solutions-ah-and-their-scores)).

## 13.2 The `SttAdapter` interface

[`src/stt/stt-adapter.js`](../src/stt/stt-adapter.js):

```ts
interface SttAdapter {
  transcribe(
    audio: Float32Array,          // 16 kHz mono PCM — the onTurnEnd audio, incl. pre-speech pad
    opts?: { language?: string }  // e.g. "en-US", passed through to the backend
  ): Promise<{ text: string; confidence?: number }>;
}
```

`confidence` is optional (0..1) — include it if your backend provides one; the
demo prints it as a percentage.

## 13.3 `CloudStubAdapter` — the shipped example

[`src/stt/cloud-stub-adapter.js`](../src/stt/cloud-stub-adapter.js) is a
~50-line **dev example** implementing the interface:

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

Behavior:

- POSTs the turn audio as a **16-bit PCM WAV body** (built with the module's
  own `encodeWav` — Blob in the browser, Buffer in Node).
- Headers: `Content-Type: audio/wav`, optional
  `Authorization: Bearer <token>`, optional `X-Language: <language>`.
- Expects `{ "text": string, "confidence"?: number }` JSON back; non-2xx
  throws `STT endpoint responded <status>`.
- The demo wires it against the local stub server
  ([§3.7](03-demo.md#37-the-python-script-what-it-does-and-what-it-does-not-do)).

⚠️ **Dev example — add auth for production.** Never hardcode API keys in app
code; pass `endpoint` + `token` from your configuration, or keep credentials
out of the browser entirely with a server-side proxy.

## 13.4 The Web Speech API alternative

A **zero-backend option**: the browser's built-in `SpeechRecognition` can run
in parallel with listening, and your app harvests the final result whose
timing matches the turn window.

| | |
|---|---|
| ✓ Zero audio plumbing — no adapter, no backend of your own | ✗ Chromium-only; **not Baseline** per MDN (no Firefox, uneven elsewhere) |
| ✓ Text comes for free, interim results included | ✗ Server-backed in Chrome — **audio leaves the machine**; no SLA, no offline (privacy caveat) |
| ✓ Good prototyping shortcut | ✗ The engine owns segmentation (`onend` at unpredictable times, self-restarting loops) — poor match as a *detection* backbone |

Note the boundary: this is fine as an opportunistic **content** source, but it
must not replace the module's detection — the method analysis rated the Web
Speech API lowest as a detection backbone precisely because of the
segmentation and echo behavior ([§17.2](17-background.md#172-the-candidate-solutions-ah-and-their-scores)).

## 13.5 Writing your own adapter

Implement the interface for any backend — a Whisper server, a managed STT API,
an edge model:

```js
class MyStt {
  constructor({ endpoint, token }) { /* store config */ }
  async transcribe(audio, { language } = {}) {
    const wav = encodeWavBytes(audio, 16000);        // helper from the module
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "audio/wav", "Authorization": `Bearer ${token}` },
      body: wav,
    });
    if (!res.ok) throw new Error(`STT responded ${res.status}`);
    const { text, confidence } = await res.json();
    return { text, confidence };
  }
}
```

Checklist:

- Handle the `Float32Array` → your backend's format yourself (`encodeWav` /
  `encodeWavBytes` exist for this).
- Pass `language` through if your backend supports it.
- **Throw on failure** — but throw *inside* the adapter; the caller's `.catch`
  is what keeps detection unaffected (the demo pattern).
- Keep latency off the real-time path: nothing in the module awaits your
  adapter, and nothing should.

## 13.6 Privacy and security notes

- **The module sends nothing anywhere.** All detection is on-device; audio
  leaves the machine only if *your* adapter (or the Web Speech API) does that.
- **Credentials**: never hardcode tokens in client code; prefer a server-side
  proxy that keeps keys out of the browser.
- **Tell users where audio goes** when you wire a cloud adapter — that is your
  app's privacy statement, not the module's.
- The demo's stub server uses wide-open CORS and no auth: correct for a
  localhost dev fixture, wrong for anything reachable from a network.

---

*Prev: [Chapter 12 — Smart Turn](12-smart-turn.md) · Next: [Chapter 14 — Configuration & tuning](14-configuration-tuning.md)*
