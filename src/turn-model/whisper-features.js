/**
 * Whisper log-mel feature extraction in pure JS (WP8 §8.2).
 *
 * Replicates `transformers.WhisperFeatureExtractor(chunk_length=8)` exactly
 * (the numpy path in feature_extraction_whisper.py + audio_utils.py):
 *
 *   audio (16 kHz mono) → pad/truncate to 128 000 samples (8 s; audio ends at
 *   the buffer end) → center reflect-pad 200 → frames of 400 (hop 160) ×
 *   periodic-Hann window → rfft(400) → power² → slaney-mel filterbank (80,
 *   floor 1e-10) → log10 → drop last frame → [80, 800] → max(x, max−8) →
 *   (x+4)/4.
 *
 * rfft(400) via Bluestein's chirp-z (400 = 2⁴·5² is not a power of two);
 * the radix-2 FFT below is float64 to match numpy's internal precision.
 *
 * Parity-verified against the Python reference (venv: onnxruntime +
 * transformers) — see plans/initial/work-packages/wp8-smart-turn-experiment.md.
 *
 * @module turn-model/whisper-features
 */

export const N_SAMPLES = 8 * 16000; // 128000
export const N_FFT = 400;
export const HOP = 160;
export const N_MELS = 80;
export const N_FRAMES = N_SAMPLES / HOP; // 800

/** Pad (left, zeros) / truncate (keep the END) to exactly 8 s — per smart-turn's truncate_audio_to_last_n_seconds. */
export function padOrTruncate8s(audio) {
  if (audio.length > N_SAMPLES) return audio.slice(audio.length - N_SAMPLES);
  if (audio.length === N_SAMPLES) return audio;
  const out = new Float32Array(N_SAMPLES);
  out.set(audio, N_SAMPLES - audio.length); // left-pad so the audio ends at the buffer end
  return out;
}

/**
 * Zero-mean/unit-variance normalization of the padded 8 s buffer — the
 * extractor's `do_normalize` step (`(x − mean)/sqrt(var + 1e-7)`, population
 * variance, over the WHOLE padded buffer — the smart-turn pre-pad is invisible
 * to the attention mask, so the silent half participates).
 * @param {Float32Array} audio  the padded 128000-sample buffer (normalized in place)
 */
function zeroMeanUnitVar(audio) {
  let mean = 0;
  for (let i = 0; i < audio.length; i++) mean += audio[i];
  mean /= audio.length;
  let variance = 0;
  for (let i = 0; i < audio.length; i++) {
    const d = audio[i] - mean;
    variance += d * d;
  }
  variance /= audio.length;
  const scale = 1 / Math.sqrt(variance + 1e-7);
  for (let i = 0; i < audio.length; i++) audio[i] = (audio[i] - mean) * scale;
  return audio;
}

/** Periodic Hann window, length 400 (np.hanning(401) minus the last sample). */
export function hannPeriodic400() {
  const w = new Float64Array(N_FFT);
  for (let k = 0; k < N_FFT; k++) w[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / N_FFT);
  return w;
}

/**
 * Slaney mel filterbank, replicating transformers' mel_filter_bank(
 *   num_frequency_bins=201, num_mel_filters=80, min_frequency=0,
 *   max_frequency=8000, sampling_rate=16000, norm="slaney", mel_scale="slaney").
 * @returns {Float64Array[]} 201 × 80 (column per filter)
 */
