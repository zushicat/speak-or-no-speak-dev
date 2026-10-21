/**
 * Offline replay + metrics for calibration scenarios (WP6).
 *
 * A recording is `{ name, createdAt, browser, noaec, frames, events, marks }`:
 * - frames: `[{t, prob, rms}]` — t = ms since record start (recorded from the
 *   live detector's input stream, so replay is deterministic)
 * - events: `[{kind, t, ...}]` — what the LIVE detector emitted
 * - marks:   `[{kind: "speech-start"|"speech-end", t}]` — ground truth
 *
 * Replay feeds the pure `TurnDetector` over the frames (instant, no mic) with
 * the CURRENT config and recomputes events — the regression tool: same
 * recording + new config → new events → new metrics.
 *
 * Browser-safe at module level (the harness imports it); the Node CLI is
 * behind a main-guard because Node's test runner executes every `.js` under
 * `test/` — including this file (it carries its own smoke test below).
 *
 * @module replay
 */

import { TurnDetector } from "../../src/turn/turn-detector.js";

/** Frame size used to synthesize detector input audio (content is irrelevant; only prob/rms/duration drive the machine). */
export const REPLAY_FRAME_SAMPLES = 512;
export const REPLAY_SAMPLE_RATE = 16000;

/**
 * Replay a recording through a fresh TurnDetector.
 * @param {{frames: Array<{t:number, prob:number, rms:number}>, marks?: Array, events?: Array,
 *           agentFlags?: Array<{t:number, active:boolean}>}} recording
 * @param {import("../../src/types.js").Thresholds} [thresholds] current config (defaults if omitted)
 * @returns {{events: Array<{kind:string,t:number,latencyMs?:number,durationMs?:number,truncated?:boolean,afterInterrupt?:boolean}>, stateTrace: Array}}
 */
export function replayScenario(recording, thresholds) {
  const detector = new TurnDetector({ thresholds, sampleRate: REPLAY_SAMPLE_RATE });
  const events = [];
  detector.onSpeechStart = () => events.push({ kind: "onSpeechStart", t: detector._audioMs });
  detector.onTurnEnd = (e) => events.push({
    kind: "onTurnEnd", t: detector._audioMs,
    durationMs: e.durationMs, truncated: e.truncated, afterInterrupt: e.afterInterrupt, stats: e.stats,
  });
  detector.onInterrupt = (i) => events.push({ kind: "onInterrupt", t: detector._audioMs, latencyMs: i.latencyMs, atMs: i.atMs });
  const silence = new Float32Array(REPLAY_FRAME_SAMPLES);
  const flags = [...(recording.agentFlags ?? [])].sort((a, b) => a.t - b.t);
  let flagIdx = 0;
  for (const f of recording.frames) {
    // apply the recorded agent-flag timeline (interrupt scenarios)
    while (flagIdx < flags.length && flags[flagIdx].t <= f.t) {
      detector.setAgentSpeaking(flags[flagIdx].active);
      flagIdx++;
    }
    detector.onFrame({
      probability: f.prob,
      frame: silence,
      rms: f.rms ?? 0,
      durationMs: (REPLAY_FRAME_SAMPLES / REPLAY_SAMPLE_RATE) * 1000, // 32 ms
    });
  }
  return { events, stateTrace: detector.traces ?? [] };
}

/**
 * Compute metrics for one recording: replayed events vs ground-truth marks
 * AND vs the probability signal itself (mark-free, deterministic).
 * @param {Array<{kind:string,t:number,...}>} events   replayed events (t in detector audio-ms)
 * @param {Array<{kind:string,t:number}>} marks        ground truth (t = wall ms since record start)
 * @param {number} durationMs                          recording duration
 * @param {Array<{t:number, prob:number}>} [frames]    recorded probability signal
 * @returns {{onsetLatenciesMs:number[], onsetSignalLatenciesMs:number[], turnEndLatenciesMs:number[],
 *            interruptLatenciesMs:number[], falseOnsets:number, prematureTurnEnds:number,
 *            unmatchedTurnEnds:number}}
 */
export function computeMetrics(events, marks, durationMs, frames) {
  const starts = marks.filter(m => m.kind === "speech-start").map(m => m.t);
  const ends = marks.filter(m => m.kind === "speech-end").map(m => m.t);

  const onsetLatenciesMs = [];
  const speechStarts = events.filter(e => e.kind === "onSpeechStart");
  for (const e of speechStarts) {
    const candidates = starts.filter(t => Math.abs(t - e.t) <= 1500);
    const nearest = candidates.length
      ? candidates.reduce((a, b) => (Math.abs(b - e.t) < Math.abs(a - e.t) ? b : a))
      : null;
    if (nearest !== null) onsetLatenciesMs.push(e.t - nearest);
  }

  // Signal-based onset latency: event time − the START of the contiguous
  // above-onset run leading to the event (mark-free, deterministic). The
  // walk-back never crosses a previous event (continuous speech across a
  // turn boundary would otherwise inflate the run).
  const onsetSignalLatenciesMs = [];
  if (frames?.length) {
    for (const e of speechStarts) {
      const prevEventT = Math.max(-1, ...events.filter(x => x.t < e.t).map(x => x.t));
      let idx = frames.length - 1;
      while (idx >= 0 && frames[idx].t > e.t) idx--;
      let runStart = null;
      while (idx >= 0 && frames[idx].prob >= 0.6 && frames[idx].t > prevEventT) {
        runStart = frames[idx].t;
        idx--;
      }
      if (runStart !== null) onsetSignalLatenciesMs.push(e.t - runStart);
    }
  }

  const turnEndLatenciesMs = [];
  let prematureTurnEnds = 0;
  let unmatchedTurnEnds = 0;
  for (const e of events.filter(e => e.kind === "onTurnEnd")) {
    const prior = ends.filter(t => t <= e.t + 50);
    if (prior.length === 0) { unmatchedTurnEnds++; continue; }
    const mark = prior[prior.length - 1];
    const latency = e.t - mark;
    if (latency < -300) prematureTurnEnds++;
    else turnEndLatenciesMs.push(latency);
  }

  const interruptLatenciesMs = events.filter(e => e.kind === "onInterrupt").map(e => e.latencyMs ?? 0);
  const falseOnsets = speechStarts.filter(e => !starts.some(t => Math.abs(t - e.t) <= 1500)).length;

  return { onsetLatenciesMs, onsetSignalLatenciesMs, turnEndLatenciesMs, interruptLatenciesMs, falseOnsets, prematureTurnEnds, unmatchedTurnEnds };
}

