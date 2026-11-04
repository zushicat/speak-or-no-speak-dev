/**
 * Kaldi-style fbank feature extraction in pure JS (WP-E4).
 *
 * The speaker-embedding models shipped for the agent-voice gate
 * (wespeaker/ECAPA/CAM++ class, e.g. `vendor/wespeaker_en_voxceleb_resnet34.onnx`)
 * consume 80-bin log-mel fbank features of 16 kHz mono audio — the kaldi
 * recipe as used by sherpa-onnx's feature extractor for these models:
 *
 *   frame 25 ms (400 samples) · shift 10 ms (160) · snip-edges (no padding)
 *   povey window (Hann^0.85) · pre-emphasis 0.97 · remove DC offset
 *   FFT 512 (next pow-2) · power spectrum · HTK-mel 80 bins (20–8000 Hz)
 *   log(max(x, eps))
 *
 * Pure logic — no `window` access (Node-testable, D1); shared by the offline
 * profile builder (scripts/build-agent-voice-profile.mjs) and the browser
 * gate (src/gate/agent-voice-gate.js).
 *
 * @module gate/kaldi-fbank
 */

const EPS = 1.1920929e-7; // FLT_EPSILON — kaldi's log floor

/**
 * Compute kaldi-style fbank features.
 * @param {Float32Array} samples  mono audio at `sampleRate`
 * @param {number} [sampleRate]  default 16000
 * @param {{numMelBins?: number, frameLengthMs?: number, frameShiftMs?: number,
 *          cmvn?: boolean}} [opts]
 *          `cmvn: true` applies per-utterance mean-var normalization per mel
 *          bin — the wespeaker/sherpa inference recipe; WITHOUT it the
 *          embeddings barely separate voices (measured: same-voice 0.98 /
 *          different-voice 0.89 raw → 0.94 / 0.39 with CMVN)
 * @returns {{feats: Float32Array, numFrames: number, numBins: number}}
 *          `feats` is row-major [numFrames × numBins]
 */
export function kaldiFbank(samples, sampleRate = 16000, opts = {}) {
  const numBins = opts.numMelBins ?? 80;
  const frameLen = Math.round(((opts.frameLengthMs ?? 25) / 1000) * sampleRate); // 400
  const frameShift = Math.round(((opts.frameShiftMs ?? 10) / 1000) * sampleRate); // 160
  const fftLen = nextPow2(frameLen); // 512

  const window = poveyWindow(frameLen);
  const bins = htkMelFilterbank(numBins, sampleRate, 20, sampleRate / 2, fftLen);
  const half = fftLen / 2 + 1;

  const numFrames = samples.length >= frameLen
    ? Math.floor((samples.length - frameLen) / frameShift) + 1
    : 0;
  if (numFrames <= 0) return { feats: new Float32Array(0), numFrames: 0, numBins };

  const feats = new Float32Array(numFrames * numBins);
  const re = new Float64Array(fftLen);
  const im = new Float64Array(fftLen);
  const power = new Float64Array(half);

  for (let t = 0; t < numFrames; t++) {
    const base = t * frameShift;
    // Clear the FFT scratch: re[0..frameLen) is overwritten below, but the
    // tail and ALL of im carry the PREVIOUS frame's spectral output — reusing
    // them compounds the stale data (~×fftLen per frame) until float64
    // overflows to NaN (the bug that produced degenerate embeddings).
    im.fill(0);
    re.fill(0, frameLen);
    // pre-emphasis (kaldi: the first sample keeps gain 1 — no 0.97 filter on it)
    let prev = samples[base];
    for (let i = 0; i < frameLen; i++) {
      const cur = samples[base + i];
      re[i] = (cur - 0.97 * prev) * window[i];
      prev = cur;
    }
    // remove DC offset (kaldi: subtract the windowed frame mean)
    let mean = 0;
    for (let i = 0; i < frameLen; i++) mean += re[i];
    mean /= frameLen;
    for (let i = 0; i < frameLen; i++) re[i] -= mean;

    fftRadix2(re, im);

    for (let k = 0; k < half; k++) {
      power[k] = (re[k] * re[k] + im[k] * im[k]) / fftLen; // kaldi-normalized power
    }
    // power spectrum → mel → log
    for (let b = 0; b < numBins; b++) {
      const { lo, w } = bins[b];
      let sum = 0;
      for (let i = 0; i < w.length; i++) {
        const k = lo + i;
        if (k >= half) break;
        sum += power[k] * w[i];
      }
      feats[t * numBins + b] = Math.log(Math.max(sum, EPS));
    }
  }
  if (opts.cmvn) cmvnPerUtterance(feats, numFrames, numBins);
  return { feats, numFrames, numBins };
}

/**
 * Per-utterance CMVN: normalize each mel bin over time (mean 0, var 1).
 * @private
 */
function cmvnPerUtterance(feats, numFrames, numBins) {
  for (let b = 0; b < numBins; b++) {
    let m = 0;
    for (let t = 0; t < numFrames; t++) m += feats[t * numBins + b];
    m /= numFrames;
    let v = 0;
    for (let t = 0; t < numFrames; t++) {
      const d = feats[t * numBins + b] - m;
      v += d * d;
    }
    v = Math.sqrt(v / numFrames) || 1;
    for (let t = 0; t < numFrames; t++) feats[t * numBins + b] = (feats[t * numBins + b] - m) / v;
  }
}

/** @private next power of two ≥ n */
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** @private povey window = hann^0.85 (kaldi's default window) */
function poveyWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    w[i] = Math.pow(v, 0.85);
  }
  return w;
}

/**
 * @private HTK-style mel filterbank (kaldi's default mel scale), triangular
 * weights per bin over the FFT bins — adjacent filters may share FFT bins, so
 * weights are per-bin arrays.
 * @returns {{lo: number, w: Float64Array}[]} one entry per mel bin
 */
function htkMelFilterbank(numBins, sampleRate, lowHz, highHz, fftLen) {
  const half = fftLen / 2 + 1;
  const hzToMel = (f) => 1127 * Math.log(1 + f / 700);
  const melToHz = (m) => 700 * (Math.exp(m / 1127) - 1);
  const melLow = hzToMel(lowHz);
  const melHigh = hzToMel(highHz);
  const melPts = new Float64Array(numBins + 2);
  for (let i = 0; i < numBins + 2; i++) {
    melPts[i] = melToHz(melLow + ((melHigh - melLow) * i) / (numBins + 1));
  }
  const bins = [];
  for (let b = 0; b < numBins; b++) {
    const left = melPts[b], center = melPts[b + 1], right = melPts[b + 2];
    const kLo = Math.max(0, Math.floor(((fftLen + 1) * left) / sampleRate));
    const kHi = Math.min(half - 1, Math.ceil(((fftLen + 1) * right) / sampleRate));
    const w = new Float64Array(Math.max(1, kHi - kLo + 1));
    for (let k = kLo; k <= kHi; k++) {
      const hz = (k * sampleRate) / fftLen;
      w[k - kLo] = hz <= center
        ? (hz - left) / (center - left)
        : (right - hz) / (right - center);
    }
    bins.push({ lo: kLo, w });
  }
  return bins;
}

/**
 * In-place iterative radix-2 FFT on interleaved real/imag float64 pairs.
 * @private
 */
function fftRadix2(re, im) {
  const n = re.length;
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
        const vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}
