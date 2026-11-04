#!/usr/bin/env node
/**
 * Build the agent-voice profile for the WP-E4 voice gate (offline, Node).
 *
 * Runs a speaker-embedding ONNX model (default:
 * vendor/wespeaker_en_voxceleb_resnet34.onnx — manual download, gitignored,
 * same discipline as the SmartTurnModel weights) over the agent voice sample
 * and writes the L2-normalized mean embedding to a small JSON profile.
 *
 * Usage:
 *   npm i --no-save onnxruntime-node   # once (build-time runtime)
 *   node scripts/build-agent-voice-profile.mjs [options]
 *
 * Options:
 *   --wav <path>     agent voice audio, 16 kHz mono 16-bit PCM
 *                    (default: demo/agent-voice-sample.wav)
 *   --model <path>   the ONNX speaker-embedding model
 *                    (default: vendor/wespeaker_en_voxceleb_resnet34.onnx)
 *   --out <path>     profile JSON (default: src/gate/agent-voice-profile.json)
 *   --check <path>   optional second wav (a DIFFERENT voice) — prints the
 *                    same-voice vs different-voice similarity separation so
 *                    the pipeline can be validated before committing
 *   --sample-rate <hz>  (default 16000)
 *
 * The profile JSON is committed (small); the MODEL is not (gitignored /vendor/).
 */

import { readFile, writeFile } from "node:fs/promises";
import { kaldiFbank } from "../src/gate/kaldi-fbank.js";

const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const wavPath = arg("wav", "demo/agent-voice-sample.wav");
const modelPath = arg("model", "vendor/wespeaker_en_voxceleb_resnet34.onnx");
const outPath = arg("out", "src/gate/agent-voice-profile.json");
const checkPath = arg("check", null);
const sampleRate = Number(arg("sample-rate", "16000"));

/** Minimal RIFF/PCM16 mono reader (16-bit little-endian). */
async function readPcm16(path) {
  const buf = await readFile(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmt = {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bitsPerSample: buf.readUInt16LE(pos + 22),
      };
    } else if (id === "data") {
      data = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt/data chunk`);
  if (fmt.format !== 1) throw new Error(`${path}: only PCM (format 1) supported, got ${fmt.format}`);
  if (fmt.bitsPerSample !== 16) throw new Error(`${path}: only 16-bit PCM supported, got ${fmt.bitsPerSample}`);
  if (fmt.channels !== 1) throw new Error(`${path}: only mono supported, got ${fmt.channels} channels`);
  if (fmt.sampleRate !== sampleRate) {
    throw new Error(`${path}: sample rate ${fmt.sampleRate} ≠ expected ${sampleRate} — regenerate with --data-format=LEI16@${sampleRate}`);
  }
  const n = data.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

async function embed(ort, session, samples) {
  const { feats, numFrames } = kaldiFbank(samples, sampleRate, { cmvn: true });
  if (numFrames < 10) throw new Error("too little audio (need ≥ ~100 ms)");
  const tensor = new ort.Tensor("float32", feats, [1, numFrames, 80]);
  const results = await session.run({ feats: tensor });
  const emb = results.embs.data;
  // L2-normalize (cosine similarity on the normalized vector)
  let norm = 0;
  for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i];
  norm = Math.sqrt(norm) || 1;
  const normalized = Float32Array.from(emb, (v) => v / norm);
  return normalized;
}

const ort = await import("onnxruntime-node");
const session = await ort.InferenceSession.create(modelPath, {
  executionProviders: ["cpu"],
  graphOptimizationLevel: "all",
});

const pcm = await readPcm16(wavPath);
const embedding = await embed(ort, session, pcm);

const profile = {
  format: "sons-agent-voice-profile/1",
  model: modelPath.split("/").pop(),
  dims: embedding.length,
  sampleRate,
  source: wavPath,
  builtAt: new Date().toISOString(),
  embedding: Array.from(embedding, (v) => +v.toFixed(5)),
};
await writeFile(outPath, JSON.stringify(profile, null, 2));
console.log(`profile written: ${outPath} (${embedding.length} dims, from ${wavPath})`);

if (checkPath) {
  const other = await readPcm16(checkPath);
  const otherEmb = await embed(ort, session, other);
  const sim = (a, b) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  };
  const sameVoice = sim(embedding, embedding); // self-similarity sanity = 1
  // a different SEGMENT of the same voice: re-embed the tail of the profile wav
  const tailEmb = await embed(ort, session, pcm.subarray(Math.floor(pcm.length / 2)));
  console.log(`self-similarity: ${sameVoice.toFixed(4)}`);
  console.log(`same-voice (tail segment): ${sim(embedding, tailEmb).toFixed(4)}`);
  console.log(`different-voice (${checkPath}): ${sim(embedding, otherEmb).toFixed(4)}`);
  console.log("→ separation must be clear (same ≫ different) before committing the profile.");
}
