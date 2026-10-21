/**
 * Fixed-capacity Float32Array ring buffer for pre-speech padding (WP3 §3.3).
 *
 * The detector pushes every frame's audio and flushes at onset: the flushed
 * content is the last `capacity` samples — the turn audio therefore starts
 * up to `preSpeechPadMs` before the first confirmed-speech sample and never
 * clips word onsets. The detector sizes the capacity as
 * `preSpeechPadMs + onsetConfirmFrames × frameDuration` so the confirmed
 * onset frames themselves are part of the flushed pad (see turn-detector.js).
 *
 * Pure logic — no `window` access (Node-testable, D1).
 *
 * @module ring-buffer
 */
export class RingBuffer {
  /**
   * @param {number} capacitySamples fixed capacity in samples
   */
  constructor(capacitySamples) {
    if (!Number.isInteger(capacitySamples) || capacitySamples <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, got ${capacitySamples}`);
    }
    this.capacity = capacitySamples;
    /** @type {Float32Array} */
    this.buf = new Float32Array(capacitySamples);
    this.writePos = 0; // next write index
    this.filled = 0;   // samples currently held (≤ capacity)
  }

  /**
   * Append a frame; frames longer than the capacity keep only their last
   * `capacity` samples.
   * @param {Float32Array} frame
   */
  push(frame) {
    if (frame.length >= this.capacity) {
      this.buf.set(frame.subarray(frame.length - this.capacity));
      this.writePos = 0;
      this.filled = this.capacity;
      return;
    }
    const first = Math.min(frame.length, this.capacity - this.writePos);
    this.buf.set(frame.subarray(0, first), this.writePos);
    if (first < frame.length) {
      this.buf.set(frame.subarray(first), 0);
    }
    this.writePos = (this.writePos + frame.length) % this.capacity;
    this.filled = Math.min(this.capacity, this.filled + frame.length);
  }

  /**
   * Return the buffered samples in chronological order and reset the buffer.
   * @returns {Float32Array}
   */
  flush() {
    if (this.filled === 0) return new Float32Array(0);
    let out;
    if (this.filled < this.capacity) {
      out = this.buf.slice(0, this.filled);
    } else {
      out = new Float32Array(this.capacity);
      out.set(this.buf.subarray(this.writePos), 0);
      out.set(this.buf.subarray(0, this.writePos), this.capacity - this.writePos);
    }
    this.writePos = 0;
    this.filled = 0;
    return out;
  }

  /** Drop buffered samples without returning them. */
  clear() {
    this.writePos = 0;
    this.filled = 0;
  }
}
