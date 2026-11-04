# Speak Or No Speak — Documentation

**Speak Or No Speak** is a browser JavaScript module that detects from a microphone stream when the user **starts speaking** , **finishes a turn**, and **barges in while the agent is answering** — built on Silero VAD + adaptive endpointing + browser echo cancellation. 
---

## How to read the documentation

| You want to … | Read |
|---|---|
| Understand what this is (and is not) | [1 Introduction](01-introduction.md) |
| Run the demo right now | [2 Getting started](02-getting-started.md) → [3 The demo page](03-demo.md) |
| Put the module into your own app | [4 Embedding](04-embedding.md) → [5 API reference](05-api-reference.md) |
| Build a voice agent (TTS + barge-in) | [6 Agent integration](06-agent-integration.md) |
| Understand how detection works under the hood | [7 Detection methods](07-detection-methods.md) → [8 Architecture](08-architecture.md) → [10 VAD engines](10-vad-engines.md) |
| Know why two CDN libraries are loaded separately | [11 Runtime libraries](11-runtime-libraries.md) |
| Tune thresholds or debug behavior | [14 Configuration & tuning](14-configuration-tuning.md) → [15 Troubleshooting](15-troubleshooting.md) |
| Work on the source code | [9 Source file guide](09-source-files.md) → [16 Build, test & publish](16-build-test-publish.md) |
| Learn why it was designed this way | [17 Background & decisions](17-background.md) |

## Table of contents

### Basics

1. **[Introduction](01-introduction.md)** — what it is · what it does (S1/S2/S3/E1) · what it is NOT · design goals · where it fits in a voice-agent stack · status & license
2. **[Getting started](02-getting-started.md)** — requirements · starting the HTTP server · the optional Python STT stub · first-run walkthrough · what you should see · quick troubleshooting
3. **[The demo page](03-demo.md)** — page anatomy · listening indicator · mic toggle · background sounds · Smart Turn checkbox · transcription row & log · the Python script: what it does and does NOT do · `?noaec=1` · suggested experiments
4. **[Embedding the module in your own app](04-embedding.md)** — four integration modes · zero-build page · ESM bundle · IIFE bundle · npm/bundler · using the bundle inside Vite/webpack/esbuild · serving requirements · choosing a mode

### Reference

5. **[API reference](05-api-reference.md)** — `createSpeakOrNoSpeak` · options · thresholds · facade members · events & payloads · error codes · all 16 exports · debug handles
6. **[Agent integration: barge-in & echo](06-agent-integration.md)** — the echo hazard · `setAgentSpeaking` contract · behavior while armed · the interrupt event · post-interrupt contract · AEC scope per browser · the agent-audio route · OS-level AEC · no-AEC gating · a complete agent loop · pitfalls

### Architecture and methods

7. **[How detection works: the methods](07-detection-methods.md)** — problem decomposition · frames & probability · hysteresis · onset confirmation · the state machine · redemption · adaptive redemption · interior pauses · turn guards · barge-in confirm & grace · worked examples · turn audio
8. **[Architecture](08-architecture.md)** — component map (archify webapp + screenshot) · data flow · engine abstraction · facade wiring · the pure state machine · audio capture pipeline · threading model · design decisions
9. **[Source file guide](09-source-files.md)** — layout & zero-build philosophy · what every file in `src/` (and `demo/`) does and does not do
10. **[The VAD engines](10-vad-engines.md)** — why Silero · vad-web's role & dual-mode resolution · runtime-verified findings · AudioWorklet hang & ScriptProcessor fallback · the energy fallback & its probability model · custom engines
11. **[Runtime libraries](11-runtime-libraries.md)** — onnxruntime-web & vad-web: what they are for · **why neither is in the bundle** · what the browser fetches at runtime · offline & blocked-CDN operation · upgrading the pins
12. **[Smart Turn: the optional end-of-turn model](12-smart-turn.md)** — what it is & where it comes from · when it runs & fail-open semantics · the Whisper feature pipeline · setup · measured performance · when to use it
13. **[Transcription plug point (STT)](13-transcription.md)** — the hard rule · `SttAdapter` · `CloudStubAdapter` · Web Speech alternative · writing your own adapter · privacy & security

### Operating the module

14. **[Configuration & tuning](14-configuration-tuning.md)** — option merging · every threshold explained · the 32 ms recalibration story · tuning recipes · surfacing degraded flags · debug traces
15. **[Degradation & troubleshooting](15-troubleshooting.md)** — the degradation ladder · error codes · symptom → fix table · browser quirks · known limitations
16. **[Build, test & publish](16-build-test-publish.md)** — bundle artifacts · the build script & its guards · rebuilding & verification · unit tests · replay harness & calibration recordings · publishing
17. **[Background & decision history](17-background.md)** — the problem analysis · candidate solutions A–H · why the hybrid won · work packages WP0–WP9 · revision history · references

### Appendix

- **[Appendix A — Glossary](appendix-a-glossary.md)** — the vocabulary used throughout
- **[Appendix B — Initial Problem Analysis](appendix-b-problem-analysis-initial.md)** — Initial analysis of what a VAD entails


