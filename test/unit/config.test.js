/** WP3 — config: DEFAULTS sanity + mergeOptions semantics. */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, mergeOptions } from "../../src/config.js";

test("DEFAULTS match the documented values (plan §4.3, WP1 D-WP1-1 recalibration)", () => {
  const t = DEFAULTS.thresholds;
  assert.equal(t.onsetSpeechThreshold, 0.6);
  assert.equal(t.negativeSpeechThreshold, 0.35);
  assert.equal(t.onsetConfirmFrames, 9, "9 × 32 ms = 288 ms (plan: 3 × 96 ms)");
  assert.equal(t.minSpeechMs, 250);
  assert.equal(t.redemptionMs, 650);
  assert.equal(t.preSpeechPadMs, 200);
  assert.equal(t.bargeInConfirmFrames, 6, "6 × 32 ms = 192 ms (plan: 2 × 96 ms)");
  assert.equal(t.maxTurnMs, 30000);
  assert.equal(t.graceAfterInterruptMs, 500);
  assert.equal(DEFAULTS.mic.echoCancellation, true);
  assert.equal(DEFAULTS.mic.noiseSuppression, true);
  assert.equal(DEFAULTS.mic.autoGainControl, true);
  assert.equal(DEFAULTS.debug, false);
});

test("mergeOptions: user values win, untouched defaults survive (nested)", () => {
  const merged = mergeOptions(
    { thresholds: { redemptionMs: 100 }, debug: true },
    DEFAULTS
  );
  assert.equal(merged.thresholds.redemptionMs, 100);
  assert.equal(merged.thresholds.onsetSpeechThreshold, 0.6, "default kept");
  assert.equal(merged.thresholds.maxTurnMs, 30000, "default kept");
  assert.equal(merged.debug, true);
  assert.equal(merged.mic.echoCancellation, true);
});

test("mergeOptions: non-plain-object values replace, arrays are not merged", () => {
  const merged = mergeOptions(
    { mic: { echoCancellation: false }, list: [1, 2], n: null },
    { mic: { echoCancellation: true, noiseSuppression: true }, list: [9], n: 5 }
  );
  assert.equal(merged.mic.echoCancellation, false);
  assert.equal(merged.mic.noiseSuppression, true, "object merge is per-key");
  assert.deepEqual(merged.list, [1, 2], "arrays replace, not merge");
  assert.equal(merged.n, null);
});

test("mergeOptions: does not mutate its inputs", () => {
  const user = { thresholds: { redemptionMs: 100 } };
  const merged = mergeOptions(user, DEFAULTS);
  assert.notEqual(merged.thresholds, DEFAULTS.thresholds, "new nested object");
  assert.equal(DEFAULTS.thresholds.redemptionMs, 650, "default untouched");
  assert.deepEqual(user.thresholds, { redemptionMs: 100 }, "user untouched");
});

test("mergeOptions: empty/undefined user returns defaults copy", () => {
  const merged = mergeOptions(undefined, DEFAULTS);
  assert.deepEqual(merged, DEFAULTS);
  assert.notEqual(merged, DEFAULTS, "copy, not the same object");
});
