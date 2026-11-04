/**
 * The typed contract — JSDoc `@typedef`s only, no TS compile (D1).
 *
 * This file is the source of truth for the public API surface. Editors with
 * TS language support resolve these types in plain JS consumers.
 *
 * @module types
 */

/**
 * One processed audio frame delivered by a {@link VadEngine}.
 * (Mirrors the definition in vad/vad-engine.js; re-declared here so the
 * public contract is self-contained.)
 *
 * @typedef {Object} VadFrame
 * @property {number} probability    P(speech) for this frame, 0..1
 * @property {Float32Array|null} frame  raw 16 kHz mono samples of this frame
 * @property {number} rms            loudness 0..1 of the frame
 * @property {number} durationMs     frame duration in real audio time
 *                                   (Silero v5: 512 samples = 32 ms)
 */

/**
 * Emitted when a complete user utterance ends (S2).
 *
 * @typedef {Object} TurnEndEvent
 * @property {Float32Array} audio      16 kHz mono, includes pre-speech pad
 * @property {number} durationMs       speech + pad duration (audio length)
 * @property {boolean} truncated       true if maxTurnMs force-ended the turn
 * @property {boolean} afterInterrupt  true if this turn started with a barge-in
 * @property {{speechMs: number, interiorPauses: number, longestPauseMs: number,
 *             turnMs: number}} stats  turn rhythm stats (WP4; WP6 tuning input)
 */

/**
 * Emitted when the user barges in while the agent is speaking (S3).
 *
 * @typedef {Object} InterruptInfo
 * @property {number} atMs             ms since agent-speaking mode was armed
 * @property {number} latencyMs        t_voice → t_event: confirm-window duration
 *                                     actually waited (WP5 §5.2; ≈ bargeInConfirmFrames × frameMs,
 *                                     larger in noAecMode)
 */

/**
 * Emitted for engine-level problems. Codes (final taxonomy lands in WP7):
 * `cdn-unavailable`, `mic-denied`, `mic-not-found`, `insecure-context`,
 * `vad-init-failed`, `vad-no-frames`, `no-aec`, `aec-scope-limited`,
 * `aec-scope-fallback` (warnings — the engine keeps running).
 *
 * @typedef {Object} EngineError
 * @property {string} code
 * @property {string} message
 */

/**
 * Honest AEC scope label (WP-E1 D2/D3, from `src/vad/aec-scope.js`):
 * what the browser actually cancels, as far as a page can verify.
 * `"all"` = system-wide capture applied · `"remote-only"` = WebRTC remote
 * audio only · `"unknown"` = browser-decided `true`, unverifiable from JS
 * (the leaking Chromium default) · `"none"` = no usable cancellation.
 *
 * @typedef {"all"|"remote-only"|"unknown"|"none"} AecScope
 */

/**
 * Facade lifecycle state. "agentSpeaking" is a *flag* (setAgentSpeaking),
 * not a state — see the behavior matrix in the master plan §4.2. The
 * detector's WP4 "pause" sub-state maps to "listening" here (the turn is
 * still open).
 *
 * @typedef {"idle"|"ready"|"listening"} ModuleState
 */

/**
 * Detection thresholds. Defaults in src/config.js; see master plan §4.3.
 * Frame-count values are calibrated for Silero v5's 32 ms frames
 * (WP1 D-WP1-1: the plan's 96 ms figures map to the same wall-clock windows).
 *
 * @typedef {Object} Thresholds
 * @property {number} onsetSpeechThreshold     0.6  — frame "is speech" level
 * @property {number} negativeSpeechThreshold  0.35 — hysteresis floor
 * @property {number} onsetConfirmFrames       9    — ×32 ms = 288 ms confirm window
 * @property {number} minSpeechMs              250  — discard coughs/clicks
 * @property {number} redemptionMs             650  — BASE silence that ends a turn
 *                                                   (adaptive via redemptionFor, WP4; clamp 350–1200)
 * @property {number} shortPauseMs             250  — silence that opens the PAUSE sub-state (WP4)
 * @property {number} preSpeechPadMs           200  — audio before onset kept in turn audio
 * @property {number} bargeInConfirmFrames     6    — ×32 ms ≈ 192 ms confirm (E1 protection)
 * @property {number} maxTurnMs                30000 — force-end + truncated flag
 * @property {number} graceAfterInterruptMs    500  — post-interrupt silence ignored (rule 4)
 * @property {number} noAecBargeInConfirmMs    300  — stricter barge-in confirm window without AEC (WP5 §5.4)
 * @property {number} noAecRmsFactor           2    — frame rms must exceed this × rolling agent-playback
 *                                                   mean rms to count as speech without AEC (WP5 §5.4)
 * @property {number} modelTimeoutMs           300  — max wait for the semantic turn model before
 *                                                   failing open (WP8 §8.3)
 */

/**
 * Optional semantic end-of-turn model (WP8) — implement and pass via
 * `options.turnModel`. Called ONLY at silence points; a rejection or timeout
 * fails open (the turn end emits anyway).
 *
 * @typedef {Object} TurnModel
 * @property {(turnAudio: Float32Array) => Promise<boolean>} predictComplete
 *   true = the utterance is semantically complete
 */

/**
 * @typedef {Object} SpeakOrNoSpeakOptions
 * @property {MediaTrackConstraints} [mic]              mic constraints; defaults enable AEC/NS/AGC
 * @property {Partial<Thresholds>} [thresholds]         detection thresholds (merged over defaults)
 * @property {import("./vad/vad-engine.js").VadEngine} [engine]
 *                                                      inject a custom engine (tests / WP7 energy fallback);
 *                                                      default: SileroVadAdapter
 * @property {any} [turnModel]                          optional semantic end-of-turn model — WP8 gate, unused in v1
 * @property {boolean} [debug]                          record state-transition traces in `detector.traces`
 * @property {() => void} [onSpeechStart]               S1: user started speaking
 * @property {(e: TurnEndEvent) => void} [onTurnEnd]    S2: utterance complete
 * @property {(info: InterruptInfo) => void} [onInterrupt]  S3: barge-in while agent speaks
 * @property {(rms: number) => void} [onLevel]          per-frame loudness 0..1
 * @property {(e: EngineError) => void} [onError]       engine/mission errors
 * @property {"auto"|"on"|"off"} [strictGating]         stricter barge-in gating override
 *                                                      (WP-E1 D5; default "auto" = scope-aware rule:
 *                                                      stricter on scope "none", or "unknown"/
 *                                                      "remote-only" without an active agent-audio route)
 */

/**
 * The public facade (created via `createSpeakOrNoSpeak`).
 *
 * @typedef {Object} SpeakOrNoSpeak
 * @property {() => Promise<void>} start
 * @property {() => void} stop
 * @property {(active: boolean) => void} setAgentSpeaking
 * @property {(active: boolean) => void} setAgentAudioRouted
 *        WP-E1 D5/D6: declare the agent audio plays through a cancelable route
 *        (createAgentAudioRoute, WP-E2); feeds the stricter-gating rule; reset by stop()
 * @property {ModuleState} state
 * @property {{ aec: boolean, engine: "silero" | "energy", aecScope: AecScope }} degraded
 */
