/**
 * Defaults + options merging. No `window` access — used in Node tests (D1).
 *
 * @module config
 */

import { AEC_CONSTRAINTS } from "./vad/aec-scope.js";

/**
 * Default configuration. Every value traceable to master plan §4.3 or a WP
 * decision; frame-count thresholds are calibrated for Silero v5's 32 ms
 * frames — the plan's 96 ms figures describe the same wall-clock windows
 * (WP1 deviation D-WP1-1: v5 frames are 512 samples = 32 ms, and vad-web
 * 0.0.31 derives frame size from the model, ignoring the frameSamples option).
 *
 * @type {import("./types.js").SpeakOrNoSpeakOptions & { thresholds: import("./types.js").Thresholds }}
 */
export const DEFAULTS = {
  /**
   * Browser AEC constraints — WP-E1 D1: widest scope as an *ideal*
   * (`{ideal:"all"}`), shared verbatim with the engines via
   * `AEC_CONSTRAINTS` (src/vad/aec-scope.js). A user's primitive
   * `mic.echoCancellation` (e.g. `false`) still replaces it (mergeOptions:
   * primitive beats object).
   */
  mic: { ...AEC_CONSTRAINTS },
  thresholds: {
    /** frame "is speech" level (plan §4.3) */
    onsetSpeechThreshold: 0.6,
    /** hysteresis floor (plan §4.3) */
    negativeSpeechThreshold: 0.35,
    /** 9 × 32 ms = 288 ms onset confirm — plan's 3 × 96 ms window at v5 rate */
    onsetConfirmFrames: 9,
    /** ignore coughs/clicks shorter than this (plan §4.3) */
    minSpeechMs: 250,
    /** silence that ends a turn — BASE for the WP4 adaptive window
     *  (redemptionFor adjusts it from the turn's rhythm stats; clamped 350–1200) */
    redemptionMs: 650,
    /** silence that opens the PAUSE sub-state (WP4 §4.1) — interior pauses
     *  shorter than redemption never end the turn */
    shortPauseMs: 250,
    /** audio before onset kept in turn audio (plan §4.3) */
    preSpeechPadMs: 200,
    /** 6 × 32 ms ≈ 192 ms barge-in confirm — plan's 2 × 96 ms window at v5 rate */
    bargeInConfirmFrames: 6,
    /** force-end long turns + truncated flag (plan §4.3) */
    maxTurnMs: 30000,
    /** WP3 rule 4: post-interrupt silence does not count toward redemption */
    graceAfterInterruptMs: 500,
    /** WP5 §5.4: without AEC, barge-in confirm needs ≈ this window (stricter) */
    noAecBargeInConfirmMs: 300,
    /** WP5 §5.4: without AEC, frame rms must exceed this × the rolling
     *  agent-playback mean rms to count as speech (TTS-leakage guard) */
    noAecRmsFactor: 2,
    /** WP8 §8.3: max wait for the semantic turn model before failing open */
    modelTimeoutMs: 300,
  },
  /** record state-transition traces on the detector */
  debug: false,
  /**
   * Stricter-gating override.
   */
  strictGating: "auto",
  /**
   * WP-E3 coherence echo gate (D9) — correlation-based echo classification,
   * defense-in-depth ON TOP of AEC. Ships default-OFF; see
   * src/turn/echo-correlation.js. `lagStride` (raw samples, 1 ms @16 kHz) is
   * the CPU-budget knob for the delay search.
   */
  echoGate: {
    enabled: false,            // master switch
    correlationThreshold: 0.75,
    maxDelayMs: 500,           // render→capture delay search range
    windowMs: 250,             // reference history the detector must keep
    decimation: 2,             // 16 kHz → 8 kHz effective search rate
    lagStride: 16,             // raw-sample lag step (1 ms @16 kHz)
    probeEveryFrames: 4,       // probe cadence; un-probed frames inherit the verdict
    suppressOnset: false,      // phase 2: also reject echo in the READY state
  },
  /**
   * WP-E4 (D9, stretch): agent-voice-profile gate — default OFF. Scores
   * completed turns against the agent voice profile (built offline via
   * scripts/build-agent-voice-profile.mjs) and drops agent-similar turns
   * (suppression, R7); fail-open on any model error.
   */
  voiceGate: {
    enabled: false,
    threshold: 0.8, // measured separation: same-voice 0.945 · different-voice 0.393
    profileUrl: "/src/gate/agent-voice-profile.json",
    modelUrl: "/vendor/wespeaker_en_voxceleb_resnet34.onnx",
  },
};

/**
 * Merge user options over defaults: plain objects merge recursively, every
 * other value (numbers, arrays, functions, null, undefined) replaces the
 * default. Returns a new object; inputs are not mutated.
 *
 * @param {Record<string, any>} user
 * @param {Record<string, any>} defaults
 * @returns {Record<string, any>}
 */
export function mergeOptions(user, defaults) {
  const out = { ...defaults };
  if (!isPlainObject(user)) return out;
  for (const key of Object.keys(user)) {
    const u = user[key];
    if (u === undefined) continue; // "not provided" → keep the default
    out[key] = isPlainObject(u) && isPlainObject(out[key])
      ? mergeOptions(u, out[key])
      : u;
  }
  return out;
}

/** @private */
function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
