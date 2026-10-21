/**
 * Error taxonomy (WP7 §7.3) — stable string codes app code branches on.
 *
 * Errors are delivered BOTH ways: thrown (from `start()`, as {@link SpeakError})
 * and emitted (via `onError`, as plain `{code, message}` objects — the
 * documented callback shape). The codes are the contract; messages are prose.
 *
 * @module errors
 */

/** @typedef {"mic-denied"|"mic-not-found"|"insecure-context"|"cdn-unavailable"|"engine-load-failed"|"no-aec"|"audio-pipeline"|"vad-no-frames"|"engine-fallback"} ErrorCode */

/**
 * Stable error codes.
 *
 * Fatal (start fails): mic-denied, mic-not-found, insecure-context,
 * cdn-unavailable, engine-load-failed.
 * Warnings (engine keeps running): no-aec, engine-fallback.
 * Runtime: audio-pipeline, vad-no-frames.
 *
 * @type {Record<string, ErrorCode>}
 */
export const ERROR_CODES = {
  /** permission rejected by the user or the OS */
  MIC_DENIED: "mic-denied",
  /** no microphone device present */
  MIC_NOT_FOUND: "mic-not-found",
  /** not served over HTTPS/localhost — mic API unavailable */
  INSECURE_CONTEXT: "insecure-context",
  /** `window.vad` missing AND the npm import unavailable (WP1 adapter guard) */
  CDN_UNAVAILABLE: "cdn-unavailable",
  /** ORT/model/ MicVAD load or start threw */
  ENGINE_LOAD_FAILED: "engine-load-failed",
  /** echo cancellation not active on the mic track (warning — WP1/WP5) */
  NO_AEC: "no-aec",
  /** the engine fell back to the energy VAD (warning — WP7 §7.1) */
  ENGINE_FALLBACK: "engine-fallback",
  /** AudioContext / capture pipeline failure at runtime */
  AUDIO_PIPELINE: "audio-pipeline",
  /** engine started but produced no frames within the startup timeout */
  VAD_NO_FRAMES: "vad-no-frames",
};

/**
 * Thrown variant carrying the stable code.
 */
export class SpeakError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(message, { cause });
    this.name = "SpeakError";
    this.code = code;
  }
}

/**
 * Human-readable sentences for UI surfaces (the demo maps codes through this).
 * @param {ErrorCode} code
 * @returns {string}
 */
export function humanMessage(code) {
  switch (code) {
    case ERROR_CODES.MIC_DENIED:
      return "Microphone access was denied. Allow mic access for this site and reload the page.";
    case ERROR_CODES.MIC_NOT_FOUND:
      return "No microphone found on this device.";
    case ERROR_CODES.INSECURE_CONTEXT:
      return "Microphone API unavailable — serve this page over http://localhost (secure context); file:// will not work.";
    case ERROR_CODES.CDN_UNAVAILABLE:
      return "Could not load the VAD engine from the CDN — check your network, or serve /vendor/ locally (see README).";
    case ERROR_CODES.ENGINE_LOAD_FAILED:
      return "The speech engine failed to load — falling back to the energy-based engine (degraded accuracy).";
    case ERROR_CODES.NO_AEC:
      return "Warning: echo cancellation is not active on this microphone — stricter barge-in gating active; headphones recommended.";
    case ERROR_CODES.ENGINE_FALLBACK:
      return "Warning: running on the energy-based fallback engine (degraded noise robustness).";
    case ERROR_CODES.AUDIO_PIPELINE:
      return "Audio pipeline failure — see the browser console for details.";
    case ERROR_CODES.VAD_NO_FRAMES:
      return "The engine started but produced no audio frames — try reloading.";
    default:
      return `Unknown error (${code}).`;
  }
}
