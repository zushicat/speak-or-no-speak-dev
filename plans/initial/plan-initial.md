# Implementation Plan: Speak Or No Speak — Solution F

- **Date:** 2026-10-20 · **Rev:** 2 (decisions D1–D4 applied)
- **Status:** Ready to execute
- **Inputs:** [initial-2.md](initial-2.md) · Analysis: [problem-analysis-initial.md](problem-analysis-initial.md)
- **Detailed per-WP plans:** [plans/initial/work-packages/](work-packages/) — one file per WP, referenced in §5

---

## 0. Resolved decisions

| # | Decision | Resolution |
|---|---|---|
| D1 | Build setup | **Zero-build CDN `index.html`** — no bundler, no TS compile; plain JS ESM + JSDoc types; deps via pinned CDN `<script>` tags; static server for localhost (secure context); unit tests via `node --test` (zero test deps) |
| D2 | Indicator semantics | **Green = "speech detected"**, orange = "not listening" |
| D3 | WP8 (Smart Turn) scope | **Decide after M3** — WP8 is on hold behind an explicit go/no-go gate (§6) |
| D4 | Package name | **`speak-or-no-speak`** (npm name; also the repo/product name) |

## 1. Objective & scope

Build an embeddable TypeScript-free JavaScript module that, from a single microphone stream with browser echo cancellation:

1. **S1** emits `onSpeechStart` when the user starts speaking (~≤ 300 ms),
2. **S2** emits `onTurnEnd(audio)` when the utterance is complete (adaptive silence window, optional end-of-turn model behind a gate),
3. **S3** emits `onInterrupt` when the user speaks while the app is "answering" (~150–250 ms),
4. survives echo (E1) via browser AEC + confirmation windows, and degrades gracefully.

**Required test page (initial-2.md):** a super-simple `index.html` showing **"listening" (green) / "not listening" (orange)** — delivered early as WP2 and used as the verification surface for all later WPs.

**Out of scope (v1):** transcription/STT logic (only the plug point, WP9), speaker diarization, "is this speech directed at me?", mobile-native builds.

## 2. Target architecture

```
mic ─ getUserMedia({ echoCancellation, noiseSuppression, autoGainControl })
  │
  ├─ AudioContext @16 kHz ─ frame pump ── Float32 frames (1536 samples ≈ 96 ms)
  │                                          │
  │                                          ▼
  │                    VAD engine (Silero v5 via vad-web / ONNX Runtime Web, CDN)
  │                                          │  speech probability per frame
  │                                          ▼
  │                            TurnDetector state machine (pure logic)
  │      READY ─onset→ LISTENING ⇄ PAUSE ─silence→ turn end ─→ agent flag ⇄ interrupt
  │                                          │
  ▼                                          ▼
onSpeechStart / onTurnEnd(audio) / onInterrupt / onLevel / onError
```

Layering (each layer replaceable):

| Layer | Responsibility | v1 implementation | Later swap-in |
|---|---|---|---|
| `AudioSource` | mic access, AEC constraints, 16 kHz frames | delegated to vad-web `MicVAD` internals | worker recipe (WP7 contingency) |
| `VadEngine` | frame-level speech probability | `SileroVadAdapter` (CDN-global or npm-imported — dual mode) | `EnergyVad` fallback (WP7) |
| `TurnDetector` | onset/turn-end/barge-in state machine | own code (WP3–WP5) | — |
| `TurnModel` (optional) | semantic "sentence complete?" check | none (gated, WP8) | Smart Turn v3 ONNX int8 |
| `SpeakOrNoSpeak` | public facade: events, options, `setAgentSpeaking()`, degradation flags | WP3 | — |

### File tree (zero-build)

