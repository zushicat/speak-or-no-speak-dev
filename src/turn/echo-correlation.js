/**
 * `echoCorrelation` — normalized cross-correlation echo classifier
 * (rev 8.1 WP-E3, D9). Pure, Node-tested, no browser access.
 *
 * A mic frame whose content is a delayed copy of the recent agent-reference
 * audio (the page's own render tap) is classified as echo *regardless of its
 * rms* — closing the two cases the WP5 rms gate misses (loud TTS exceeding
 * 2× baseline; quiet agent voices failing to reach 2×). Defense-in-depth on
 * top of AEC, never a replacement (ships default-off).
 *
 * Search: delays [0, maxDelaySamples] over the decimated signals, stepped by
 * `lagStride` (a budget knob — the plan's per-probe multiply-add budget is
 * met by striding; 1 ms default stride is far below the render→capture
 * jitter we need to resolve).
 *
 * @module turn/echo-correlation
 */

/**
 * Normalized cross-correlation of `frame` against the reference ring,
 * searched over delays [0, maxDelaySamples] (raw samples), stepped by
 * `lagStride`.
 *
 * Semantics: the reference ring is chronological (oldest → newest, at the
 * detector's sample rate). For a candidate raw delay `d`, the frame is
 * compared against the reference window ending `d` samples before the newest
 * reference sample — mic(t) ≈ ref(t − d) for the echo path. The returned
 * `delaySamples` is the raw-sample delay of the correlation peak.
 *
 * @param {Float32Array} frame    the mic frame (16 kHz, e.g. 512 samples)
 * @param {Float32Array} refRing  chronological reference samples
 *                                (≥ windowSamples + maxDelaySamples + frame)
 * @param {{windowSamples: number, maxDelaySamples: number, decimation: number,
 *          lagStride?: number}} opts
 * @returns {{corr: number, delaySamples: number}}  corr ∈ [-1, 1] (peak over
 *          the delay search; 0 when a window has no energy)
 */
export function echoCorrelation(frame, refRing, opts) {
  const dec = Math.max(1, opts.decimation | 0);
  const lagStride = Math.max(1, opts.lagStride ?? 16);
  const winDec = Math.max(1, Math.floor(opts.windowSamples / dec));
  const maxDelayDec = Math.max(0, Math.floor(opts.maxDelaySamples / dec));
  const strideDec = Math.max(1, Math.floor(lagStride / dec));

  // Box-average decimation (pick/sum is sufficient at this precision).
  const x = decimate(frame, dec);
  const y = decimate(refRing, dec);
  const R = y.length;
  // Comparison length: the frame is the comparison unit (a 32 ms mic frame at
  // Silero v5's rate); `windowSamples` caps it for longer inputs and sizes the
  // reference history the detector must keep (windowMs + maxDelayMs).
  const N = Math.min(x.length, winDec);
  if (R < N + maxDelayDec || N === 0) {
    return { corr: 0, delaySamples: 0 }; // insufficient reference history
  }
  const xOff = x.length - N; // tail-aligned: the NEWEST frame audio
  const cmp = x.subarray(xOff);

  // Frame energy (constant across delays).
  let xEnergy = 0;
  for (let i = 0; i < N; i++) xEnergy += cmp[i] * cmp[i];
  if (xEnergy === 0) return { corr: 0, delaySamples: 0 };
  const xNorm = Math.sqrt(xEnergy);

  let best = 0;
  let bestDelayDec = 0;
  for (let d = 0; d <= maxDelayDec; d += strideDec) {
    const end = R - d;        // reference window ends here (exclusive)
    const start = end - N;    // the frame is reference-aligned window-for-window
    if (start < 0) break;
    let dot = 0;
    let yEnergy = 0;
    for (let i = 0; i < N; i++) {
      const yv = y[start + i];
      dot += cmp[i] * yv;
      yEnergy += yv * yv;
    }
    if (yEnergy === 0) continue;
    const corr = dot / (xNorm * Math.sqrt(yEnergy));
    if (corr > best) { best = corr; bestDelayDec = d; }
  }
  return { corr: best, delaySamples: bestDelayDec * dec };
}

/** Box-average decimation: groups of `dec` samples → their mean. @private */
function decimate(samples, dec) {
  if (dec === 1) return samples;
  const n = Math.floor(samples.length / dec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const base = i * dec;
    for (let k = 0; k < dec; k++) sum += samples[base + k];
    out[i] = sum / dec;
  }
  return out;
}
