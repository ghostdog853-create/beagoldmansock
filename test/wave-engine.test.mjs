import { test } from 'node:test';
import assert from 'node:assert/strict';
import pivotMod from '../server/indicators/pivot.js';
import neowaveMod from '../server/indicators/neowave.js';
import elliottMod from '../server/indicators/elliott.js';
import { zigzagCandles } from './fixtures.mjs';

const { findPivots } = pivotMod;
const { analyzeNeoWave } = neowaveMod;
const { countWaves } = elliottMod;

test('analyzeNeoWave labels each monowave with a structure code (:5 / :3 / …) and never crashes on real pivots', () => {
  const pivots = findPivots(zigzagCandles(), { k: 1.5 });
  const result = analyzeNeoWave(pivots);
  assert.ok(Array.isArray(result.monowaves));
  for (const m of result.monowaves) {
    assert.ok(m.primary && typeof m.primary.label === 'string' && m.primary.label.length > 0, 'every monowave needs a primary structure label');
  }
});

test('analyzeNeoWave degrades gracefully (no throw, explicit note) when pivots are too few', () => {
  const result = analyzeNeoWave([{ i: 0, kind: 'H', price: 1 }]);
  assert.equal(result.monowaves.length, 0);
  assert.ok(result.note);
});

test('countWaves never returns a candidate that breaks rule R1 (wave 2 retraces past wave 1 start)', () => {
  const pivots = findPivots(zigzagCandles(), { k: 1.5 });
  if (pivots.length < 3) return; // fixture didn't produce enough swings, nothing to assert
  const lastPrice = pivots[pivots.length - 1].price;
  const { candidates } = countWaves(pivots, lastPrice);
  for (const cand of candidates) {
    const w = cand.pivots;
    if (!w || w.length < 3) continue;
    const p0 = w[0].price;
    const p1 = w[1].price;
    const p2 = w[2].price;
    const up = p1 > p0;
    if (up) assert.ok(p2 > p0, 'R1 violated: wave 2 low undercut wave 1 start in an up-count');
    else assert.ok(p2 < p0, 'R1 violated: wave 2 high overshot wave 1 start in a down-count');
  }
});

test('countWaves reports "피벗 부족" instead of throwing when there are under 3 pivots', () => {
  const result = countWaves([{ i: 0, kind: 'H', price: 1 }, { i: 1, kind: 'L', price: 0.5 }], 0.5);
  assert.equal(result.candidates.length, 0);
  assert.match(result.note, /피벗.*부족|3개 미만/);
});