```
speak-or-no-speak/
├── index.html                     # demo: green/orange indicator (WP2)
├── demo/
│   └── main.js                    # demo wiring — UI mapping only, no detection logic
├── src/
│   ├── index.js                   # public exports
│   ├── speak-or-no-speak.js       # facade
│   ├── types.js                   # JSDoc typedefs (the "typed contract", no TS compile)
│   ├── config.js                  # defaults + merge helper
│   ├── errors.js                  # error taxonomy (WP7)
│   ├── vad/
│   │   ├── vad-engine.js          # interface
│   │   ├── silero-vad-adapter.js  # dual-mode wrapper (WP1)
│   │   └── energy-vad.js          # fallback (WP7)
│   ├── turn/
│   │   ├── turn-detector.js       # state machine (WP3–5)
│   │   └── ring-buffer.js         # pre-speech pad (WP3/4)
│   ├── turn-model/                # optional (WP8)
│   └── stt/                       # optional plug point (WP9)
├── test/
│   ├── unit/                      # node --test suite (WP3+)
│   ├── util/wav-export.js         # zero-dep WAV encoder (WP4)
│   └── harness.html + harness-main.js  # calibration harness (WP6)
├── vendor/                        # optional local CDN mirror (gitignored)
├── package.json  .gitignore  README.md
└── plans/
```

## 3. Technology decisions (updated for D1)

