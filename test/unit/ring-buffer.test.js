/** WP3 — RingBuffer unit tests (wrap-around, flush, clear semantics). */
import test from "node:test";
import assert from "node:assert/strict";
import { RingBuffer } from "../../src/turn/ring-buffer.js";

function f32(arr) {
  return Float32Array.from(arr);
}

test("below capacity: flush returns chronological content and resets", () => {
  const r = new RingBuffer(8);
  r.push(f32([1, 2]));
  r.push(f32([3]));
  assert.deepEqual([...r.flush()], [1, 2, 3]);
  assert.equal(r.flush().length, 0, "flush resets");
});

test("wrap-around: oldest samples are dropped first", () => {
  const r = new RingBuffer(4);
  r.push(f32([1, 2]));
  r.push(f32([3, 4]));
  r.push(f32([5]));
  assert.deepEqual([...r.flush()], [2, 3, 4, 5]);
});

test("frame longer than capacity keeps only the tail", () => {
  const r = new RingBuffer(3);
  r.push(f32([1, 2, 3, 4, 5]));
  assert.deepEqual([...r.flush()], [3, 4, 5]);
});

test("exact-capacity fill then wrap", () => {
  const r = new RingBuffer(4);
  r.push(f32([1, 2, 3, 4]));
  r.push(f32([5, 6]));
  assert.deepEqual([...r.flush()], [3, 4, 5, 6]);
});

test("clear() drops buffered samples", () => {
  const r = new RingBuffer(4);
  r.push(f32([9, 9]));
  r.clear();
  assert.equal(r.flush().length, 0);
});

test("flush on empty returns a zero-length array", () => {
  const r = new RingBuffer(4);
  const out = r.flush();
  assert.equal(out.length, 0);
  assert.ok(out instanceof Float32Array);
});

test("invalid capacity throws", () => {
  assert.throws(() => new RingBuffer(0));
  assert.throws(() => new RingBuffer(-1));
  assert.throws(() => new RingBuffer(1.5));
});