export function slaneyMelFilterbank() {
  const numFreqBins = N_FFT / 2 + 1; // 201
  const hzToMelSlaney = (f) =>
    f < 1000 ? (3.0 * f) / 200.0 : 15.0 + Math.log(f / 1000.0) * (27.0 / Math.log(6.4));
  const melToHzSlaney = (m) =>
    m < 15 ? (200.0 * m) / 3.0 : 1000.0 * Math.exp((m - 15.0) / (27.0 / Math.log(6.4)));

  const melMin = hzToMelSlaney(0); // 0
  const melMax = hzToMelSlaney(8000);
  const melFreqs = new Float64Array(N_MELS + 2);
  for (let i = 0; i <= N_MELS + 1; i++) melFreqs[i] = melMin + ((melMax - melMin) * i) / (N_MELS + 1);
  const filterFreqs = new Float64Array(N_MELS + 2);
  for (let i = 0; i <= N_MELS + 1; i++) filterFreqs[i] = melToHzSlaney(melFreqs[i]);

  // fft_freqs = linspace(0, 8000, 201)
  const fftFreqs = new Float64Array(numFreqBins);
  for (let i = 0; i < numFreqBins; i++) fftFreqs[i] = (8000 * i) / (numFreqBins - 1);

  // triangular bank (python: down = (fftFreqs[b] − filterFreqs[m]) / diff[m];
  //                          up   = (filterFreqs[m+2] − fftFreqs[b]) / diff[m+1])
  const filters = new Float64Array(numFreqBins * N_MELS); // row-major [bin][mel]
  for (let b = 0; b < numFreqBins; b++) {
    for (let m = 0; m < N_MELS; m++) {
      const down = (fftFreqs[b] - filterFreqs[m]) / (filterFreqs[m + 1] - filterFreqs[m]);
      const up = (filterFreqs[m + 2] - fftFreqs[b]) / (filterFreqs[m + 2] - filterFreqs[m + 1]);
      filters[b * N_MELS + m] = Math.max(0, Math.min(down, up));
    }
  }
  // slaney area normalization: enorm = 2 / (filterFreqs[2:82] − filterFreqs[0:80])
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2.0 / (filterFreqs[m + 2] - filterFreqs[m]);
    for (let b = 0; b < numFreqBins; b++) filters[b * N_MELS + m] *= enorm;
  }
  return filters;
}

// ---------------------------------------------------------------------------
// radix-2 iterative FFT (float64) + Bluestein chirp-z for arbitrary N
// ---------------------------------------------------------------------------

/** In-place iterative radix-2 FFT on interleaved real/imag pairs (length = power of 2). */
function fftRadix2(re, im) {
  const n = re.length;
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const uRe = re[i + k], uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

let bluesteinCache = null;
/**
 * Chirp tables for N (reused for all 800 frames): chirp[i] = e^{-iπi²/N}.
 * Also precomputes FFT(conj(chirp)) zero-padded to M — call-invariant, so the
 * per-frame work is ONE forward FFT + multiply + ONE inverse FFT.
 */
function bluesteinTables(n) {
  if (bluesteinCache && bluesteinCache.n === n) return bluesteinCache;
  const m = 1 << Math.ceil(Math.log2(2 * n - 1)); // ≥ 2n−1, power of 2
  const chirpRe = new Float64Array(n), chirpIm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * (i * i)) / n;
    chirpRe[i] = Math.cos(angle);
    chirpIm[i] = -Math.sin(angle);
  }
  // b[j] = conj(chirp[j]) for j in [0,n); the wrapped NEGATIVE indices
  // (k−i) mod M ∈ [M−n+1, M−1] get conj(chirp[M−j]); the middle region is
  // never hit by valid (k−i) ∈ [−(n−1), n−1] and stays ZERO.
  const fftBRe = new Float64Array(m), fftBIm = new Float64Array(m);
  for (let j = 0; j < n; j++) {
    fftBRe[j] = chirpRe[j];
    fftBIm[j] = -chirpIm[j];
  }
  for (let j = m - n + 1; j < m; j++) {
    const q = m - j;
    fftBRe[j] = chirpRe[q];
    fftBIm[j] = -chirpIm[q];
  }
  fftRadix2(fftBRe, fftBIm); // precomputed FFT of b
  bluesteinCache = { n, m, chirpRe, chirpIm, fftBRe, fftBIm };
  return bluesteinCache;
}

/** Cached working buffers (module-level: the pipeline is single-threaded;
 *  per-frame allocation here would generate ~25 MB garbage per call and
 *  trigger GC storms that also stall the following ONNX inference). */
let bufCache = null;
function workingBuffers() {
  if (bufCache && bufCache.n === N_FFT) return bufCache;
  const { m } = bluesteinTables(N_FFT);
  bufCache = {
    n: N_FFT,
    aRe: new Float64Array(m), aIm: new Float64Array(m),
    out: new Float64Array((N_FFT / 2 + 1) * 2),
  };
  return bufCache;
}

