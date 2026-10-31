/**
 * Demo wiring — UI MAPPING ONLY (WP3/WP4/WP5/WP9). Contains NO detection
 * logic: all onset/turn/barge-in decisions live in the facade's TurnDetector;
 * this file maps facade events → DOM, toggles the microphone, and plays an
 * ambient background track for noise-robustness testing.
 */
import { createSpeakOrNoSpeak, humanMessage, SmartTurnModel } from "../src/index.js";
import { CloudStubAdapter } from "../src/stt/cloud-stub-adapter.js";

const button = document.getElementById("start");
const label = document.getElementById("label");
const errEl = document.getElementById("err");
const dbg = document.getElementById("dbg");
const smartTurn = document.getElementById("smartTurn");
const transcribeToggle = document.getElementById("transcribe");
const sttEndpoint = document.getElementById("sttEndpoint");
const sttRow = document.getElementById("sttRow");
const logEl = document.getElementById("log");
const bgSound = document.getElementById("bgSound");
const bgToggle = document.getElementById("bgToggle");
const bgVolume = document.getElementById("bgVolume");
const bgVolumeValue = document.getElementById("bgVolumeValue");

let sons = null;
let micRunning = false;
let micBusy = false;

/** Cached across start/stop cycles — the ONNX session loads once. */
let smartTurnModel = null;

/** One looping media element for the ambient background bed. */
const bgAudio = new Audio();
bgAudio.loop = true;
bgAudio.preload = "auto";
let bgPlaying = false;
let bgBusy = false;
let bgTrack = "";

/** Timestamped event log (WP9 demo: transcription results + errors). */
function logLine(text, isError = false) {
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = `${new Date().toISOString().slice(11, 23)} ${text}`;
  logEl.prepend(line);
  while (logEl.children.length > 20) logEl.lastChild.remove();
}

/** WP9: STT strictly outside the real-time loop — called from onTurnEnd only,
 *  fire-and-forget with a catch; failures never touch detection events. */
