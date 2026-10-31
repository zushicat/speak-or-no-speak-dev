# Appendix A — Glossary

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Chapter 17](17-background.md)

Terms used throughout this documentation, in the sense they are used here.

**AEC (acoustic echo cancellation)** — the browser's removal of audio *it
plays in the same tab* from the microphone signal. Requested via
`getUserMedia({ audio: { echoCancellation: true } })`. Cancels your TTS, not
other apps' audio ([§6.6](06-agent-integration.md#66-echo-cancellation-scope)).

**AGC / NS** — automatic gain control / noise suppression: the two other
standard browser mic-track processors this module enables by default.

**barge-in** — the user starts speaking *while the agent is answering*; the
agent should stop and listen. Detected as S3 while `setAgentSpeaking(true)` is
armed ([Chapter 6](06-agent-integration.md)).

**Bluestein's chirp-z transform** — an FFT algorithm for arbitrary lengths
(400 samples here is not a power of two); used by the pure-JS Whisper feature
extractor ([§12.3](12-smart-turn.md#123-the-feature-pipeline)).

**bundle (ESM / IIFE)** — the prebuilt single-file distributions in `build/`:
`*.esm.js` (module imports) and `*.iife.js` (classic script exposing
`window.SpeakOrNoSpeak`) ([Chapter 16](16-build-test-publish.md)).

**COOP / COEP** — `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
response headers; required for cross-origin isolation, which multi-threaded
WASM (SharedArrayBuffer) needs. Not needed for the tested single-threaded
default ([§8.7](08-architecture.md#87-threading-model)).

**degradation ladder** — the automatic, always-flagged fallback chain:
Silero → energy engine; AEC off → stricter gating; turn-model failure →
fail-open ([§15.1](15-troubleshooting.md#151-the-degradation-ladder)).

**endpointing** — deciding that the user has *finished* their utterance (S2);
the classic hard problem of voice interfaces
([§7.6](07-detection-methods.md#76-turn-endpointing-the-redemption-window)).

**ESM** — ECMAScript Modules (`import`/`export`); the package is ESM-only.

**fail-open** — a component's failure mode where the system keeps working
without it: the Smart Turn model can only *hold* a turn, never lose one
([§12.2](12-smart-turn.md#122-when-it-runs-and-fail-open-semantics)).

**frame** — one chunk of processed audio: 512 samples @ 16 kHz = **32 ms** for
Silero v5; carries `{ probability, frame, rms, durationMs }`
([§7.2](07-detection-methods.md#72-frames-and-speech-probability)).

**getUserMedia** — the browser API that opens the microphone; requires a
secure context (https or localhost).

**hysteresis** — using two thresholds (0.6 onset / 0.35 negative) with a dead
band between them so a noisy signal near the boundary cannot flicker the
state ([§7.3](07-detection-methods.md#73-hysteresis-two-thresholds)).

**IIFE** — immediately invoked function expression; a classic (non-module)
script build that defines a global.

**onset** — the moment speech starts (S1); confirmed by a 288 ms window
([§7.4](07-detection-methods.md#74-onset-confirmation)).

**ONNX / ONNX Runtime Web** — an open model format and Microsoft's browser
inference runtime (WASM); runs the Silero and Smart Turn models here
([Chapter 11](11-runtime-libraries.md)).

**PAUSE sub-state** — the detector state for an interior pause inside an open
turn (silence ≥ 250 ms): the turn is still open, endpointing just gets
patient ([§7.8](07-detection-methods.md#78-interior-pauses)).

**pre-speech pad** — the up-to-200 ms of audio *before* the first confirmed
speech sample, kept in the turn audio from the ring buffer so word onsets are
not clipped ([§7.9](07-detection-methods.md#79-turn-boundaries-and-guards)).

**redemption (window)** — the silence duration that ends a turn; base 650 ms,
adapted per turn to 350–1200 ms from the turn's rhythm stats
([§7.7](07-detection-methods.md#77-adaptive-redemption-redemptionfor)).

**RMS** — root mean square; the per-frame loudness measure (0..1) used for the
level meter, the no-AEC barge-in gate, and the energy engine's probability.

**secure context** — https or `http://localhost`; without it `getUserMedia`
does not exist (`insecure-context`).

**S1 / S2 / S3 / E1** — the project's labels: speech onset, turn end, barge-in,
echo hazard ([§7.1](07-detection-methods.md#71-the-problem-decomposition)).

**ScriptProcessor** — the legacy (deprecated but universal) Web Audio capture
node; the worklet-free fallback path immune to the AudioWorklet load hang
([§10.4](10-vad-engines.md#104-the-audioworklet-hang-and-the-scriptprocessor-fallback)).

**Silero VAD** — the open neural voice-activity detector (v5, ~2 MB, MIT) at
the core of the default engine ([§10.1](10-vad-engines.md#101-silero-vad-v5--why-this-engine)).

**Smart Turn** — Pipecat's open semantic end-of-turn model (Whisper-Tiny
backbone, 8 MB int8 ONNX); optional here ([Chapter 12](12-smart-turn.md)).

**STT (speech-to-text)** — transcription; a plug point, never part of the
real-time loop ([Chapter 13](13-transcription.md)).

**turn** — one user utterance from confirmed onset to redemption-confirmed
end; delivered with its audio at `onTurnEnd`
([§7.12](07-detection-methods.md#712-what-the-turn-audio-contains)).

**turn model (`TurnModel`)** — the plug-point interface
(`predictComplete(turnAudio) → Promise<boolean>`) the Smart Turn model
implements.

**vad-web** — `@ricky0123/vad-web`, the browser wrapper around Silero VAD
(mic capture, resampling, model loading); pinned 0.0.31
([§11.2](11-runtime-libraries.md#112-vad-web--what-it-is-and-what-it-is-for-here)).

**VAD (voice activity detection)** — classifying audio frames as speech vs
non-speech; knows acoustics, not language.

**WASM (WebAssembly)** — the portable binary instruction format the ONNX
runtime and models run on in the browser.

**WP0–WP9** — the work packages of the initial implementation plan
([§17.4](17-background.md#174-work-packages-wp0wp9)).

**zero-build** — the source layout: no bundler, no TS compile; plain ES
modules from a static server with CDN-pinned runtime libraries
([§9.1](09-source-files.md#91-repository-layout-and-the-zero-build-philosophy)).

---

*Prev: [Chapter 17 — Background & decisions](17-background.md) · Back to the [documentation index](README.md)*
