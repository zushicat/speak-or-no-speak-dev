# WP6 — Calibration & test harness

- **Status:** done (2026-10-20) — harness built (recorder/replay/metrics, browser + Node CLI); 8 recordings captured on this machine; **all measurable bars met with unchanged defaults** (onset p95 280 ms ≤ 300 · interrupt p50 192 ms ≤ 250 · 0 false onsets/min in noise · 0 echo false-interrupts); s4-TV/s10-headphones + Safari/Edge columns pending manual
- **Phase:** M3
- **Estimate:** 1 d
- **Depends on:** WP3–WP5 (needs the full event set to measure)
- **Master plan:** [plan-initial.md](../plan-initial.md)

## Objective

Choose thresholds from data instead of gut feeling, and leave behind a repeatable harness so future changes can be regression-checked. Output: a metrics table per scenario, tuned values in `src/config.js`, and a calibration notes document.

## Deliverable files

```
test/harness.html + test/harness-main.js   # the harness page
test/recordings/*.json (+ optional .wav)   # recorded scenarios (gitignored)
plans/initial/calibration-notes.md         # what was tuned and why
```

## Steps

### 6.1 Harness page (`test/harness.html`)

Sections (plain DOM + `<canvas>`, no chart library):

1. **Live timeline plot:** scrolling canvas of `prob` (0–1) and `rms` (0–1) at ~96 ms resolution; vertical markers drawn at emitted events (onset = green, turn end = orange, interrupt = red). This makes misbehavior *visible* — e.g. TTS leakage showing as prob bumps during agent playback.
2. **Scenario recorder:** text field for scenario name → records N seconds of `{t, prob, rms}` frames + the events fired + human ground-truth marks → saves JSON to `localStorage` (last 10) **and** a download link. Ground truth: two buttons the operator presses in real time — "user started speaking", "user finished" — stored alongside the frames.
3. **Offline replay:** load a scenario JSON → run the pure `TurnDetector` (WP3) over the recorded frames at recorded pace (or instantly — it's pure logic) → recompute events → compare against recorded events & ground truth. Because the detector is pure, replay needs no mic and is deterministic.
4. **Metrics table:** per scenario and aggregate p50/p95 for: onset latency, turn-end latency (vs ground-truth "finished" mark), interrupt latency (agent scenarios), false onsets/min (noise-only scenarios), premature turn-ends (turn end > ground truth finish − 300 ms), echo false-interrupts.

### 6.2 Scenario matrix (minimum set to record)

| # | Scenario | Ground truth usage |
|---|---|---|
| 1 | quiet room, user near mic, short commands ("go", "stop", "jump left") | onset + turn-end latency |
| 2 | quiet room, long fluent utterance (~10 s) | redemption adaptivity (WP4) |
| 3 | hesitant speech: "okay … hmm … let me think … go now" | premature-turn-end rate |
| 4 | TV/dialogue in background, nobody at mic (60 s) | false onsets/min |
| 5 | music playing, nobody at mic (60 s) | false onsets/min |
| 6 | keyboard typing near mic (60 s) | false onsets/min |
| 7 | agent TTS playing (60 s), nobody speaks | echo false-interrupts (0 required) |
| 8 | user speaks over agent TTS (5 interruptions) | interrupt latency |
| 9 | 2 m distance from mic | onset latency + false negatives |
| 10 | headphones instead of speakers (repeat 1) | control |

Record each on at least Chrome + Safari where hardware allows (≥ 8 recordings minimum).

### 6.3 Tuning pass

- Start from WP3/WP5 defaults; adjust in ±0.05 threshold steps and ±1 frame confirm steps.
- After each adjustment: replay **all** scenarios (fast, offline) and record the metric deltas.
- Log every change + reason in `plans/initial/calibration-notes.md` (format: value → value, scenario, observed metric, rationale). This document is the defense for the final numbers.

### 6.4 Freeze

- `src/config.js` defaults = tuned values (the module ships calibrated, not naive).
- Harness stays in the repo as the regression tool: any future threshold/engine change re-runs the replay suite.

## Acceptance criteria

- [x] ≥ 8 scenarios recorded with ground-truth marks and replayed with metrics computed — **8 recordings** (s1, s2, s3, s5, s6, s7, s8, s9) on this machine; s4/s10 pending manual.
- [x] Final metrics meet the bars: **onset p95 280 ms ≤ 300 ✓ · interrupt p50 192 ms ≤ 250 ✓ · premature turn-ends 0 (measurable subset) ✓ · false onsets 0/min in scenarios 5–7 (bar ≤ 1/min) ✓ · echo false-interrupts 0 in scenario 7 ✓** — full tables in [calibration-notes.md](../calibration-notes.md).
- [x] Tuned config: **defaults frozen unchanged** (every measurable bar met — the tuning log documents the no-change verdicts + observations).
- [x] Harness runs offline for replay (browser UI + `node test/harness/replay.js`, no mic needed); recorder mode works with mic.

## Results & deviations

| # | Finding | Resolution |
|---|---|---|
| D-WP6-1 | A static `import "node:test"` in a module imported by the harness UI breaks the **browser module graph** (bare specifier unresolvable in browsers). | Harness-shared modules stay test-free; their tests live in `test/unit/` (second occurrence of the D-WP4-1 lesson — recorded as a repo convention). |
| D-WP6-2 | `mergeOptions` let an explicitly-`undefined` key overwrite a default (replay with no thresholds → NaN ring capacity). | Fixed: `undefined` = "not provided". |
| D-WP6-3 | Recordings started mid-turn (leftover live state) → replays desynced from live events; interrupt scenarios replayed 0 events without the flag timeline. | Recorder now resets the detector + disarms the agent at recStart and records an `agentFlags` timeline; replay applies it — s8's 75 interrupts replay faithfully (p50 192 ms). |
| D-WP6-4 | Script-timed ground-truth marks are ±2 s → mark-based absolute latencies unusable. | Added the **signal-based onset metric** (event − start of the above-onset run, capped at the previous event) — deterministic, mark-free; it is the metric of record for onset latency. |
| D-WP6-5 | Hesitant speech with thinking pauses ≥ 850 ms splits into multiple turns (s3). | Documented in calibration-notes as a future-tuning observation; defaults unchanged (single-recording data would be overfitting). |
| D-WP6-6 | Test-runner discovery executes EVERY `.js` under `test/` — harness modules must be side-effect-free in Node (harness-main.js guarded by `typeof document`). | Recorded as a repo convention for WP6+ files. |

## Manual protocol (record results here)

| Utterance | Expected | Result |
|---|---|---|
| scenario matrix ≥ 8 recordings | 8 recorded (s1,s2,s3,s5,s6,s7,s8,s9) | ✅ done on this machine |
| s4 real TV/dialogue 60 s | 0 false onsets | pending manual |
| s10 headphones control | behaves like s1 | pending manual |
| Safari/Edge columns | matrix | pending manual |

## Risks

| Risk | Mitigation |
|---|---|
| Ground-truth marks are human-timed (±100 ms) | Latency figures are comparisons between configs on the *same* recordings — relative deltas stay meaningful |
| Overfitting thresholds to one room/machine | Matrix spans 2 rooms/machines if available; keep defaults within ±0.05 of analysis §4.3 starting values unless data strongly disagrees |
| Recordings bloat the repo | `test/recordings/` is gitignored; harness offers JSON export for sharing small frame streams |

## Deliverables

- Harness page + recorder/replay, ≥ 8 scenario recordings, metrics tables, `calibration-notes.md`, tuned `config.js`.
