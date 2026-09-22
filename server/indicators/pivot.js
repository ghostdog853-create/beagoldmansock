'use strict';

// WAVE FLOOR — 피벗(스윙 고저점) 검출
//
// 이 파일이 프로젝트의 심장이다. 채널·차트패턴·엘리어트 파동이 전부
// "의미 있는 고점·저점 목록"에서 출발하므로, 여기가 부실하면 위에 얹는 게
// 전부 무너진다.
//
// 방식: ATR 기반 ZigZag.
//   고정 퍼센트(예: 5%)를 쓰면 변동성이 다른 시간대·종목에서 전부 틀어진다.
//   BTC 주봉의 5%와 15분봉의 5%는 완전히 다른 의미다. 그래서 임계값을
//   "ATR의 k배"로 잡아 시간대가 알아서 자기 스케일을 갖게 한다.
//
// 확정(confirmed)과 잠정(tentative)의 구분이 중요하다.
//   마지막 피벗은 아직 되돌림이 임계값을 넘지 않았을 수 있다 — 즉 진행 중이다.
//   이걸 확정 피벗과 섞으면 "지금 5파가 끝났다" 같은 오판이 나온다.

const DEFAULT_ATR_PERIOD = 14;
const DEFAULT_K = 3.0; // 되돌림이 ATR의 몇 배여야 추세 전환으로 인정할지

// Wilder ATR — 캔들 배열 전체에 대한 시계열로 돌려준다(피벗마다 그 시점 ATR이 필요).
function atrSeries(candles, period = DEFAULT_ATR_PERIOD) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;

  const tr = new Array(n).fill(0);
  tr[0] = candles[0].h - candles[0].l;
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].c;
    tr[i] = Math.max(
      c.h - c.l,
      Math.abs(c.h - prevClose),
      Math.abs(c.l - prevClose)
    );
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]) / period; // Wilder 평활
    out[i] = prev;
  }
  return out;
}

// ZigZag 피벗 검출.
// 반환: [{ i, t, price, kind:'H'|'L', confirmed:boolean }]
//   i        캔들 인덱스
//   kind     'H' = 스윙 고점, 'L' = 스윙 저점
//   confirmed 임계값 이상 되돌려져 확정된 피벗인지 (마지막 하나만 false일 수 있다)
function findPivots(candles, opts = {}) {
  const k = Number.isFinite(opts.k) ? opts.k : DEFAULT_K;
  const period = opts.atrPeriod || DEFAULT_ATR_PERIOD;
  const n = Array.isArray(candles) ? candles.length : 0;
  if (n < period + 10) return [];

  const atr = atrSeries(candles, period);
  // ATR이 아직 안 잡히는 초반 구간은 첫 유효값으로 메운다
  let firstAtr = null;
  for (let i = 0; i < n; i++) {
    if (atr[i] != null) { firstAtr = atr[i]; break; }
  }
  if (firstAtr == null) return [];
  const thresholdAt = (i) => k * (atr[i] != null ? atr[i] : firstAtr);

  const pivots = [];
  // 시작 방향을 정한다: 첫 구간에서 고점이 먼저 갱신되는지 저점이 먼저인지
  let dir = 0; // 1 = 상승 추적(고점 갱신 중), -1 = 하락 추적
  let extIdx = period;
  let extPrice = candles[period].c;

  for (let i = period + 1; i < n; i++) {
    const c = candles[i];
    const th = thresholdAt(i);

    // 되돌림 검사를 극값 갱신보다 먼저 한다.
    // 순서를 뒤집으면 상승 추세에서 매 봉 extIdx가 i로 갱신돼 되돌림 조건이
    // 영영 성립하지 않는다. 또 이 순서 덕분에 피벗이 항상 서로 다른 봉에
    // 찍힌다 — 변동폭 큰 캔들 하나에 고점·저점이 동시에 잡히면 시간 순서가
    // 무너져 엘리어트 카운트가 전부 깨진다.
    if (dir >= 0) {
      if (extIdx < i && extPrice - c.l >= th) {
        pivots.push({ i: extIdx, t: candles[extIdx].t, price: extPrice, kind: 'H', confirmed: true });
        dir = -1;
        extPrice = c.l;
        extIdx = i;
        continue;
      }
      if (c.h >= extPrice) { extPrice = c.h; extIdx = i; }
      continue;
    }

    if (extIdx < i && c.h - extPrice >= th) {
      pivots.push({ i: extIdx, t: candles[extIdx].t, price: extPrice, kind: 'L', confirmed: true });
      dir = 1;
      extPrice = c.h;
      extIdx = i;
      continue;
    }
    if (c.l <= extPrice) { extPrice = c.l; extIdx = i; }
  }

  // 마지막 진행 중 극값을 잠정 피벗으로 추가한다.
  // "지금 어디쯤인가"를 판단하려면 이게 반드시 필요하다.
  const lastKind = dir >= 0 ? 'H' : 'L';
  const lastConfirmed = pivots.length ? pivots[pivots.length - 1] : null;
  if (!lastConfirmed || lastConfirmed.i !== extIdx) {
    pivots.push({
      i: extIdx,
      t: candles[extIdx].t,
      price: extPrice,
      kind: lastKind,
      confirmed: false,
    });
  }

  // 같은 종류가 연속으로 나오면(드물지만 경계에서 발생) 더 극단인 쪽만 남긴다
  const clean = [];
  for (const p of pivots) {
    const prev = clean[clean.length - 1];
    if (prev && prev.kind === p.kind) {
      const keepNew = p.kind === 'H' ? p.price > prev.price : p.price < prev.price;
      if (keepNew) clean[clean.length - 1] = p;
      continue;
    }
    clean.push(p);
  }
  return clean;
}

