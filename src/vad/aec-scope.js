/**
 * AEC scope negotiation + classification (rev 8.1 WP-E1 — D1/D2/D3/D4/D5).
 *
 * Why this exists: a mic track that reports `echoCancellation: true` does NOT
 * mean the browser cancels what the page plays. On desktop Chromium the
 * accepted `true` means "cancel remote WebRTC audio only" — the exact state in
 * which the agent's own TTS leaks into the mic (analysis §3.1/§3.2). The only
 * scope a page can *verify* is what `track.getSettings()` echoes back after
 * the request — and even that can lie (Chromium 479234114). This module turns
 * the reported value into an honest scope label and hosts the pure decision
 * helpers (fallback constraints, stricter-gating rule) so they stay
 * Node-testable (master plan D1).
 *
 * No `window`/`navigator` access — imported by the adapter, the energy engine,
 * the facade and Node tests alike.
 *
 * @module vad/aec-scope
 */

/**
 * AEC scope labels (D2).
 *
 * - `all`            — settings echo the string `"all"`: system-wide capture
 *                      requested and applied (Chromium 140+ with the OS
 *                      *Screen & System Audio Recording* permission).
 * - `remote-only`    — settings echo `"remote-only"`: only WebRTC remote
 *                      audio is in the AEC reference.
 * - `unknown`        — settings report the boolean `true` (browser-decided).
 *                      We cannot verify the scope from JS; on Chromium this
 *                      is precisely the leaking default (WP-E0 matrix).
 * - `none`           — settings report `false` or nothing: no usable
 *                      cancellation.
 *
 * @typedef {"all"|"remote-only"|"unknown"|"none"} AecScope
 */

/** Scope label constants. @type {Record<string, AecScope>} */
export const AEC_SCOPE = {
  ALL: "all",
  REMOTE_ONLY: "remote-only",
  UNKNOWN: "unknown",
  NONE: "none",
};

/**
 * Default mic constraints (D1) — the single source of truth shared by
 * `DEFAULTS.mic` (config.js), the Silero adapter and the energy engine.
 *
 * `echoCancellation: { ideal: "all" }` requests the widest scope as an
 * *ideal*: it never fails the request, browsers without string support fall
 * back per spec, and a user's primitive override (`mic: { echoCancellation:
 * false }`) still replaces it under `mergeOptions` (primitive beats object).
 *
 * @type {{ channelCount: number, echoCancellation: {ideal: string},
 *          noiseSuppression: boolean, autoGainControl: boolean }}
 */
export const AEC_CONSTRAINTS = {
  channelCount: 1,
  echoCancellation: { ideal: "all" },
  noiseSuppression: true,
  autoGainControl: true,
};

/**
 * Classify the AEC scope from the track's reported settings (D2/D3).
 *
 * Value-based, NOT browser-based: only the echoed settings value decides.
 * The `requested` argument is accepted for signature stability and future
 * refinement but never influences the classification — `getSettings()` can
 * lie (Chromium 479234114), so an unverifiable `true` stays honestly
 * `"unknown"` even when we asked for `"all"`.
 *
 * @param {MediaTrackSettings|null|undefined} settings  `track.getSettings()` result
 * @param {boolean|{ideal?: any, exact?: any}|undefined} [requested]  the constraint value we sent
 * @returns {AecScope}
 */
export function classifyAecScope(settings, requested) {
  const reported = settings?.echoCancellation;
  if (reported === "all") return AEC_SCOPE.ALL;
  if (reported === "remote-only") return AEC_SCOPE.REMOTE_ONLY;
  if (reported === true) return AEC_SCOPE.UNKNOWN;
  // false, missing, or anything unexpected — the only honest claim is "none".
  return AEC_SCOPE.NONE;
}

/**
 * True when the requested constraint value asks for a system-wide ("all"-style)
 * scope — the precondition for the D4 ended-stream fallback.
 *
 * @param {boolean|{ideal?: any, exact?: any}|undefined} requested
 * @returns {boolean}
 */
export function isAllStyleRequest(requested) {
  return requested != null && typeof requested === "object";
}

/**
 * D4 fallback: the constraint set for the single re-request after a track
 * that was opened with an `"all"`-style request ended by itself (macOS 15+
 * without the OS *Screen & System Audio Recording* permission — Chromium
 * 479234114). Falls back to the browser default (`echoCancellation: true`).
 * Returns `null` when no fallback applies (request was not "all"-style) —
 * a boolean-`true` track dying is an ordinary mic failure, not an AEC problem.
 *
 * @param {boolean|{ideal?: any, exact?: any}|undefined} requested
 * @returns {{ channelCount: number, echoCancellation: boolean,
 *            noiseSuppression: boolean, autoGainControl: boolean }|null}
 */
export function endedFallbackConstraints(requested) {
  if (!isAllStyleRequest(requested)) return null;
  return { ...AEC_CONSTRAINTS, echoCancellation: true };
}

/**
 * D5 stricter-gating rule (pure): should the detector run its stricter
 * barge-in gating (`noAecMode`) for the given scope?
 *
 * `strictGating: "auto"` (default) activates when the scope is `"none"`, or
 * `"unknown"`/`"remote-only"` while no cancelable agent-audio route is active
 * (`setAgentAudioRouted(true)`). With `"all"` or an active route, normal
 * gating applies — a routed agent gives Chromium's AEC a real reference, so
 * the ~300 ms stricter window would only tax barge-in latency (R5).
 * `"on"`/`"off"` are the explicit overrides.
 *
 * @param {AecScope} scope  the classified scope (missing → treat as `"unknown"`)
 * @param {boolean} agentAudioRouted  whether a cancelable agent-audio route is active
 * @param {"auto"|"on"|"off"} [strictGating]  override option, default `"auto"`
 * @returns {boolean}
 */
export function strictGatingActive(scope, agentAudioRouted, strictGating = "auto") {
  if (strictGating === "on") return true;
  if (strictGating === "off") return false;
  const s = scope ?? AEC_SCOPE.UNKNOWN;
  if (s === AEC_SCOPE.NONE) return true;
  if (s === AEC_SCOPE.ALL) return false;
  // "unknown" | "remote-only"
  return !agentAudioRouted;
}
