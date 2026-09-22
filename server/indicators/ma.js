'use strict';

// WAVE FLOOR — 이동평균 묶음
//
// 단일 이평선 하나는 정보가 거의 없다. 값진 것은 "배열 상태"다.
// 5 > 20 > 60 > 120 이면 정배열, 반대면 역배열. 이 순서가 무너지는 지점이
// 추세 전환의 첫 신호다. 그래서 여기서는 개별 값보다 배열·이격·교차를 뽑는다.

// 99 는 텔레그램 「MA99 임펄스 매매법」 전용이라 계산만 하고
// 정배열/역배열 판정에서는 뺀다 — 60·120 사이에 끼워 넣으면 기존 판정이 바뀐다.
const PERIODS = [5, 20, 60, 99, 120, 200];
const ALIGN_PERIODS = [5, 20, 60, 120, 200];

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let s = 0;
  for (let i = values.length - period; i < values.length; i++) s += values[i];
  return s / period;
}

// 전 구간 SMA 시계열 (교차 시점 탐지에 필요)
function smaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= period) s -= values[i - period];
    if (i >= period - 1) out[i] = s / period;
  }
  return out;
}

function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// 최근 N봉 안에서 두 이평선의 교차를 찾는다
function findCross(fastSeries, slowSeries, lookback = 30) {
  const n = fastSeries.length;
  const start = Math.max(1, n - lookback);
  for (let i = n - 1; i > start; i--) {
    const f0 = fastSeries[i - 1];
    const s0 = slowSeries[i - 1];
    const f1 = fastSeries[i];
    const s1 = slowSeries[i];
    if (f0 == null || s0 == null || f1 == null || s1 == null) continue;
    if (f0 <= s0 && f1 > s1) return { kind: 'golden', barsAgo: n - 1 - i };
    if (f0 >= s0 && f1 < s1) return { kind: 'dead', barsAgo: n - 1 - i };
  }
  return null;
}

function computeMA(candles) {
  const closes = candles.map((c) => c.c);
  const price = closes[closes.length - 1];

  const values = {};
  const series = {};
  for (const p of PERIODS) {
    series[p] = smaSeries(closes, p);
    values[p] = sma(closes, p);
  }

  // 배열 상태 — 값이 있는 이평선만 놓고 순서를 본다
  const avail = ALIGN_PERIODS.filter((p) => values[p] != null);
  let alignment = '혼조';
  let alignmentDetail = '';
  if (avail.length >= 3) {
    const vals = avail.map((p) => values[p]);
    const asc = vals.every((v, i) => i === 0 || vals[i - 1] >= v); // 짧은 게 위
    const desc = vals.every((v, i) => i === 0 || vals[i - 1] <= v);
    if (asc) {
      alignment = '정배열';
      alignmentDetail = avail.join(' > ') + ' 순으로 위에서 아래 — 상승 추세 정렬';
    } else if (desc) {
      alignment = '역배열';
      alignmentDetail = avail.join(' < ') + ' 순으로 아래에서 위 — 하락 추세 정렬';
    } else {
      alignmentDetail = '이평선이 얽혀 있음 — 추세 전환 구간이거나 횡보';
    }
  }

  // 가격이 각 이평선 위/아래 어디에 있는지 + 이격률
  const position = {};
  for (const p of avail) {
    const gap = ((price - values[p]) / values[p]) * 100;
    position[p] = { value: values[p], gapPct: gap, above: gap >= 0 };
  }
  const aboveCount = avail.filter((p) => position[p].above).length;

  // 주요 교차
  const cross2060 = findCross(series[20], series[60], 40);
  const cross60120 = findCross(series[60], series[120], 60);

  const lines = [];
  lines.push(`이평 배열: ${alignment}${alignmentDetail ? ' — ' + alignmentDetail : ''}`);
  lines.push(
    `가격 ${price.toLocaleString('en-US', { maximumFractionDigits: 6 })} · ` +
      `${avail.length}개 중 ${aboveCount}개 이평선 위`
  );
  for (const p of avail) {
    const q = position[p];
    lines.push(
      `  SMA${p} ${q.value.toLocaleString('en-US', { maximumFractionDigits: 6 })} · ` +
        `이격 ${q.gapPct >= 0 ? '+' : ''}${q.gapPct.toFixed(2)}% (${q.above ? '위' : '아래'})`
    );
  }
  if (cross2060) {
    lines.push(
      `20/60 ${cross2060.kind === 'golden' ? '골든크로스' : '데드크로스'} — ${cross2060.barsAgo}봉 전 발생`
    );
  }
  if (cross60120) {
    lines.push(
      `60/120 ${cross60120.kind === 'golden' ? '골든크로스' : '데드크로스'} — ${cross60120.barsAgo}봉 전 발생`
    );
  }

  return { price, values, series, position, alignment, alignmentDetail, aboveCount, cross2060, cross60120, lines };
}

module.exports = { computeMA, smaSeries, emaSeries, sma, PERIODS, ALIGN_PERIODS };
