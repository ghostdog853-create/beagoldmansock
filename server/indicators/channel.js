'use strict';

// WAVE FLOOR — 채널 · 추세선 · 볼린저
//
// 채널은 두 가지 방식으로 잡는다.
//   1) 선형회귀 채널 — 최근 N봉에 최소자승 직선을 맞추고 표준편차로 상·하단을 만든다.
//      객관적이고 항상 그려진다는 게 장점. "지금 채널의 어디쯤인가"를 숫자로 준다.
//   2) 피벗 추세선 — 실제 고점 2개, 저점 2개를 이은 선. 사람이 차트에 긋는 것과 같다.
//      항상 잡히진 않지만 잡히면 훨씬 의미가 크다.
//
// 둘을 함께 내는 이유: 회귀 채널은 "현재 위치"를, 피벗 추세선은 "돌파 레벨"을 준다.

// 최소자승 직선 y = a + b·x
function linreg(values) {
  const n = values.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += values[i];
    sxy += i * values[i];
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return { a, b };
}

// 선형회귀 채널 — 기울기 + 표준편차 밴드 + 현재 위치(0=하단, 1=상단)
function regressionChannel(candles, lookback = 100, k = 2) {
  const use = candles.slice(-lookback);
  const closes = use.map((c) => c.c);
  const fit = linreg(closes);
  if (!fit) return null;

  const n = closes.length;
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const pred = fit.a + fit.b * i;
    sse += (closes[i] - pred) ** 2;
  }
  const sd = Math.sqrt(sse / n);

  const lastIdx = n - 1;
  const mid = fit.a + fit.b * lastIdx;
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const price = closes[lastIdx];
  const posInChannel = upper === lower ? 0.5 : (price - lower) / (upper - lower);

  // 기울기를 "봉당 %"로 환산해야 시간대 간 비교가 된다
  const slopePctPerBar = mid !== 0 ? (fit.b / mid) * 100 : 0;
  let slopeLabel = '수평';
  if (slopePctPerBar > 0.08) slopeLabel = '가파른 상승';
  else if (slopePctPerBar > 0.015) slopeLabel = '완만한 상승';
  else if (slopePctPerBar < -0.08) slopeLabel = '가파른 하락';
  else if (slopePctPerBar < -0.015) slopeLabel = '완만한 하락';

  return {
    lookback: n,
    mid,
    upper,
    lower,
    sd,
    k,
    a: fit.a,
    b: fit.b,
    price,
    posInChannel,
    slopePctPerBar,
    slopeLabel,
  };
}

// 피벗 2개를 이은 추세선을 현재 봉까지 연장한 값
function trendlineFrom(p1, p2, atIndex) {
  if (!p1 || !p2 || p2.i === p1.i) return null;
  const slope = (p2.price - p1.price) / (p2.i - p1.i);
  return p1.price + slope * (atIndex - p1.i);
}

// 최근 고점 2개 / 저점 2개로 저항선·지지선을 긋는다
function pivotTrendlines(pivots, lastIndex, price) {
  const highs = pivots.filter((p) => p.kind === 'H').slice(-2);
  const lows = pivots.filter((p) => p.kind === 'L').slice(-2);

  const resistance = highs.length === 2 ? trendlineFrom(highs[0], highs[1], lastIndex) : null;
  const support = lows.length === 2 ? trendlineFrom(lows[0], lows[1], lastIndex) : null;

  const out = { resistance, support, resistanceGapPct: null, supportGapPct: null, shape: null };
  if (resistance != null) out.resistanceGapPct = ((resistance - price) / price) * 100;
  if (support != null) out.supportGapPct = ((price - support) / price) * 100;

  // 두 선이 모이는지 벌어지는지 — 삼각수렴/확대 판정
  if (highs.length === 2 && lows.length === 2) {
    const hSlope = (highs[1].price - highs[0].price) / (highs[1].i - highs[0].i);
    const lSlope = (lows[1].price - lows[0].price) / (lows[1].i - lows[0].i);
    if (hSlope < 0 && lSlope > 0) out.shape = '대칭 삼각수렴 — 상하단이 모이는 중';
    else if (hSlope < 0 && Math.abs(lSlope) < Math.abs(hSlope) * 0.3) out.shape = '하락 삼각형 — 저점 수평, 고점 하락';
    else if (lSlope > 0 && Math.abs(hSlope) < Math.abs(lSlope) * 0.3) out.shape = '상승 삼각형 — 고점 수평, 저점 상승';
    else if (hSlope > 0 && lSlope > 0) out.shape = '상승 채널 — 상하단 모두 우상향';
    else if (hSlope < 0 && lSlope < 0) out.shape = '하락 채널 — 상하단 모두 우하향';
    else if (hSlope > 0 && lSlope < 0) out.shape = '확대 삼각형 — 변동성 확대';
  }
  return out;
}

function bollinger(candles, period = 20, k = 2) {
  const closes = candles.map((c) => c.c);
  if (closes.length < period) return null;
  const win = closes.slice(-period);
  const mid = win.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(win.reduce((s, v) => s + (v - mid) ** 2, 0) / period);
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const price = closes[closes.length - 1];
  const bandwidthPct = mid !== 0 ? ((upper - lower) / mid) * 100 : 0;
  const pctB = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  return { mid, upper, lower, bandwidthPct, pctB };
}

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

function computeChannel(candles, pivots) {
  const price = candles[candles.length - 1].c;
  const lastIndex = candles.length - 1;
  const reg = regressionChannel(candles);
  const tl = pivotTrendlines(pivots || [], lastIndex, price);
  const bb = bollinger(candles);

  const lines = [];
  if (reg) {
    lines.push(
      `회귀채널(${reg.lookback}봉): ${reg.slopeLabel} (봉당 ${reg.slopePctPerBar >= 0 ? '+' : ''}${reg.slopePctPerBar.toFixed(3)}%)`
    );
    lines.push(
      `  상단 ${money(reg.upper)} · 중심 ${money(reg.mid)} · 하단 ${money(reg.lower)} · ` +
        `현재 위치 ${(reg.posInChannel * 100).toFixed(0)}% (0=하단, 100=상단)`
    );
  } else {
    lines.push('회귀채널: 데이터 없음');
  }

  if (tl.shape) lines.push(`추세선 형태: ${tl.shape}`);
  if (tl.resistance != null) {
    lines.push(`  저항 추세선 ${money(tl.resistance)} (현재가 대비 ${tl.resistanceGapPct >= 0 ? '+' : ''}${tl.resistanceGapPct.toFixed(2)}%)`);
  }
  if (tl.support != null) {
    lines.push(`  지지 추세선 ${money(tl.support)} (현재가 대비 -${Math.abs(tl.supportGapPct).toFixed(2)}%)`);
  }
  if (tl.resistance == null && tl.support == null) lines.push('  피벗 추세선: 스윙 포인트 부족');

  if (bb) {
    lines.push(
      `볼린저(20,2): 상단 ${money(bb.upper)} · 하단 ${money(bb.lower)} · ` +
        `%B ${(bb.pctB * 100).toFixed(0)}% · 밴드폭 ${bb.bandwidthPct.toFixed(2)}%`
    );
  }

  return { regression: reg, trendlines: tl, bollinger: bb, lines };
}

module.exports = { computeChannel, regressionChannel, pivotTrendlines, bollinger, linreg };
