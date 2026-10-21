/**
 * WP8 §8.1 spike (2 h timebox): load smart-turn-v3.2-cpu.onnx via ORT Web,
 * dump I/O shapes, run on a synthetic input, measure load + inference time.
 * Go criteria: inference p95 ≤ 150 ms AND session load ≤ 5 s.
 *
 * Browser-only (needs ORT + the served model); guarded for the Node test runner.
 */
if (typeof document !== "undefined" && typeof ort !== "undefined") {
  runSpike();
}

async function runSpike() {
  const out = document.getElementById("out");
  const log = (line) => { out.textContent += line + "\n"; console.log(line); };
  const MODEL_URL = "/vendor/smart-turn-v3.2-cpu.onnx";

  try {
    const t0 = performance.now();
    const session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    const loadMs = performance.now() - t0;
    log(`session load: ${loadMs.toFixed(0)} ms (go criterion: ≤ 5000 ms)`);

    // Dump I/O metadata.
    for (const input of session.inputNames) log(`input: ${input}`);
    for (const output of session.outputNames) log(`output: ${output}`);
    const meta = session.inputMetadata;
    if (meta) log(`input metadata: ${JSON.stringify(meta)}`);

    // Try the expected Whisper feature shape [1, 80, 800]; adapt on rejection.
    const candidates = [
      [1, 80, 800],   // Whisper chunk_length=8 → 800 frames × 80 mels
      [1, 80, 3000],  // standard 30 s Whisper mel
    ];
    let shape = null;
    let dummy = null;
    for (const cand of candidates) {
      const size = cand.reduce((a, b) => a * b, 1);
      const data = new Float32Array(size);
      try {
        const t1 = performance.now();
        await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", data, cand) });
        shape = cand;
        log(`accepted shape: [${cand}] (first run ${ (performance.now() - t1).toFixed(0)} ms — includes warmup)`);
        break;
      } catch (e) {
        log(`shape [${cand}] rejected: ${String(e.message).slice(0, 120)}`);
      }
    }
    if (!shape) { log("NO acceptable shape found — spike FAIL"); return; }

    // Timed inference runs (realistic-ish features: non-zero data).
    const times = [];
    const data = new Float32Array(shape.reduce((a, b) => a * b, 1));
    for (let i = 0; i < data.length; i++) data[i] = (Math.sin(i / 100) + 1) / 2 - 0.5;
    for (let i = 0; i < 20; i++) {
      const t2 = performance.now();
      const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", data, shape) };
      const results = await session.run(feeds);
      times.push(performance.now() - t2);
      if (i === 0) {
        const outName = session.outputNames[0];
        const outTensor = results[outName];
        log(`output '${outName}' shape [${outTensor.dims}] value: ${outTensor.data[0]}`);
      }
    }
    times.sort((a, b) => a - b);
    const p50 = times[Math.floor(times.length / 2)];
    const p95 = times[Math.min(times.length - 1, Math.ceil(0.95 * times.length) - 1)];
    log(`inference over ${times.length} runs: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (go criterion: ≤ 150 ms)`);
    log(`SPIKE VERDICT: ${loadMs <= 5000 && p95 <= 150 ? "GO" : "NO-GO"}`);
  } catch (err) {
    log(`SPIKE ERROR: ${err.message ?? err}`);
  }
}
