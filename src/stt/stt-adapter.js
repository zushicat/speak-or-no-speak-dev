/**
 * The `SttAdapter` interface — the transcription plug point (WP9 §9.1).
 *
 * **The hard rule (analysis §3 D):** STT lives strictly OUTSIDE the real-time
 * loop. Adapters are called **only** with `onTurnEnd` audio — never live
 * frames — and the MODULE itself never calls them: the wiring belongs to the
 * embedding app (see the demo for the pattern). Detection behavior is
 * completely independent of STT; an adapter failure must never affect
 * `onSpeechStart`/`onTurnEnd`/`onInterrupt`.
 *
 * The module ships NO STT engine — adapters are user-supplied. See
 * `cloud-stub-adapter.js` for the shipped example and the README's
 * "Adding transcription" section for the Web Speech alternative.
 *
 * @module stt/stt-adapter
 */

/**
 * @typedef {Object} Transcription
 * @property {string} text
 * @property {number} [confidence]  0..1, if the backend provides one
 */

/**
 * @interface
 */
export class SttAdapter {
  /**
   * Transcribe one turn's audio.
   * @param {Float32Array} audio              16 kHz mono PCM (the onTurnEnd audio, incl. pre-speech pad)
   * @param {Object} [opts]
   * @param {string} [opts.language]          e.g. "en-US" — pass through to the backend
   * @returns {Promise<Transcription>}
   */
  async transcribe(audio, opts) {}
}
