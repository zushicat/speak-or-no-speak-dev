/**
 * `AgentVoiceGate` — the agent-voice-profile gate (WP-E4, D9 stretch).
 *
 * Suppression, never a hard gate (R7): turns whose audio embeds close to the
 * AGENT's own voice profile are dropped (worst case: user speech briefly
 * discounted). Ships default-off; fail-open on ANY model error — a gate
 * failure never loses a user turn.
 *
 * Pipeline: turn audio (16 kHz mono) → kaldi fbank 80 + per-utterance CMVN
 * (src/gate/kaldi-fbank.js) → speaker-embedding ONNX (wespeaker/ECAPA class,
 * e.g. vendor/wespeaker_en_voxceleb_resnet34.onnx — manual download,
 * gitignored, SmartTurnModel precedent) → L2-normalized 256-d embedding →
 * cosine similarity vs the committed profile → `sim ≥ threshold` ⇒ agent.
 *
 * The profile is built offline:
 * `node scripts/build-agent-voice-profile.mjs` → src/gate/agent-voice-profile.json
 * (small, committed). Measured separation on the reference machine: same-voice
 * 0.945 · different-voice 0.393 → default threshold 0.8 (conservative: a
 * higher threshold drops fewer turns, i.e. safer for user speech).
 *
 * Node-safe: importing the module must not touch browser globals; the ORT
 * runtime comes from the pinned CDN script (`window.ort`), like
 * SmartTurnModel. CPU cost measured (Node, 6.7 s turn): fbank + inference
 * ≈ 30–60 ms — runs at TURN END only, never in the frame path.
 *
 * @module gate/agent-voice-gate
 */

import { kaldiFbank } from "./kaldi-fbank.js";

/**
 * Cosine similarity of two vectors (norm-neutral: normalizes internally).
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} ∈ [-1, 1]
 */
export function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * The pure gate decision.
 * @param {number} similarity  cosine similarity vs the agent profile
 * @param {number} [threshold]  default 0.8
 * @returns {boolean} true = this audio is agent-voice-like → suppress
 */
export function isAgentVoice(similarity, threshold = 0.8) {
  return similarity >= threshold;
}

/**
 * Turn-level AND rolling-window gate: score a completed turn's audio, and —
 * for the detector's frame-level hook — score the trailing `windowMs` of mic
 * audio on a cadence, exposing the latest verdict synchronously (the detector
 * is sync; echo bursts are contiguous, so a window verdict is stable across
 * its span — no per-frame flicker by construction).
 */
export class AgentVoiceGate {
  /**
   * @param {Object} [options]
   * @param {string} [options.profileUrl]  where to fetch the profile JSON
   *        (default "/src/gate/agent-voice-profile.json" — dev server layout;
   *        apps bundle their own)
   * @param {Object} [options.profile]  inline profile (tests / preloaded) —
   *        skips the fetch
   * @param {string} [options.modelUrl]  the ONNX speaker-embedding model
   *        (default "/vendor/wespeaker_en_voxceleb_resnet34.onnx")
   * @param {number} [options.threshold]  similarity threshold (default 0.8)
   * @param {number} [options.windowMs]  rolling mic-audio window scored for
   *        the detector's frame-level hook (default 500)
   * @param {"agent-suppress"} [options.mode]  only "agent-suppress" ships
   *        ("user-only" enrollment is phase 2 — not implemented)
   * @param {any} [options.ort]  the ORT namespace (defaults to window.ort)
   */
  constructor(options = {}) {
    this.profileUrl = options.profileUrl ?? "/src/gate/agent-voice-profile.json";
    this.modelUrl = options.modelUrl ?? "/vendor/wespeaker_en_voxceleb_resnet34.onnx";
    this.threshold = options.threshold ?? 0.8;
    this.windowMs = options.windowMs ?? 500;
    this.mode = options.mode ?? "agent-suppress";
    this._profile = options.profile ?? null;
    this._ort = options.ort ?? (typeof window !== "undefined" ? window.ort : null);
    this.session = null;
    this._initPromise = null;
    /** stats for tests/telemetry */
    this.scored = 0;
    this.dropped = 0;
    /** last similarity seen (any scoring path) — calibration telemetry */
    this.lastSimilarity = null;
    /** capped history of recent similarities (calibration fodder, F9) */
    this.similarityHistory = [];
    /** @private rolling mic-window state (feed + cadence scoring) */
    this._win = [];
    this._winSamples = 0;
    this._lastWindowVerdict = false;
    this._windowScored = 0;
    this._scoring = false;
  }

