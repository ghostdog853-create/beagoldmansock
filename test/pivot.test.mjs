import { test } from 'node:test';
import assert from 'node:assert/strict';
import pivotMod from '../server/indicators/pivot.js';
import { zigzagCandles, flatCandles } from './fixtures.mjs';

const { findPivots, swingStructure } = pivotMod;

test('findPivots detects alternating highs/lows on a zigzag series', () => {
  const candles = zigzagCandles();
  const pivots = findPivots(candles, { k: 1.5 });
  assert.ok(pivots.length >= 3, `expected several pivots, got ${pivots.length}`);
  for (let i = 1; i < pivots.length; i++) {
    assert.notEqual(pivots[i].kind, pivots[i - 1].kind, 'pivots must alternate H/L');
    assert.ok(pivots[i].i > pivots[i - 1].i, 'pivots must land on distinct, increasing bar indices');
  }
  assert.equal(pivots[pivots.length - 1].confirmed, false, 'the last pivot is provisional until retraced');
});

test('findPivots finds no confirmed swings on a flat series (not enough range to clear ATR*k)', () => {
  const pivots = findPivots(flatCandles(), { k: 3.0 });
  const confirmed = pivots.filter((p) => p.confirmed);
  assert.equal(confirmed.length, 0, 'a flat series has no real range, so nothing should ever confirm');
});

test('findPivots returns [] instead of throwing when candles are too short', () => {
  assert.deepEqual(findPivots(zigzagCandles({ swings: [5], barsPerSwing: 3 })), []);
});

test('swingStructure summarizes direction from the last two confirmed pivots', () => {
  const pivots = findPivots(zigzagCandles(), { k: 1.5 });
  const structure = swingStructure(pivots);
  assert.ok(['상승 구조', '하락 구조', '확장 구조', '수렴 구조', '판정 불가'].includes(structure.label));
});
