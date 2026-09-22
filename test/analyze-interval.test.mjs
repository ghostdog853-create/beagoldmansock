import { test } from 'node:test';
import assert from 'node:assert/strict';
import indexMod from '../server/indicators/index.js';
import { zigzagCandles } from './fixtures.mjs';

const { analyzeInterval, PIVOT_K } = indexMod;

// End-to-end smoke test: one call exercises pivot → ma/osc/channel/pattern →
// neowave → elliott → harmonic/diagonal/corrective/volume → methods →
// confluence/construction/arbitrate. If any module in that chain throws or
// forgets to return `lines`, this is what catches it.
for (const interval of Object.keys(PIVOT_K)) {
  test(`analyzeInterval('${interval}') runs the full indicator stack without throwing`, () => {
    const candles = zigzagCandles({ barsPerSwing: 60 });
    const result = analyzeInterval(interval, candles, 'BTCUSDT');
    assert.ok(result, 'analyzeInterval must return a result');
    assert.ok(result.blocks && typeof result.blocks === 'object', 'must produce prompt-ready blocks');
    for (const [key, block] of Object.entries(result.blocks)) {
      assert.ok(Array.isArray(block), `blocks.${key} must be a line array`);
    }
  });
}
