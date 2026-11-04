/**
 * WP-B2 — standalone verification consumer for the single-file bundle (rev-2
 * plan §4 WP-B2). This page imports ONLY the bundle — never `../src/` — so it
 * exercises exactly what a consumer of `build/speak-or-no-speak.*.js` gets:
 * the pinned CDN tags for the runtime deps (D2) + the bundle's 16 exports.
 *
 * Wiring only (like demo/main.js): UI mapping + event log, NO detection logic.
 *
 * Query params:
 *   (default)    ESM mode: `import("../build/speak-or-no-speak.esm.js")`
 *   ?mode=iife   IIFE mode: classic `<script>` → `window.SpeakOrNoSpeak`
 *   ?nocdn=1     OMIT the pinned CDN tags — the bundle's bare dynamic
 *                `import("@ricky0123/vad-web")` cannot resolve (F4), so the
 *                facade must degrade to the energy engine with an
 *                `engine-fallback` warning — a warning, never a crash (F5).
 *
 * Browser-only module — guarded so Node's test runner (which auto-executes
 * every .js under test/) loads it harmlessly (pattern: harness-main.js).
 */

/** The 17 named exports `src/index.js` must expose (rev-2 §2 F1 + rev-8.1 WP-E2). */
const EXPECTED_EXPORTS = [
  "CloudStubAdapter", "DEFAULTS", "EnergyVad", "ERROR_CODES", "SmartTurnModel",
  "SileroVadAdapter", "SpeakError", "SttAdapter", "TurnDetector",
  "createAgentAudioRoute", "createSpeakOrNoSpeak", "encodeWav", "encodeWavBytes",
  "energyProbability", "humanMessage", "mergeOptions", "redemptionFor",
];

