import { test } from 'node:test';
import assert from 'node:assert/strict';
import preMod from '../server/indicators/preconstruction.js';
import neowaveMod from '../server/indicators/neowave.js';
import pivotMod from '../server/indicators/pivot.js';

const { coverageReport } = preMod;
const { analyzeNeoWave, LABEL_SETS } = neowaveMod;
const { findPivots } = pivotMod;

test('coverageReport reports every (rule, condition) pair as covered — 22 conditions were filled in', () => {
  const r = coverageReport();
  assert.equal(r.missing.length, 0, `still missing: ${r.missing.join(' ')}`);
  assert.equal(r.covered.length, r.total);
  assert.equal(r.total, 32); // rule 5 gained a 4th condition (a bug found while filling this table)
});

// 무작위에 가까운 지그재그를 대량으로 돌려 법칙 3~7 · 범주(법칙4) 조합을 폭넓게 때린다.
// 결정론적으로 39개 항목 전부를 적중시키진 않지만, 새로 추가한 when()이 던지는 예외나
// 표에 없는 구조기호를 내보내는 실수는 이걸로 잡힌다.
function zigzagFrom(seed) {
  let price = 100;
  let t = 1700000000000;
  const candles = [];
  // seed 로 스윙 폭과 봉수를 흔들어 서로 다른 비율 조합을 만든다
  const swings = [];
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < 14; i++) swings.push((rand() - 0.45) * 40);
  for (const swing of swings) {
    const bars = 5 + Math.floor(rand() * 25);
    const step = swing / bars;
    for (let i = 0; i < bars; i++) {
      const o = price;
      price += step;
      const c = price;
      const h = Math.max(o, c) + Math.abs(step) * 0.3;
      const l = Math.min(o, c) - Math.abs(step) * 0.3;
      candles.push({ t, o, h, l, c, v: 100 });
      t += 3600000;
    }
  }
  return candles;
}

test('analyzeNeoWave never throws and never emits a structure code outside that rule\'s LABEL_SETS, across many synthetic charts', () => {
  let checkedReadings = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const candles = zigzagFrom(seed);
    const pivots = findPivots(candles, { k: 1.2 });
    if (pivots.length < 4) continue;
    const result = analyzeNeoWave(pivots);
    for (const mono of result.monowaves) {
      for (const reading of mono.readings) {
        checkedReadings++;
        const pre = reading.pre;
        if (!pre || !pre.applied || !pre.resolved) continue;
        const validLabels = (LABEL_SETS[reading.rule] || { labels: [] }).labels.map((l) =>
          l.replace(/^[[(]|[\])]$/g, '')
        );
        for (const code of pre.resolved) {
          assert.ok(
            validLabels.includes(code),
            `R${reading.rule}${reading.condition ? reading.condition.letter : '?'} emitted "${code}", ` +
              `not in LABEL_SETS[${reading.rule}] = ${validLabels.join(',')}`
          );
        }
      }
    }
  }
  assert.ok(checkedReadings > 100, `expected substantial coverage, only checked ${checkedReadings} readings`);
});