| # | Decision | Choice | Rationale | Alternative |
|---|---|---|---|---|
| T1 | VAD model | Silero VAD v5 via [`@ricky0123/vad-web`](https://github.com/ricky0123/vad) pinned `0.0.31` (MIT) | Industry standard, ~2 MB, < 1 ms/frame, noise-robust, exposes frame probabilities | Custom ONNX integration (defer) |
| T2 | Inference runtime | ONNX Runtime Web, pinned `1.22.0`, WASM SIMD, via CDN | Local, offline-after-load, no keys | WebGPU EP (optional later) |
| T3 | Language | **Plain JavaScript ESM + JSDoc `@typedef` types** (D1 consequence) | Zero toolchain; `node --test` runs the pure logic directly; typed contract preserved via JSDoc | TypeScript + build step (rejected by D1) |
| T4 | Build/dev | **Zero-build**: pinned CDN `<script>` tags (`ort.wasm.min.js`, `vad-web` bundle) + our ES modules via `<script type="module">`; serve with `python3 -m http.server 5173` (or `npx serve`) | No toolchain, instant onboarding, mic needs a secure context only | Vite+TS (rejected by D1) |
| T5 | State machine | Hand-rolled, explicit transitions, pure + unit-tested | ~100 lines, fully testable, no deps | XState (overkill) |
| T6 | End-of-turn model | None in v1; Smart Turn behind the D3 gate (WP8) | Baseline must exist and be measured first | [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn) v3.2 int8 |
| T7 | Packaging | npm package **`speak-or-no-speak`** (D4), plain ESM, `files: src/demo/test`, **dual-mode adapter**: `window.vad` (CDN) → dynamic `import('@ricky0123/vad-web')` (bundler users) → energy fallback | Works zero-build *and* in bundler apps | — |

## 4. Module design (the contract)

### 4.1 Public API

Expressed as JSDoc `@typedef`s in `src/types.js` (sketch in TS notation for readability):

```ts
interface SpeakOrNoSpeakOptions {
  mic?: MediaTrackConstraints;        // defaults: echoCancellation/noiseSuppression/autoGainControl = true
  thresholds?: Partial<Thresholds>;   // §4.3
  turnModel?: TurnModel;              // optional (WP8 gate)
  debug?: boolean;                    // transition traces
  onSpeechStart?: () => void;
  onTurnEnd?: (e: { audio: Float32Array; durationMs: number; truncated: boolean; afterInterrupt: boolean }) => void;
  onInterrupt?: (info: { atMs: number }) => void;
  onLevel?: (rms: number) => void;
  onError?: (e: { code: ErrorCode; message: string }) => void;
}

interface SpeakOrNoSpeak {
  start(): Promise<void>;
  stop(): void;
  setAgentSpeaking(active: boolean): void;   // arms/disarms barge-in (S3)
  readonly state: "idle" | "ready" | "listening";
  readonly degraded: { aec: boolean; engine: "silero" | "energy" };
}
```

### 4.2 State machine

States `READY` / `LISTENING` (+ `PAUSE` sub-state from WP4) × boolean `agentSpeaking` flag. Full transition tables, pseudocode, and the agent-flag contract are specified in [WP3](work-packages/wp3-facade-and-state-machine.md) (extended by [WP4](work-packages/wp4-endpointing-and-buffering.md)).

Summary (WP3 + WP4):

| agentSpeaking | silence | speech |
|---|---|---|
| `false` | READY: confirm frames → `onSpeechStart`; LISTENING: silence ≥ `shortPauseMs` → **PAUSE**; silence ≥ redemption (adaptive, WP4) → `onTurnEnd`; PAUSE: speech → LISTENING (turn continues) | confirm / resume / accumulate |
| `true` | stay; **no turn ends** | confirm → **`onInterrupt`** → LISTENING (accumulation continues) |

### 4.3 Starting thresholds (tuned in WP6)

| Parameter | Start | Purpose |
|---|---|---|
| `onsetConfirmFrames` | 3 (~288 ms @96 ms frames) | reject clicks/noise — **WP3: 9 @32 ms v5 frames (same 288 ms; WP1 D-WP1-1)** |
| `negativeSpeechThreshold` | 0.35 | hysteresis floor |
| `onsetSpeechThreshold` | 0.6 | frame "is speech" level |
| `redemptionMs` | 650 (adaptive ±200 from WP4) | S2 baseline |
| `minSpeechMs` | 250 | ignore coughs — **WP3 D-WP3-1: confirm-window speech counts toward it** |
| `preSpeechPadMs` | 200 | don't clip onsets — **WP3 D-WP3-3: ring also holds the confirm window** |
| `bargeInConfirmFrames` | 2 (~150–190 ms) | E1 protection — **WP3: 6 @32 ms (≈192 ms)** |
| `maxTurnMs` | 30000 | force-end + `truncated` flag |

## 5. Work packages (details in [work-packages/](work-packages/))

| WP | Title | Phase | Est. | Detailed plan |
|---|---|---|---|---|
| WP0 | Project scaffolding (zero-build, static server, skeleton) | M1 | 0.5 d | [wp0-scaffolding.md](work-packages/wp0-scaffolding.md) |
| WP1 | VAD engine integration (Silero via CDN, `VadEngine` interface, AEC constraints, perf probe) | M1 | 0.5–1 d | [wp1-vad-engine-integration.md](work-packages/wp1-vad-engine-integration.md) |
| WP2 | **Demo `index.html`** — green/orange listening indicator (D2) | M1 | 0.5 d | [wp2-demo-indicator-page.md](work-packages/wp2-demo-indicator-page.md) |
| WP3 | Facade + state machine (+ `node --test` suite t01–t10) | M2 | 1 d | [wp3-facade-and-state-machine.md](work-packages/wp3-facade-and-state-machine.md) |
| WP4 | Endpointing refinement (PAUSE sub-state, adaptive redemption, WAV export, truncation) | M2 | 1 d | [wp4-endpointing-and-buffering.md](work-packages/wp4-endpointing-and-buffering.md) |
| WP5 | Barge-in + echo safety (TTS simulation, latency measurement, loopback matrix, no-AEC fallback) | M3 | 1–1.5 d | [wp5-barge-in-and-echo.md](work-packages/wp5-barge-in-and-echo.md) |
| WP6 | Calibration & test harness (10 scenarios, replay, metrics, tuned config) | M3 | 1 d | [wp6-calibration-harness.md](work-packages/wp6-calibration-harness.md) |
| WP7 | Hardening & packaging (energy fallback, error taxonomy, Safari pass, npm `speak-or-no-speak`, dual-mode adapter) | M4 | 1 d | [wp7-hardening-and-packaging.md](work-packages/wp7-hardening-and-packaging.md) |
| WP8 | Smart Turn experiment — **✅ done: ADOPTED as optional module behind `turnModel`** (see [wp8-decision.md](wp8-decision.md)) | M5 | 2–3 d | [wp8-smart-turn-experiment.md](work-packages/wp8-smart-turn-experiment.md) |
| WP9 | STT plug point (optional; adapter interface + example) | M6 | 0.5–1 d | [wp9-stt-plug-point.md](work-packages/wp9-stt-plug-point.md) |

Each WP file contains: objective, prerequisites, step-by-step tasks with code sketches, acceptance checklists, manual test protocols (with result-fill sections), risks, and deliverables.

## 6. Sequencing & milestones

| Milestone | Contents | Estimate | Demo value after |
|---|---|---|---|
| **M1 — "See it work"** | WP0 → WP1 → WP2 | ~1.5–2 d | green/orange listening indicator live on `http://localhost:5173` |
| **M2 — Real module** | WP3 → WP4 | ~2 d | typed API (JSDoc), clean turn-end audio, pause handling |
| **M3 — Full-duplex** | WP5 → WP6 | ~2.5 d | barge-in over TTS + data-tuned thresholds |
| **Gate: D3 decision** | review WP6 premature-turn-end data → go/no-go on WP8 | — | documented in `plans/initial/wp8-decision.md` |
| **M4 — Embeddable** | WP7 | ~1 d | hardened, packaged `speak-or-no-speak@0.1.0`, documented |
| M5 (opt) | WP8 (if green-lit) | ~2–3 d | semantic turn-end decision |
| M6 (opt) | WP9 | ~0.5–1 d | STT plug point |

**Core (M1–M4): ≈ 6–7.5 working days.** WP2 lands on day 1–2 so the requested test page exists from the start and every later WP is verified on it.

## 7. Test strategy (summary)

- **Unit:** state machine from synthetic probability sequences via `node --test` (WP3: t01–t10; WP4 adds ≥ 8; WP7 adds fallback tests) — no test framework, zero deps (D1).
- **Integration/manual:** WP2 demo checklist re-run after every WP; echo loopback matrix (WP5).
- **Calibration:** WP6 harness — 10 recorded scenarios with ground-truth marks, offline replay through the pure detector, p50/p95 metrics.
- **Success bars:** onset p95 ≤ 300 ms · interrupt p50 ≤ 250 ms · premature turn-ends < 5 % · false onsets ≤ 1/min in noise scenarios · **zero** echo false-interrupts in 60 s TTS playback with AEC.

## 8. Risks

| Risk | Response in plan |
|---|---|
| AEC quality varies (Safari, loud speakers) | WP5 loopback matrix + no-AEC fallback gating + `degraded.aec` flag |
| CDN unavailable (network policy, offline first-load) | WP1 vendor mirror recipe (`/vendor/`), `cdn-unavailable` error code, energy fallback (WP7) |
| vad-web option/version drift (`stream`, `frameSamples`, frame param in `onFrameProcessed`) | WP1 verification step + documented fallbacks; versions pinned (T1/T2) |
| ORT/SharedArrayBuffer header requirements | Single-threaded WASM default (budget < 8 ms/frame); worker recipe as contingency (WP7) |
| Adaptive endpointing over/under-shoots | WP4 unit-tested rules → WP6 data-driven tuning before freeze |
| Smart Turn browser port unknown | Isolated WP8 behind the D3 gate with 2 h spike timebox + explicit go criteria |
| Barge-in thrash (TV/other speakers) | Confirm windows + post-interrupt grace; semantic filtering out of scope v1 |

## 9. References

- vad-web docs & options — https://docs.vad.ricky0123.com · https://github.com/ricky0123/vad
- Silero VAD — https://github.com/snakers4/silero-vad
- Smart Turn v3.2 — https://github.com/pipecat-ai/smart-turn · weights https://huggingface.co/pipecat-ai/smart-turn-v3
- ONNX Runtime Web — https://onnxruntime.ai/docs/tutorials/web/
- MDN `SpeechRecognition` (WP9 context; not Baseline) — https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- Analysis with rationale & ratings — [problem-analysis-initial.md](problem-analysis-initial.md) · Request — [initial-2.md](initial-2.md)
