import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operationAtPixel, frameAtTime, trajectoryRange } from '../src/timeline-state.ts';
import type { TraceFrame } from '../src/types.ts';

test('step coordinates clamp and account for spacing and the initial state', () => {
  for (const spacing of [12, 24, 100, 240]) {
    assert.equal(operationAtPixel(-100, spacing, 20), 0);
    assert.equal(operationAtPixel(24 + spacing * 7.1, spacing, 20), 7);
    assert.equal(operationAtPixel(24 + spacing * 7.9, spacing, 20), 8);
    assert.equal(operationAtPixel(24 + spacing * 100, spacing, 20), 20);
  }
  assert.equal(operationAtPixel(100, 24, 0), 0);
});
test('physics seeks nearest time without including rollback or losing duplicate endpoints', () => {
  const trace = [
    { sim_time: 10, phase: 'input' },
    { sim_time: 10.1, phase: 'physics' },
    { sim_time: 10.2, phase: 'physics' },
    { sim_time: 10.2, phase: 'final' },
    { sim_time: 10, phase: 'rollback' },
  ] as TraceFrame[];
  const range = trajectoryRange(trace, 0, trace.length);
  assert.equal(range.rollback, 4);
  assert.equal(range.last, 3);
  assert.ok(Math.abs(range.duration - 0.2) < 1e-10);
  assert.equal(frameAtTime(trace, 0, 3, 10.09), 1);
  assert.equal(frameAtTime(trace, 0, 3, 10.19), 2);
  assert.equal(frameAtTime(trace, 0, 3, 9), 0);
  assert.equal(frameAtTime(trace, 0, 3, 11), 3);
  assert.equal(trajectoryRange([], 0, 0).duration, 0);
  assert.equal(trajectoryRange(trace, 0, 1).duration, 0);
});
