/**
 * `VadEngine` — the interface contract for frame-level speech detection (WP1).
 *
 * Every engine implementation (silero-vad-adapter.js now, energy-vad.js in WP7)
 * emits {@link VadFrame}s through a registered {@link FrameCallback} and reports
 * failures through an {@link ErrorCallback}. The turn state machine (WP3) is the
 * single consumer of this stream — engines never decide turns themselves.
 *
 * Implementations must stay importable in Node (for unit tests): no top-level
 * access to `window`/`navigator` — guard inside `start()`.
 *
 * @module vad-engine
 */

/**
 * One processed audio frame.
 *
 * @typedef {Object} VadFrame
 * @property {number} probability    P(speech) for this frame, 0..1
 * @property {Float32Array|null} frame  raw 16 kHz mono samples of this frame
 *                                      (null if the engine build doesn't provide it)
 * @property {number} rms            loudness 0..1 of the frame (0 if frame absent)
 * @property {number} durationMs     frame duration in real audio time — derived
 *                                   from the actual frame length at 16 kHz
 *                                   (Silero v5: 512 samples = 32 ms; legacy
 *                                   model: 1536 = 96 ms — see silero-vad-adapter)
 */

/**
 * @typedef {(frame: VadFrame) => void} FrameCallback
 */

/**
 * @typedef {(err: {code: string, message: string}) => void} ErrorCallback
 */

/**
 * Engine interface. Subclasses override the methods; callers register callbacks
 * before `start()`.
 *
 * @interface
 */
export class VadEngine {
  /**
   * Load model + open mic. Resolves when the first frame is emitted
   * (implementations may resolve earlier if their pipeline cannot observe that).
   * @returns {Promise<void>}
   */
  async start() {}

  /** Stop the engine and release the microphone. */
  stop() {}

  /** Temporarily stop emitting frames without releasing resources. */
  pause() {}

  /** Resume after {@link pause}. */
  resume() {}

  /** @param {FrameCallback} cb */
  onFrame(cb) {}

  /** @param {ErrorCallback} cb */
  onError(cb) {}
}
