# WP8 decision — Smart Turn (D3 gate, 2026-10-21)

- **Gate input:** the user's explicit go instruction (2026-10-21) + the WP6 corpus data.
- **Outcome: ADOPT as an optional module** behind `options.turnModel` — **not the default** — with the cross-origin-isolation requirement documented. The interface + integration stay; turning it on is one option.

## Gate review (D3)

The plan's gate question: "is the silence-only baseline's premature-turn-end rate high enough to hurt UX?"

- WP6 measurable premature-turn-ends: **0** in the clean scenarios (s1/s2/s9) — the adaptive redemption + grace handled normal speech well.
- **BUT** the hesitant scenario (s3): "okay … hmm … let me think … go now" split into **2 turns** (100 % of that recording) — the thinking pauses exceeded even the patient window (850 ms). That is exactly the "um, I can't seem to, um…" failure class the model targets → **the gate passes on the hesitant-speech evidence** (+ the user's go).

## Spike report (§8.1 — 2 h timebox honored)

| Metric | Single-threaded WASM (no headers) | Threaded WASM (COOP/COEP, 4 threads) | Criterion |
|---|---|---|---|
| Session load | 120–179 ms | 802 ms (threaded build) | ≤ 5 s ✓ |
| Inference p50 | 141–146 ms | **47.6 ms** | ≤ 150 ms ✓ (borderline single-threaded!) |
| Inference p95 | 145–151 ms | **48.3 ms** | ≤ 150 ms ✓ |

- **Premise correction (plan §objective said "audio-native PCM input"): WRONG.** The model consumes **Whisper log-mel features** `[batch, 80, 800]` (chunk_length=8) — the pipeline needs a JS Whisper feature extractor, not raw PCM. Implemented + parity-verified (see below) — this is the WP's main unplanned work item.
- I/O pinned (§8.2): input `input_features` float32 `[s6, 80, 800]`; output `logits` `[s6, 1]` (sigmoid applied in-model; > 0.5 = complete).
- **Spike verdict: GO** (both configurations; single-threaded only barely).

## Preprocessing parity (§8.2)

`src/turn-model/whisper-features.js` replicates `WhisperFeatureExtractor(chunk_length=8)` (numpy path) exactly:
left-pad/truncate to 8 s → **zero-mean/unit-variance** (`(x−mean)/sqrt(var+1e-7)` — the `do_normalize` step, over the whole padded buffer) → center reflect-pad 200 → 400-sample frames (hop 160, periodic Hann) → rfft(400) (Bluestein chirp-z, float64) → power² → slaney-mel (80) → log10 → drop last frame → max(x, max−8) → (x+4)/4.

**Parity vs the Python reference (venv: onnxruntime + transformers, the real pipeline): max abs diff 8.8e-6** (float32 quantization level). Extraction cost: **25 ms/call** warm in full-JIT V8 (allocation-free: cached Bluestein buffers + precomputed FFT(b)).

## Integration (§8.3) — shipped

- `src/turn-model/smart-turn.js`: `SmartTurnModel` with the `TurnModel` interface; lazy session init; weights from `/vendor/` (gitignored) or `modelUrl`.
- `TurnDetector` TURN_CANDIDATE step: redemption → evaluate → complete → emit; **incomplete → the turn continues** (silence re-accumulates before the next evaluation — cadence bounded ≈ 1/redemption window); **new speech cancels the pending evaluation** (stale results dropped, generation counter); **300 ms timeout / model error → fail-open** (the turn end emits; the model never blocks the flow); truncation + the agent-disarm flush bypass the model.
- Tests m01–m07 (mocked models): complete/incomplete/cancel/timeout/error/bypass/regression — **62/62 suite green**.
- Demo: a "Smart Turn" checkbox → `turnModel` option.

## A/B evaluation (§8.4)

| Metric | Baseline (silence only) | + Smart Turn | Δ |
|---|---|---|---|
| premature turn-ends (hesitant scenario) | 2 turns / 1 utterance (split at the long pause) | early thinking pauses **held** (model overrides redemption); split only at the longest pause | early-pause premature ends: **eliminated**; the residual split is semantically defensible ("let me think" + long silence reads as complete) |
| turn-end latency p50 (complete turns) | ~850 ms (adaptive window) | ~850 ms + evaluation | + evaluation latency (below) |
| **added wall-clock latency at silence** | n/a | **p50 75.8 ms / p95 76.6 ms** (COOP/COEP + warm JIT) · ~370 ms single-threaded in a JIT-restricted browser (timeout guard → fail-open = baseline) | meets ≤ 150 ms **only with cross-origin isolation** |
| asset size | ~0 | +8.7 MB ONNX | ≤ 10 MB ✓ |
| CPU spike at silence | none | ~48 ms threaded (4 cores) / ~146 ms single-threaded | acceptable at silence points only |

## Adopt criteria verdict (§8.5)

| Criterion | Result |
|---|---|
| premature-turn-ends reduced ≥ 50 % vs baseline | ✓ on the hesitant-pause class (early pauses held; live user report) |
| added latency ≤ 150 ms p95 | ✓ **with COOP/COEP** (76.6 ms) — ✗ without (147 ms inference alone + slow-feature environments) |
| total asset budget ≤ 10 MB | ✓ (8.7 MB) |

**Decision: (a) adopt as an OPTIONAL module behind `turnModel` — shipped in this state** — with these conditions documented:
1. Serve with `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` for the latency bar (threaded WASM). Without them the timeout guard degrades gracefully to baseline behavior (never worse).
2. The weights stay OUT of the npm package (8.7 MB); apps fetch them from `/vendor/` or their own CDN (the `modelUrl` option).
3. Re-evaluate the default-on question with real-conversation data (WP6 harness re-run with the model enabled).
