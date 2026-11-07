# Glossary

> Part of the [Speak Or No Speak documentation](README.md) · prev: [Design background](15-design-background.md)

Terms used throughout this documentation, in the sense they are used here.

**AEC (acoustic echo cancellation)** — the browser's removal of audio *it can
reference* from the microphone signal. Requested via
`getUserMedia({ audio: { echoCancellation: … } })`. What is referenceable is
per-browser: `RTCPeerConnection` audio always; same-page playback only with
the `"all"` scope + OS permission (Chromium), via the
[agent-audio route](06-agent-integration.md#echo-cancellation-scope--the-reference-signal-rule),
or through Safari's system AEC by default; **never other apps' audio unless
OS-level AEC is enabled**. The module reports the honest verdict as
`degraded.aecScope` (`"all" | "remote-only" | "unknown" | "none"`).

**AGC / NS** — automatic gain control / noise suppression: the two other
standard browser mic-track processors this module enables by default.

**agent-audio route** — `createAgentAudioRoute()`: plays the app's agent voice
through a local WebRTC loopback so the browser's echo cancellation references
it as "remote participant" audio
([API reference](05-api-reference.md#createagentaudiorouteoptions)).

**barge-in** — the user starts speaking *while the agent is answering*; the
agent should stop and listen. Detected while `setAgentSpeaking(true)` is armed
([Agent integration](06-agent-integration.md)).

**Bluestein's chirp-z transform** — an FFT algorithm for arbitrary lengths
(400 samples here is not a power of two); used by the pure-JS Whisper feature
extractor ([Smart Turn](10-smart-turn.md#the-feature-pipeline-for-the-curious)).

**bundle (ESM / IIFE)** — the prebuilt single-file distributions in `build/`:
`*.esm.js` (module imports) and `*.iife.js` (classic script exposing
`window.SpeakOrNoSpeak`) ([Development](14-development.md)).

**COOP / COEP** — `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`
response headers; required for cross-origin isolation, which multi-threaded
WASM (SharedArrayBuffer) needs. Not needed for the tested single-threaded
default ([Architecture](08-architecture.md#threading-model)).

**degradation ladder** — the automatic, always-flagged fallback chain:
Silero → energy engine; AEC off → stricter gating; turn-model failure →
fail-open ([Troubleshooting](13-troubleshooting.md#the-degradation-ladder)).

**echo gate** — optional correlation-based echo classification: a mic frame
that strongly matches recent agent-reference audio is treated as echo
regardless of loudness ([Tuning](12-tuning.md#every-threshold-explained)).

**endpointing** — deciding that the user has *finished* their utterance; the
classic hard problem of voice interfaces
([How detection works](07-how-detection-works.md#turn-endpointing-the-redemption-window)).

**ESM** — ECMAScript Modules (`import`/`export`); the package is ESM-only.

**fail-open** — a component's failure mode where the system keeps working
without it: the Smart Turn model can only *hold* a turn, never lose one
([Smart Turn](10-smart-turn.md#when-it-runs-and-fail-open-semantics)).

**frame** — one chunk of processed audio: 512 samples @ 16 kHz = **32 ms** for
Silero v5; carries `{ probability, frame, rms, durationMs }`
([How detection works](07-how-detection-works.md#frames-and-speech-probability)).

**getUserMedia** — the browser API that opens the microphone; requires a
secure context (https or localhost).

**hysteresis** — using two thresholds (0.6 onset / 0.35 negative) with a dead
band between them so a noisy signal near the boundary cannot flicker the
state ([How detection works](07-how-detection-works.md#hysteresis-two-thresholds)).

**IIFE** — immediately invoked function expression; a classic (non-module)
script build that defines a global.

**onset** — the moment speech starts; confirmed by a 288 ms window
([How detection works](07-how-detection-works.md#onset-confirmation)).

**ONNX / ONNX Runtime Web** — an open model format and Microsoft's browser
inference runtime (WASM); runs the Silero and Smart Turn models here
([Engines and runtime libraries](09-engines-and-libraries.md)).

**PAUSE sub-state** — the detector state for an interior pause inside an open
turn (silence ≥ 250 ms): the turn is still open, endpointing just gets
patient ([How detection works](07-how-detection-works.md#interior-pauses)).

**pre-speech pad** — the up-to-200 ms of audio *before* the first confirmed
speech sample, kept in the turn audio from the ring buffer so word onsets are
not clipped ([How detection works](07-how-detection-works.md#turn-boundaries-and-guards)).

**redemption (window)** — the silence duration that ends a turn; base 650 ms,
adapted per turn to 350–1200 ms from the turn's rhythm stats
([How detection works](07-how-detection-works.md#adaptive-redemption-redemptionfor)).

**RMS** — root mean square; the per-frame loudness measure (0..1) used for the
level meter, the no-AEC barge-in gate, and the energy engine's probability.

**secure context** — https or `http://localhost`; without it `getUserMedia`
does not exist (`insecure-context`).

**ScriptProcessor** — the legacy (deprecated but universal) Web Audio capture
node; the worklet-free fallback path immune to the AudioWorklet load hang
([Engines and runtime libraries](09-engines-and-libraries.md#the-audioworklet-hang-and-the-scriptprocessor-fallback)).

**Silero VAD** — the open neural voice-activity detector (v5, ~2 MB, MIT) at
the core of the default engine
([Engines and runtime libraries](09-engines-and-libraries.md#silero-vad-v5--why-this-engine)).

**Smart Turn** — Pipecat's open semantic end-of-turn model (Whisper-Tiny
backbone, 8 MB int8 ONNX); optional here ([Smart Turn](10-smart-turn.md)).

**STT (speech-to-text)** — transcription; a plug point, never part of the
real-time loop ([Transcription](11-transcription.md)).

**turn** — one user utterance from confirmed onset to redemption-confirmed
end; delivered with its audio at `onTurnEnd`
([How detection works](07-how-detection-works.md#what-the-turn-audio-contains)).

**turn model (`TurnModel`)** — the plug-point interface
(`predictComplete(turnAudio) → Promise<boolean>`) the Smart Turn model
implements.

**voice gate** — optional speaker-identity suppression: completed turns are
embedded and compared against a profile of the agent's own voice; agent-like
turns are dropped ([API reference](05-api-reference.md#agentvoicegate--the-agent-voice-profile-gate)).

**vad-web** — `@ricky0123/vad-web`, the browser wrapper around Silero VAD
(mic capture, resampling, model loading); pinned 0.0.31
([Engines and runtime libraries](09-engines-and-libraries.md#vad-webs-role-and-the-adapters-dual-mode-resolution)).

**VAD (voice activity detection)** — classifying audio frames as speech vs
non-speech; knows acoustics, not language.

**WASM (WebAssembly)** — the portable binary instruction format the ONNX
runtime and models run on in the browser.

**zero-build** — the source layout: no bundler, no TS compile; plain ES
modules from a static server with CDN-pinned runtime libraries
([Development](14-development.md#repository-layout) ·
[Use it in your own app](04-use-in-your-app.md)).

---

*Prev: [Design background](15-design-background.md) · Back to the [documentation index](README.md)*
