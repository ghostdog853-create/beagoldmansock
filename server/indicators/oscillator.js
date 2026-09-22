'use strict';

// WAVE FLOOR — 오실레이터 (RSI · MACD · 스토캐스틱) + 다이버전스
//
// RSI 값 하나("47.2 중립")는 사실상 정보가 없다. 진짜 신호는 **다이버전스** —
// 가격은 신고점인데 RSI는 못 따라오는 상태다. 이걸 잡으려면 가격 피벗과
// 같은 시점의 RSI를 비교해야 하므로, 이 모듈은 pivot.js의 결과를 받는다.

// ---- RSI (Wilder) ----
function rsiSeries(closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let ag = gain / period;
  let al = loss / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);

  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period;
    al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
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

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = emaSeries(closes, fast);
  const es = emaSeries(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const valid = line.filter((v) => v != null);
  const sig = emaSeries(valid, signalPeriod);
  const offset = line.length - valid.length;
  const signal = new Array(closes.length).fill(null);
  sig.forEach((v, i) => {
    if (v != null) signal[i + offset] = v;
  });
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const n = candles.length;
  const k = new Array(n).fill(null);
  for (let i = kPeriod - 1; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].h > hi) hi = candles[j].h;
      if (candles[j].l < lo) lo = candles[j].l;
    }
    k[i] = hi === lo ? 50 : ((candles[i].c - lo) / (hi - lo)) * 100;
  }
  const kv = k.filter((v) => v != null);
  const dRaw = [];
  for (let i = dPeriod - 1; i < kv.length; i++) {
    dRaw.push(kv.slice(i - dPeriod + 1, i + 1).reduce((a, b) => a + b, 0) / dPeriod);
  }
  const d = new Array(n).fill(null);
  const off = n - dRaw.length;
  dRaw.forEach((v, i) => { d[i + off] = v; });
  return { k, d };
}

// ---- 다이버전스 ----
// 가격 피벗 두 개와 그 시점의 오실레이터 값을 비교한다.
//   약세 다이버전스: 가격 고점 상승 + 오실레이터 고점 하락 → 상승 동력 소진
//   강세 다이버전스: 가격 저점 하락 + 오실레이터 저점 상승 → 하락 동력 소진
function findDivergence(pivots, osc, minGapBars = 5) {
  const out = [];
  const kinds = [
    { kind: 'H', name: '약세 다이버전스', priceUp: true },
    { kind: 'L', name: '강세 다이버전스', priceUp: false },
  ];

  for (const spec of kinds) {
    const pts = pivots
      .filter((p) => p.kind === spec.kind && osc[p.i] != null)
      .slice(-4);
    if (pts.length < 2) continue;
    // 최근 두 개를 비교
    for (let i = pts.length - 1; i >= 1; i--) {
      const b = pts[i];
      const a = pts[i - 1];
      if (b.i - a.i < minGapBars) continue;
      const priceRose = b.price > a.price;
      const oscRose = osc[b.i] > osc[a.i];
      const hit = spec.priceUp ? priceRose && !oscRose : !priceRose && oscRose;
      if (hit) {
        out.push({
          name: spec.name,
          from: { t: a.t, price: a.price, osc: osc[a.i] },
          to: { t: b.t, price: b.price, osc: osc[b.i] },
          barsAgo: null,
        });
      }
      break; // 가장 최근 쌍만 본다
    }
  }
  return out;
}

function zone(rsi) {
  if (rsi == null) return '데이터 없음';
  if (rsi >= 70) return '과매수';
  if (rsi >= 55) return '강세';
  if (rsi > 45) return '중립';
  if (rsi > 30) return '약세';
  return '과매도';
}

function computeOscillators(candles, pivots) {
  const closes = candles.map((c) => c.c);
  const rsi = rsiSeries(closes, 14);
  const m = macd(closes);
  const st = stochastic(candles);
  const last = closes.length - 1;

  const rsiNow = rsi[last];
  const macdNow = m.line[last];
  const sigNow = m.signal[last];
  const histNow = m.hist[last];
  const histPrev = m.hist[last - 1];

  // 히스토그램이 커지는지 줄어드는지 — 모멘텀의 2차 미분
  let histTrend = '판정 불가';
  if (histNow != null && histPrev != null) {
    if (histNow > 0 && histNow > histPrev) histTrend = '상승 모멘텀 확대';
    else if (histNow > 0) histTrend = '상승 모멘텀 축소';
    else if (histNow < 0 && histNow < histPrev) histTrend = '하락 모멘텀 확대';
    else histTrend = '하락 모멘텀 축소';
  }

  const divergences = pivots && pivots.length ? findDivergence(pivots, rsi) : [];

  const lines = [];
  lines.push(`RSI(14) ${rsiNow != null ? rsiNow.toFixed(1) : '-'} · ${zone(rsiNow)}`);
  lines.push(
    `MACD ${macdNow != null ? macdNow.toFixed(2) : '-'} / 시그널 ${sigNow != null ? sigNow.toFixed(2) : '-'} · ` +
      `히스토그램 ${histNow != null ? histNow.toFixed(2) : '-'} — ${histTrend}`
  );
  lines.push(
    `스토캐스틱 %K ${st.k[last] != null ? st.k[last].toFixed(1) : '-'} / ` +
      `%D ${st.d[last] != null ? st.d[last].toFixed(1) : '-'}`
  );
  if (divergences.length) {
    for (const d of divergences) {
      const at = new Date(d.to.t).toISOString().slice(0, 16).replace('T', ' ');
      lines.push(
        `⚠ ${d.name} — 가격 ${d.from.price.toLocaleString('en-US', { maximumFractionDigits: 6 })} → ` +
          `${d.to.price.toLocaleString('en-US', { maximumFractionDigits: 6 })} 인데 ` +
          `RSI ${d.from.osc.toFixed(1)} → ${d.to.osc.toFixed(1)} (${at} 기준)`
      );
    }
  } else {
    lines.push('다이버전스: 없음');
  }

  return {
    rsi: rsiNow,
    rsiZone: zone(rsiNow),
    macd: macdNow,
    signal: sigNow,
    hist: histNow,
    histTrend,
    stochK: st.k[last],
    stochD: st.d[last],
    divergences,
    lines,
  };
}

module.exports = { computeOscillators, rsiSeries, macd, stochastic, findDivergence };