/**
 * Aggregate per-scenario metrics into p50/p95 figures.
 * @param {Array<{name: string, metrics: ReturnType<typeof computeMetrics>, durationMs: number}>} scenarios
 */
export function aggregateMetrics(scenarios) {
  const pct = (arr, p) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
  };
  const all = (key) => scenarios.flatMap(s => s.metrics[key]);
  const noiseScenarios = scenarios.filter(s => s.metrics.falseOnsets !== undefined);
  const totalFalseOnsets = scenarios.reduce((a, s) => a + s.metrics.falseOnsets, 0);
  const totalNoiseMinutes = scenarios
    .filter(s => s.metrics.onsetLatenciesMs.length === 0) // noise-only scenarios have no matched onsets
    .reduce((a, s) => a + s.durationMs / 60000, 0);
  return {
    onset: { p50: pct(all("onsetLatenciesMs"), 50), p95: pct(all("onsetLatenciesMs"), 95), n: all("onsetLatenciesMs").length },
    onsetSignal: { p50: pct(all("onsetSignalLatenciesMs"), 50), p95: pct(all("onsetSignalLatenciesMs"), 95), n: all("onsetSignalLatenciesMs").length },
    turnEnd: { p50: pct(all("turnEndLatenciesMs"), 50), p95: pct(all("turnEndLatenciesMs"), 95), n: all("turnEndLatenciesMs").length },
    interrupt: { p50: pct(all("interruptLatenciesMs"), 50), p95: pct(all("interruptLatenciesMs"), 95), n: all("interruptLatenciesMs").length },
    prematureTurnEnds: scenarios.reduce((a, s) => a + s.metrics.prematureTurnEnds, 0),
    totalTurnEnds: scenarios.reduce((a, s) => a + s.metrics.turnEndLatenciesMs.length, 0),
    falseOnsetsPerMin: totalNoiseMinutes > 0 ? +(totalFalseOnsets / totalNoiseMinutes).toFixed(2) : null,
    totalFalseOnsets,
  };
}

// ---------------------------------------------------------------------------
// CLI: `node test/harness/replay.js test/recordings/*.json` — prints the
// metrics table. Only runs when this file IS the entry point; the guard uses
// dynamic imports so the browser (harness UI) never loads Node builtins.
// ---------------------------------------------------------------------------
if (typeof process !== "undefined" && process.argv?.[1]) {
  const { pathToFileURL } = await import("node:url");
  if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const fs = await import("node:fs/promises");
    const files = process.argv.slice(2);
    if (files.length === 0) {
      console.log("usage: node test/harness/replay.js <recording.json> [...]");
    } else {
      const scenarios = [];
      for (const file of files) {
        const rec = JSON.parse(await fs.readFile(file, "utf8"));
        const { events } = replayScenario(rec);
        const durationMs = rec.frames[rec.frames.length - 1]?.t ?? 0;
        const metrics = computeMetrics(events, rec.marks ?? [], durationMs, rec.frames);
        scenarios.push({ name: rec.name ?? file, metrics, durationMs });
        console.log(`\n${rec.name ?? file}:`);
        console.log(`  onsets: ${metrics.onsetLatenciesMs.length} matched, latencies [${metrics.onsetLatenciesMs.join(", ")}] ms`);
        console.log(`  turnEnds: ${metrics.turnEndLatenciesMs.length} matched [${metrics.turnEndLatenciesMs.join(", ")}] ms, premature ${metrics.prematureTurnEnds}, unmatched ${metrics.unmatchedTurnEnds}`);
        console.log(`  interrupts: ${metrics.interruptLatenciesMs.length} [${metrics.interruptLatenciesMs.join(", ")}] ms`);
        console.log(`  falseOnsets: ${metrics.falseOnsets}`);
      }
      console.log("\nAGGREGATE:", JSON.stringify(aggregateMetrics(scenarios), null, 2));
    }
  }
}

// NOTE: no `node:test` import here — a bare specifier would break the browser
// module graph (the harness UI imports this file). Its smoke test lives in
// test/unit/replay.test.js; the CLI guard above uses dynamic imports only.