/** @private exported for unit tests (Bluestein wrapper correctness) */
export function rfftReal400(x) {
  const n = N_FFT;
  const { m, chirpRe, chirpIm, fftBRe, fftBIm } = bluesteinTables(n);
  const { aRe, aIm, out } = workingBuffers();

  // a[i] = x[i] · chirp[i]; the tail [n, m) must be ZERO every call
  // (cached buffers carry the previous frame's values).
  for (let i = 0; i < n; i++) {
    aRe[i] = x[i] * chirpRe[i];
    aIm[i] = x[i] * chirpIm[i];
  }
  aRe.fill(0, n);
  aIm.fill(0, n);

  fftRadix2(aRe, aIm);
  for (let i = 0; i < m; i++) {
    const r = aRe[i] * fftBRe[i] - aIm[i] * fftBIm[i];
    const im = aRe[i] * fftBIm[i] + aIm[i] * fftBRe[i];
    aRe[i] = r; aIm[i] = im;
  }
  // inverse FFT via the conjugate trick: conj → fft → conj, then /m
  for (let i = 0; i < m; i++) aIm[i] = -aIm[i];
  fftRadix2(aRe, aIm);
  for (let i = 0; i < m; i++) aIm[i] = -aIm[i];

  for (let k = 0; k <= n / 2; k++) {
    const convRe = aRe[k] / m, convIm = aIm[k] / m;
    // X[k] = chirp[k] · conv[k]
    out[k * 2] = convRe * chirpRe[k] - convIm * chirpIm[k];
    out[k * 2 + 1] = convRe * chirpIm[k] + convIm * chirpRe[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// the full pipeline
// ---------------------------------------------------------------------------

/**
 * Whisper log-mel features for one 8 s buffer.
 * @param {Float32Array} audio16k  raw PCM @ 16 kHz (any length ≤ 8 s handled)
 * @returns {Float64Array} length 80*800, row-major [mel][frame]
 */
export function whisperFeatures(audio16k) {
  const audio = zeroMeanUnitVar(Float32Array.from(padOrTruncate8s(audio16k)));
  const window = hannPeriodic400();
  const filters = slaneyMelFilterbank(); // [201][80]

  // center reflect-pad 200 on both sides (np.pad reflect: mirror WITHOUT the edge value)
  const padded = new Float64Array(audio.length + N_FFT);
  for (let i = 0; i < audio.length; i++) padded[i + N_FFT / 2] = audio[i];
  for (let i = 0; i < N_FFT / 2; i++) {
    padded[i] = audio[N_FFT / 2 - i];                   // left reflect: out[p] = x[w−p]
    padded[audio.length + N_FFT / 2 + i] = audio[audio.length - 2 - i]; // right reflect: x[n−2−p]
  }

  const numFrames = 1 + Math.floor((padded.length - N_FFT) / HOP); // 801
  const numBins = N_FFT / 2 + 1; // 201
  const frameBuf = new Float64Array(N_FFT);
  // accumulate mel power per frame
  const melAcc = new Float64Array(N_MELS);
  /** @type {Float64Array} result [80][800] */
  const result = new Float64Array(N_MELS * N_FRAMES);

  for (let f = 0; f < numFrames; f++) {
    const t = f * HOP;
    for (let j = 0; j < N_FFT; j++) frameBuf[j] = padded[t + j] * window[j];
    const spectrum = rfftReal400(frameBuf); // 201 complex bins
    // mel: filters[b][m] · power[b]
    melAcc.fill(0);
    for (let b = 0; b < numBins; b++) {
      const re = spectrum[b * 2], im = spectrum[b * 2 + 1];
      const power = re * re + im * im;
      if (power === 0) continue;
      const off = b * N_MELS;
      for (let m = 0; m < N_MELS; m++) melAcc[m] += filters[off + m] * power;
    }
    // log10 with floor 1e-10 (drop the last frame later)
    if (f < N_FRAMES) {
      for (let m = 0; m < N_MELS; m++) {
        result[m * N_FRAMES + f] = Math.log10(Math.max(1e-10, melAcc[m]));
      }
    }
  }

  // post-processing: max(x, max − 8) then (x + 4) / 4
  let maxVal = -Infinity;
  for (let i = 0; i < result.length; i++) if (result[i] > maxVal) maxVal = result[i];
  const floorVal = maxVal - 8.0;
  for (let i = 0; i < result.length; i++) {
    const v = Math.max(result[i], floorVal);
    result[i] = (v + 4.0) / 4.0;
  }
  return result;
}