// 피벗 수열을 사람이 읽는 문장으로. LLM 프롬프트에 그대로 들어간다.
function describePivots(pivots, candles, maxN = 8) {
  if (!Array.isArray(pivots) || !pivots.length) return ['피벗 없음 — 데이터 부족'];
  const recent = pivots.slice(-maxN);
  return recent.map((p, idx) => {
    const d = new Date(p.t);
    const stamp = d.toISOString().slice(0, 16).replace('T', ' ');
    const label = p.kind === 'H' ? '고점' : '저점';
    const state = p.confirmed ? '확정' : '진행중';
    let move = '';
    const prev = recent[idx - 1];
    if (prev) {
      const pct = ((p.price - prev.price) / prev.price) * 100;
      const bars = p.i - prev.i;
      move = ` · 직전 대비 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% (${bars}봉)`;
    }
    return `${stamp} ${label} ${p.price.toLocaleString('en-US', { maximumFractionDigits: 8 })} [${state}]${move}`;
  });
}

// 고점·저점이 계단식으로 오르는지 내리는지 — 다우 이론의 기본 추세 판정
function swingStructure(pivots) {
  const highs = pivots.filter((p) => p.kind === 'H').slice(-3);
  const lows = pivots.filter((p) => p.kind === 'L').slice(-3);
  if (highs.length < 2 || lows.length < 2) {
    return { label: '판정 불가', detail: '스윙 포인트 부족' };
  }
  const hUp = highs[highs.length - 1].price > highs[highs.length - 2].price;
  const lUp = lows[lows.length - 1].price > lows[lows.length - 2].price;

  if (hUp && lUp) {
    return { label: '상승 구조', detail: '고점·저점 모두 상승 (HH/HL)' };
  }
  if (!hUp && !lUp) {
    return { label: '하락 구조', detail: '고점·저점 모두 하락 (LH/LL)' };
  }
  if (hUp && !lUp) {
    return { label: '확장 구조', detail: '고점 상승·저점 하락 — 변동성 확대' };
  }
  return { label: '수렴 구조', detail: '고점 하락·저점 상승 — 삼각수렴 가능' };
}

module.exports = { atrSeries, findPivots, describePivots, swingStructure, DEFAULT_K };
