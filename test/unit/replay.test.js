/** WP6 — replay module smoke test (kept out of replay.js: bare "node:test"
 *  imports break the browser module graph — see D-WP4-1 lesson). */
import test from "node:test";
import assert from "node:assert/strict";
import { replayScenario, computeMetrics, aggregateMetrics } from "../harness/replay.js";

test("replay: deterministic events + metrics from a synthetic recording", () => {
  const frames = [];
  // 1 s silence, 0.5 s speech, 2 s silence
  for (let i = 0; i < 31; i++) frames.push({ t: i * 32, prob: 0.01, rms: 0.001 });
  for (let i = 0; i < 16; i++) frames.push({ t: 992 + i * 32, prob: 0.95, rms: 0.05 });
  for (let i = 0; i < 63; i++) frames.push({ t: 1504 + i * 32, prob: 0.01, rms: 0.001 });
  const recording = {
    name: "smoke", createdAt: 0, browser: "node", noaec: false,
    frames,
    events: [],
    marks: [{ kind: "speech-start", t: 1000 }, { kind: "speech-end", t: 1500 }],
  };
  const { events } = replayScenario(recording);
  assert.equal(events.filter(e => e.kind === "onSpeechStart").length, 1);
  assert.equal(events.filter(e => e.kind === "onTurnEnd").length, 1);
  const metrics = computeMetrics(events, recording.marks, 3500);
  assert.equal(metrics.onsetLatenciesMs.length, 1);
  assert.ok(metrics.onsetLatenciesMs[0] >= 0 && metrics.onsetLatenciesMs[0] <= 500);
  assert.equal(metrics.prematureTurnEnds, 0);
  const agg = aggregateMetrics([{ name: "smoke", metrics, durationMs: 3500 }]);
  assert.ok(agg.onset.p50 !== null);
});