function initVerifyPage() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") === "iife" ? "iife" : "esm";
  const noCdn = params.has("nocdn");

  const $ = (id) => document.getElementById(id);

  /** Timestamped event log (demo pattern), newest first, capped. */
  function logLine(text, isError = false) {
    const line = document.createElement("div");
    if (isError) line.className = "err";
    line.textContent = `${new Date().toISOString().slice(11, 23)} ${text}`;
    $("log").prepend(line);
    while ($("log").children.length > 30) $("log").lastChild.remove();
  }

  /** Load a classic script (CDN tags + the IIFE bundle) and await its load. */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`script failed to load: ${src}`));
      document.head.appendChild(el);
    });
  }

  /* --- facade handle + UI state (demo wiring, minimal) ---------------------- */

  let createSpeakOrNoSpeak;
  let encodeWav;
  let sons = null;
  let agentArmed = false;
  let frames = 0;

  const AGENT_TEXT =
    "The quick brown fox jumps over the lazy dog while the rain in Spain falls mainly on the plain. " +
    "Nobody expects the Spanish Inquisition on a Tuesday morning in the middle of October.";

  function setLabel(text) {
    $("label").textContent = text;
  }

  function disarmAgent() {
    agentArmed = false;
    sons?.setAgentSpeaking(false);
    setLabel("not listening");
    $("agent").disabled = false;
    $("agentStop").hidden = true;
  }

  /** WP5 pattern: agent talks (TTS) → user barges in → onInterrupt cancels it. */
  function simulateAgent() {
    if (!sons || agentArmed) return;
    const utter = new SpeechSynthesisUtterance(AGENT_TEXT);
    utter.rate = 0.9;
    utter.onend = () => {
      if (agentArmed) {
        disarmAgent();
        logLine("agent finished (no interrupt)");
      }
    };
    speechSynthesis.cancel();
    speechSynthesis.speak(utter);
    agentArmed = true;
    sons.setAgentSpeaking(true);
    setLabel("agent speaking… (interruptable)");
    $("agent").disabled = true;
    $("agentStop").hidden = false;
  }

  function stopAgent() {
    speechSynthesis.cancel();
    if (agentArmed) disarmAgent();
  }

  /* --- bundle loading (the actual WP-B2 subject) ---------------------------- */

  /**
   * Load runtime deps + the bundle per mode. Returns nothing — assigns the
   * module-level `createSpeakOrNoSpeak` / `encodeWav` handles.
   */
  async function loadBundle() {
    if (!noCdn) {
      // Same pinned tags as index.html/demo — the documented consumer setup.
      await Promise.all([
        loadScript("https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"),
        loadScript("https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"),
      ]);
      logLine("CDN tags loaded — onnxruntime-web 1.22.0 + vad-web 0.0.31");
    } else {
      logLine("?nocdn=1 — CDN tags omitted (expecting energy fallback)", true);
    }

    /** @type {Record<string, any>} */
    let bundle;
    if (mode === "esm") {
      bundle = await import("../build/speak-or-no-speak.esm.js");
      logLine("ESM bundle imported — ../build/speak-or-no-speak.esm.js");
    } else {
      await loadScript("../build/speak-or-no-speak.iife.js");
      bundle = window.SpeakOrNoSpeak;
      if (!bundle) throw new Error("window.SpeakOrNoSpeak missing after IIFE script load");
      logLine("IIFE bundle loaded — global window.SpeakOrNoSpeak");
    }

    // Import-surface check against src/index.js's contract (plan §2 F1).
    const names = Object.keys(bundle).sort();
    const expected = [...EXPECTED_EXPORTS].sort();
    const ok = names.length === expected.length && names.every((n, i) => n === expected[i]);
    $("meta").textContent =
      `mode=${mode} · cdn=${noCdn ? "omitted" : "on"} · exports ${names.length}/${EXPECTED_EXPORTS.length} ${ok ? "OK" : "MISMATCH"}`;
    if (!ok) logLine(`export surface MISMATCH: ${names.join(", ")}`, true);

    createSpeakOrNoSpeak = bundle.createSpeakOrNoSpeak;
    encodeWav = bundle.encodeWav;
  }

  /* --- mic lifecycle --------------------------------------------------------- */

  async function startMic() {
    if (sons) return;
    $("start").disabled = true;
    $("err").textContent = "";
    setLabel("starting…");
    try {
      sons = await createSpeakOrNoSpeak({
        onSpeechStart: () => {
          document.body.classList.add("listening");
          setLabel(agentArmed ? "agent speaking… (interruptable)" : "listening");
          logLine("onSpeechStart");
        },
        onTurnEnd: (e) => {
          document.body.classList.remove("listening");
          setLabel(agentArmed ? "agent speaking… (interruptable)" : "not listening");
          logLine(
            `onTurnEnd ${(e.durationMs / 1000).toFixed(1)} s` +
            (e.truncated ? " (truncated)" : "") +
            (e.afterInterrupt ? " (afterInterrupt)" : "") +
            ` · pauses=${e.stats?.interiorPauses ?? "?"}`
          );
          // WP-B2 save-link check: encodeWav comes FROM THE BUNDLE.
          const save = $("save");
          if (save.href) URL.revokeObjectURL(save.href);
          save.href = URL.createObjectURL(encodeWav(e.audio, 16000));
          save.hidden = false;
        },
        onInterrupt: (info) => {
          logLine(`onInterrupt atMs=${info.atMs} latencyMs=${info.latencyMs}`);
          speechSynthesis.cancel();
          disarmAgent();
        },
        onLevel: (rms) => {
          frames++;
          $("level").textContent = `onLevel rms=${rms.toFixed(3)} · frames=${frames}`;
        },
        onError: (err) => logLine(`onError ${err.code}: ${err.message}`, true),
      });
      window.__sons = sons; // debug handle (tooling — same pattern as demo/main.js)
      await sons.start();

      const processor = sons._engine?.processorTypeUsed ? ` · processor=${sons._engine.processorTypeUsed}` : "";
      logLine(`start() ok — state=${sons.state} · degraded=${JSON.stringify(sons.degraded)}${processor}`);
      // Acceptance expectations per mode (WP-B2).
      if (!noCdn && sons.degraded.engine !== "silero") {
        logLine("FAIL: expected degraded.engine === 'silero' with CDN tags present", true);
      }
      if (noCdn && sons.degraded.engine !== "energy") {
        logLine("FAIL: expected degraded.engine === 'energy' with ?nocdn=1", true);
      }
      if (sons.degraded.aec) $("err").textContent = "no-aec: stricter barge-in gating active";

      setLabel("not listening");
      $("start").hidden = true;
      $("stop").hidden = false;
      $("agentRow").hidden = false;
    } catch (err) {
      logLine(`start() failed: ${err?.message ?? err}`, true);
      setLabel("press start");
      $("start").disabled = false;
    }
  }

  function stopMic() {
    if (!sons) return;
    stopAgent();
    sons.stop();
    logLine(`stop() — state=${sons.state}`);
    sons = null;
    frames = 0;
    $("level").textContent = "—";
    document.body.classList.remove("listening");
    setLabel("press start");
    $("stop").hidden = true;
    $("start").hidden = false;
    $("start").disabled = false;
    $("agentRow").hidden = true;
  }

  /* --- boot ------------------------------------------------------------------ */

  $("start").addEventListener("click", startMic);
  $("stop").addEventListener("click", stopMic);
  $("agent").addEventListener("click", simulateAgent);
  $("agentStop").addEventListener("click", stopAgent);

  loadBundle()
    .then(() => setLabel("press start"))
    .catch((err) => {
      // Render, never throw — an unhandled rejection would count as a console
      // error and fail the WP-B2 acceptance ("no console errors").
      logLine(`bundle load failed: ${err?.message ?? err}`, true);
      setLabel("bundle load failed");
    });
}

if (typeof document === "undefined") {
  // Node (test-runner import): browser page — nothing to do.
} else {
  initVerifyPage();
}
