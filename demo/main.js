/**
 * Demo wiring — UI MAPPING ONLY (WP3/WP4/WP5). Contains NO detection logic:
 * all onset/turn/barge-in decisions live in the facade's TurnDetector; this
 * file maps facade events → DOM and simulates an agent via speechSynthesis.
 */
import { createSpeakOrNoSpeak, humanMessage, SmartTurnModel } from "../src/index.js";
import { encodeWav } from "../src/wav-export.js";
import { CloudStubAdapter } from "../src/stt/cloud-stub-adapter.js";

const button = document.getElementById("start");
const label = document.getElementById("label");
const errEl = document.getElementById("err");
const dbg = document.getElementById("dbg");
const saveLink = document.getElementById("save");
const agentRow = document.getElementById("agentRow");
const agentButton = document.getElementById("agent");
const agentStopButton = document.getElementById("agentStop");
const ttsVol = document.getElementById("ttsVol");
const transcribeToggle = document.getElementById("transcribe");
const sttEndpoint = document.getElementById("sttEndpoint");
const sttRow = document.getElementById("sttRow");
const logEl = document.getElementById("log");
let lastTurnUrl = null;

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

/** WP5 §5.2: collected interrupt latencies (t_voice → t_event), for the results table. */
const agentLog = { latenciesMs: [], interrupts: 0 };
window.__agentLog = agentLog; // tooling handle

button.addEventListener("click", startMic);
agentButton.addEventListener("click", simulateAgent);
agentStopButton.addEventListener("click", stopAgent);

/** Long filler text — takes ~40 s at rate 0.9. */
const LONG_TEXT = (
  "The quick brown fox jumps over the lazy dog while the rain in Spain falls mainly on the plain. " +
  "Nobody expects the Spanish Inquisition on a Tuesday morning in the middle of October. " +
  "It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness. " +
  "To be or not to be, that is the question, whether tis nobler in the mind to suffer the slings and arrows of outrageous fortune. " +
  "The answers are out there, floating in the ether, waiting for someone to ask the right questions. "
).repeat(3);

let sons = null;
let agentArmed = false;

async function startMic() {
  button.disabled = true;
  errEl.textContent = "";
  label.textContent = "starting…";

  // WP5 §5.4: `?noaec=1` forces echoCancellation off to exercise the
  // no-AEC fallback branch on any machine.
  const forceNoAec = new URLSearchParams(location.search).has("noaec");
  const mic = forceNoAec ? { echoCancellation: false } : undefined;

  // WP8: optional semantic end-of-turn model (checkbox; +8 MB asset).
  const turnModel = document.getElementById("smartTurn")?.checked
    ? new SmartTurnModel()
    : undefined;

  sons = await createSpeakOrNoSpeak({
    mic,
    turnModel,
    onSpeechStart: () => {
      document.body.classList.add("listening");
      label.textContent = agentArmed ? "agent speaking… (interruptable)" : "listening";
    },
    onTurnEnd: (e) => {
      document.body.classList.remove("listening");
      label.textContent = agentArmed ? "agent speaking… (interruptable)" : "not listening";
      // turn-finished log line (WP2 behavior spec)
      dbg.textContent = `turn: ${(e.durationMs / 1000).toFixed(1)} s` +
        (e.truncated ? " (truncated)" : "") + (e.afterInterrupt ? " (after interrupt)" : "");
      // WP4: downloadable WAV of the turn — the primary tool for checking
      // onset clipping / pad length by ear.
      if (lastTurnUrl) URL.revokeObjectURL(lastTurnUrl);
      const blob = encodeWav(e.audio, 16000);
      lastTurnUrl = URL.createObjectURL(blob);
      saveLink.href = lastTurnUrl;
      saveLink.hidden = false;
      transcribeTurn(e.audio); // WP9 plug point — never affects detection
    },
    // S3 (WP5): barge-in while the agent speaks → cancel TTS immediately.
    onInterrupt: (info) => {
      agentLog.interrupts++;
      agentLog.latenciesMs.push(info.latencyMs);
      speechSynthesis.cancel();
      disarmAgent();
      dbg.textContent = `interrupt after ${info.atMs} ms (latency ${info.latencyMs} ms)`;
      console.log(`[sons] INTERRUPT after ${info.atMs} ms armed, latency ${info.latencyMs} ms`);
    },
    onLevel: () => {},
    onError: onError,
    debug: false,
  });
  window.__sons = sons; // debug handle (tooling)

  try {
    await sons.start();
    label.textContent = "not listening";
    button.hidden = true;
    agentRow.hidden = false;
    sttRow.hidden = false;
    if (forceNoAec || sons.degraded.aec) {
      errEl.textContent = humanMessage("no-aec");
    }
    if (sons.degraded.engine === "energy") {
      errEl.textContent = humanMessage("engine-fallback");
    }
  } catch {
    // onError already rendered the message; restore usability for a retry.
    button.disabled = false;
    label.textContent = "press start";
  }
}

/** WP5 §5.1: simulate an agent answer through the browser's audio path. */
function simulateAgent() {
  if (!sons || agentArmed) return;
  const utter = new SpeechSynthesisUtterance(LONG_TEXT);
  utter.volume = parseFloat(ttsVol.value);
  utter.rate = 0.9;
  utter.onend = () => {
    if (agentArmed) {
      disarmAgent();
      dbg.textContent = "agent finished (no interrupt)";
    }
  };
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
  agentArmed = true;
  sons.setAgentSpeaking(true);
  label.textContent = "agent speaking… (interruptable)";
  agentButton.disabled = true;
  agentStopButton.hidden = false;
}

function stopAgent() {
  speechSynthesis.cancel();
  if (agentArmed) {
    disarmAgent();
    dbg.textContent = "agent stopped manually";
  }
}

function disarmAgent() {
  agentArmed = false;
  sons?.setAgentSpeaking(false);
  label.textContent = "not listening";
  agentButton.disabled = false;
  agentStopButton.hidden = true;
}

function onError(err) {
  errEl.textContent = humanMessage(err.code) ?? `Error (${err.code}): ${err.message}`;
  // eslint-disable-next-line no-console
  console.error("[sons] onError:", err);
}