  /** Load profile + model once; subsequent calls reuse the session. */
  async ensureReady() {
    if (this.session && this._profile) return;
    if (!this._initPromise) {
      this._initPromise = (async () => {
        if (!this._profile) {
          const res = await fetch(this.profileUrl);
          if (!res.ok) throw new Error(`profile fetch failed (${res.status})`);
          this._profile = await res.json();
        }
        if (!Array.isArray(this._profile?.embedding) || this._profile.embedding.length === 0) {
          throw new Error("profile has no embedding");
        }
        if (!this._ort?.InferenceSession) {
          throw new Error("ORT runtime unavailable (window.ort missing — is the CDN script loaded?)");
        }
        this.session = await this._ort.InferenceSession.create(this.modelUrl, {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
        });
      })();
      this._initPromise.catch(() => { this._initPromise = null; }); // allow retry after a transient failure
    }
    return this._initPromise;
  }

  /** SmartTurnModel-parity alias. */
  load() {
    return this.ensureReady();
  }

  /**
   * Feed one mic frame's audio into the rolling window and (on cadence, when
   * scoring is active) re-score it in the background. Fail-open: scoring
   * errors keep the last verdict (never throw into the frame path).
   * @param {Float32Array} frameSamples  the frame's raw audio (16 kHz mono)
   * @param {boolean} [scoringActive]  true while the detector consumes
   *        verdicts (armed, or suppressOnset in READY) — idle sessions skip scoring
   */
  feed(frameSamples, scoringActive = true) {
    this._win.push(frameSamples);
    this._winSamples += frameSamples.length;
    const winCap = Math.ceil((this.windowMs / 1000) * (this._profile?.sampleRate ?? 16000));
    while (this._winSamples > winCap && this._win.length > 1) {
      this._winSamples -= this._win[0].length;
      this._win.shift();
    }
    if (!scoringActive || this._scoring) return;
    // cadence: re-score once per window of new audio
    this._windowScored += frameSamples.length;
    if (this._windowScored < winCap) return;
    this._windowScored = 0;
    if (this._winSamples < winCap * 0.5) return; // window still filling
    this._scoring = true;
    const audio = concatFloat32(this._win);
    this.scoreWindow(audio)
      .then(({ isAgent }) => { this._lastWindowVerdict = isAgent; })
      .catch(() => { /* fail-open: keep the last verdict */ })
      .finally(() => { this._scoring = false; });
  }

  /**
   * The detector's frame-level hook: the LATEST window verdict, synchronously.
   * Never throws; false until the first window is scored (no claim without
   * data).
   * @returns {boolean}
   */
  isAgentVoiceSync() {
    return this._lastWindowVerdict;
  }

  /** Reset the rolling-window state (facade stop — no stale verdicts). */
  resetWindow() {
    this._win = [];
    this._winSamples = 0;
    this._lastWindowVerdict = false;
    this._windowScored = 0;
  }

  /**
   * Score a rolling window of mic audio (fail-open rejections propagate to
   * feed()'s catch, not into the detector).
   * @param {Float32Array} audio  16 kHz mono
   * @returns {Promise<{similarity: number, isAgent: boolean}>}
   */
  async scoreWindow(audio) {
    const verdict = await this.scoreTurn(audio);
    return verdict;
  }

  /**
   * Score one turn's audio. Fail-open: rejections propagate (the facade emits
   * the turn) — never silently eats a turn on a gate error.
   * @param {Float32Array} turnAudio  16 kHz mono turn audio
   * @returns {Promise<{similarity: number, isAgent: boolean}>}
   */
  async scoreTurn(turnAudio) {
    await this.ensureReady();
    const { feats, numFrames, numBins } = kaldiFbank(turnAudio, this._profile.sampleRate ?? 16000, { cmvn: true });
    if (numFrames < 10) return { similarity: 0, isAgent: false }; // too little audio → no claim
    const tensor = new this._ort.Tensor("float32", feats, [1, numFrames, numBins]);
    const results = await this.session.run({ feats: tensor });
    const emb = results.embs.data;
    const similarity = cosineSimilarity(emb, this._profile.embedding);
    this.scored++;
    this.lastSimilarity = similarity;
    this.similarityHistory.push(+similarity.toFixed(4));
    if (this.similarityHistory.length > 16) this.similarityHistory.shift();
    const isAgent = isAgentVoice(similarity, this.threshold);
    if (isAgent) this.dropped++;
    return { similarity, isAgent };
  }
}

/** @private concatenate Float32Arrays */
function concatFloat32(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Float32Array(total);
  let pos = 0;
  for (const a of arrays) { out.set(a, pos); pos += a.length; }
  return out;
}