function transcribeTurn(audio) {
  if (!transcribeToggle.checked || !sttEndpoint.value.trim()) return;
  try {
    const adapter = new CloudStubAdapter({ endpoint: sttEndpoint.value.trim() });
    adapter.transcribe(audio)
      .then((t) => logLine(`💬 "${t.text}"${t.confidence !== undefined ? ` (${(t.confidence * 100).toFixed(0)}%)` : ""}`))
      .catch((err) => logLine(`STT failed: ${err.message}`, true));
  } catch (err) {
    logLine(`STT setup failed: ${err.message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Background sound (ambient noise — deliberately NOT setAgentSpeaking: it is
// supposed to reach the detector so the demo can be tested under noise).
// ---------------------------------------------------------------------------

/** Map the 0–100 slider to the media element's linear 0–1 volume. */
function syncBgVolume() {
  const percent = Number(bgVolume.value);
  bgAudio.volume = percent / 100;
  bgVolumeValue.textContent = `${percent} %`;
}

/** Rewind only when metadata is available: setting currentTime at
 *  readyState HAVE_NOTHING throws in Chromium. */
function rewindBackground() {
  if (bgAudio.readyState > 0) bgAudio.currentTime = 0;
}

function setBgUi(playing) {
  bgPlaying = playing;
  bgToggle.textContent = playing ? "Stop background sound" : "Start background sound";
  bgToggle.setAttribute("aria-pressed", String(playing));
}

async function startBackground() {
  if (bgPlaying || bgBusy) return;
  const src = bgSound.value;
  if (!src) return;
  bgBusy = true;
  bgToggle.disabled = true;
  bgSound.disabled = true;
  try {
    if (bgTrack !== src) {
      bgTrack = src;
      bgAudio.src = src;
    }
    rewindBackground();
    syncBgVolume();
    await bgAudio.play();
    setBgUi(true);
    logLine(`🔊 background: ${bgSound.selectedOptions[0]?.textContent ?? src}`);
  } catch (err) {
    setBgUi(false);
    logLine(`Background sound failed: ${err?.message ?? err}`, true);
  } finally {
    bgBusy = false;
    bgToggle.disabled = false;
    bgSound.disabled = false;
  }
}

function stopBackground() {
  bgAudio.pause();
  rewindBackground();
  setBgUi(false);
}

// ---------------------------------------------------------------------------
// Microphone start/stop toggle
// ---------------------------------------------------------------------------

async function toggleMicrophone() {
  if (micBusy) return;
  if (micRunning) {
    stopMicrophone();
    return;
  }
  micBusy = true;
  button.disabled = true;
  try {
    await startMicrophone();
  } finally {
    micBusy = false;
    button.disabled = false;
  }
}

async function startMicrophone() {
  errEl.textContent = "";
  label.textContent = "starting…";

  // WP5 §5.4: `?noaec=1` forces echoCancellation off to exercise the
  // no-AEC fallback branch on any machine.
  const forceNoAec = new URLSearchParams(location.search).has("noaec");
  const mic = forceNoAec ? { echoCancellation: false } : undefined;

  // WP8: optional semantic end-of-turn model (checkbox; +8 MB asset). One
  // instance is cached so start/stop cycles do not reload the ONNX session.
  if (smartTurn.checked && !smartTurnModel) smartTurnModel = new SmartTurnModel();

  let instance = null;
  try {
    instance = await createSpeakOrNoSpeak({
      mic,
      turnModel: smartTurn.checked ? smartTurnModel : undefined,
      onSpeechStart: () => {
        document.body.classList.add("listening");
        label.textContent = "listening";
      },
      onTurnEnd: (e) => {
        document.body.classList.remove("listening");
        label.textContent = "not listening";
        // turn-finished log line (WP2 behavior spec)
        dbg.textContent = `turn: ${(e.durationMs / 1000).toFixed(1)} s` +
          (e.truncated ? " (truncated)" : "") + (e.afterInterrupt ? " (after interrupt)" : "");
        transcribeTurn(e.audio); // WP9 plug point — never affects detection
      },
      // S3 (WP5): kept for completeness; the demo no longer drives TTS.
      onInterrupt: (info) => {
        dbg.textContent = `interrupt after ${info.atMs} ms (latency ${info.latencyMs} ms)`;
        logLine(`barge-in after ${info.atMs} ms (latency ${info.latencyMs} ms)`);
      },
      onLevel: () => {},
      onError: onError,
      debug: false,
    });
    await instance.start();
    sons = instance;
    window.__sons = instance; // debug handle (tooling)
    micRunning = true;
    button.textContent = "Stop microphone";
    button.setAttribute("aria-pressed", "true");
    smartTurn.disabled = true;
    sttRow.hidden = false;
    label.textContent = "not listening";
    if (forceNoAec || instance.degraded.aec) {
      errEl.textContent = humanMessage("no-aec");
    }
    if (instance.degraded.engine === "energy") {
      errEl.textContent = humanMessage("engine-fallback");
    }
  } catch (err) {
    // onError may already have rendered the message; otherwise show it here.
    try { instance?.stop(); } catch { /* already torn down */ }
    sons = null;
    window.__sons = null;
    micRunning = false;
    button.textContent = "Start microphone";
    button.setAttribute("aria-pressed", "false");
    smartTurn.disabled = false;
    label.textContent = "press start";
    if (!errEl.textContent) {
      errEl.textContent = err?.code
        ? humanMessage(err.code)
        : `Error: ${err?.message ?? err}`;
    }
  }
}

function stopMicrophone() {
  try {
    sons?.stop();
  } catch (err) {
    logLine(`stop failed: ${err?.message ?? err}`, true);
  }
  sons = null;
  window.__sons = null;
  micRunning = false;
  document.body.classList.remove("listening");
  button.textContent = "Start microphone";
  button.setAttribute("aria-pressed", "false");
  smartTurn.disabled = false;
  label.textContent = "press start";
  dbg.textContent = "";
  errEl.textContent = "";
}

function onError(err) {
  errEl.textContent = humanMessage(err.code) ?? `Error (${err.code}): ${err.message}`;
  // eslint-disable-next-line no-console
  console.error("[sons] onError:", err);
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

button.addEventListener("click", toggleMicrophone);

bgToggle.addEventListener("click", () => {
  if (bgPlaying) stopBackground();
  else startBackground();
});

bgSound.addEventListener("change", () => {
  if (!bgPlaying) return;
  stopBackground();
  startBackground();
});

bgVolume.addEventListener("input", syncBgVolume);
syncBgVolume();

bgAudio.addEventListener("error", () => {
  setBgUi(false);
  logLine(`Background sound failed to load: ${bgAudio.error?.message ?? "unknown media error"}`, true);
});

// Release the mic and stop audio when the page is left (reload / bfcache).
window.addEventListener("pagehide", () => {
  stopMicrophone();
  stopBackground();
});
