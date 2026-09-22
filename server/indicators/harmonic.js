'use strict';

// WAVE FLOOR — 하모닉 패턴 (XABCD)
//
// 명세: docs/파동분석-통합본.md 6장
//
// ───────────────────────────────────────────────────────────────────────────
// 이 모듈의 성패는 "어디를 X-A-B-C-D로 잡느냐"에 달려 있다.
//
// 5개 점을 아무 데나 잡고 비율만 맞추면 하모닉은 어느 차트에서든 발견된다.
// 노이즈에서 억지로 뽑은 패턴은 근거가 아니라 소음이다. 그래서 앵커링에
// 다음 조건을 전부 강제한다 — 하나라도 어기면 후보 자체를 만들지 않는다:
//
//   ① 확정 피벗만 쓴다 (pivot.js의 confirmed:true).
//      진행 중인 잠정 피벗은 D 자리에만 허용한다 — D는 지금 만들어지는 중이니까.
//   ② H/L이 엄격히 교대해야 한다. 같은 종류가 붙으면 방향 전환이 아니다.
//   ③ 각 다리가 그 시점 ATR의 배수 이상이어야 한다. 노이즈 크기의 다리는 다리가 아니다.
//   ④ 각 다리가 XA 대비 최소 비중 이상이어야 한다. 한 다리가 미세하면 5점 구조가 아니다.
//   ⑤ 봉 간격이 최소치 이상이어야 한다. 몇 봉 만에 5점이 나오면 그건 진동이다.
//   ⑥ C는 A를 초과하지 않는다 (샤크 제외 — 샤크는 C가 A를 넘는 것이 정의다).
//
// 이 필터를 통과한 뒤에야 비율을 본다. 순서를 바꾸면 안 된다.
// ───────────────────────────────────────────────────────────────────────────

const { atrSeries } = require('./pivot');

// 앵커링 임계값
const MIN_LEG_ATR = 1.8;   // 각 다리 최소 크기 = ATR의 배수
const MIN_LEG_RATIO = 0.12; // 각 다리 최소 크기 = XA의 비율
const MIN_LEG_BARS = 3;     // 각 다리 최소 봉 수
const TOL = 0.06;           // 비율 허용 오차 (±6%)

// 패턴 정의. 전부 docs/source 의 하모닉 자료에서 온 값이다.
//   b   : B점 = XA의 되돌림 범위
//   d   : D점 = XA의 비율 범위 (PRZ 중심)
//   bc  : BC 확장 배수 목록
//   abcd: AB=CD 배수 목록
//   c   : C점 = AB의 범위 (공통 0.382~0.886, 패턴별로 다름)
//   sl  : 손절 = XA의 배수
const PATTERNS = [
  {
    id: 'gartley', name: '가틀리',
    b: [0.618, 0.618], c: [0.382, 0.886], d: [0.786, 0.786],
    bc: [1.13, 1.272, 1.414, 1.618], abcd: [1.0, 1.27], sl: 1.0,
    note: '가장 보수적인 하모닉. 전체 PRZ가 테스트된 뒤 즉시 되돌려야 유효하다',
  },
  {
    id: 'deepGartley', name: '딥 가틀리',
    b: [0.618, 0.618], c: [0.382, 0.886], d: [0.786, 0.886],
    bc: [1.618, 2.0, 2.24, 2.618], abcd: [1.0], sl: 1.13,
    note: '1.0 AB=CD가 0.786을 초과할 때 나타나는 가틀리의 변형',
  },
  {
    id: 'bat', name: '뱃',
    b: [0.382, 0.5], c: [0.382, 0.886], d: [0.886, 0.886],
    bc: [1.618, 2.0, 2.24, 2.618], abcd: [1.0, 1.27, 1.618], sl: 1.13,
    note: '최소 AB=CD 필요. 초기 테스트가 1.0XA 근처까지 갈 수 있다',
  },
  {
    id: 'altBat', name: '얼터너트 뱃',
    b: [0.0, 0.382], c: [0.382, 0.886], d: [1.13, 1.13],
    bc: [2.0, 2.24, 2.618, 3.14, 3.618], abcd: [1.618], sl: 1.27,
    note: 'B가 얕은(≤0.382) 대신 D가 XA를 넘어선다',
  },
  {
    id: 'butterfly', name: '나비',
    b: [0.756, 0.816], c: [0.382, 0.99], d: [1.272, 1.272],
    bc: [1.618, 2.0, 2.24], abcd: [1.0, 1.27], sl: 1.414,
    note: '0.786 : 1.272 짝. D가 X를 넘는 돌파형',
  },
  {
    id: 'crab', name: '크랩',
    b: [0.382, 0.618], c: [0.382, 0.886], d: [1.618, 1.618],
    bc: [2.618, 3.14, 3.618], abcd: [1.27, 1.618], sl: 2.0,
    note: '0.618 : 1.618 짝. 가장 확장된 형태라 손절폭이 크다',
  },
  {
    id: 'deepCrab', name: '딥 크랩',
    b: [0.886, 0.886], c: [0.382, 0.886], d: [1.618, 1.902],
    bc: [2.0, 2.24, 2.618, 3.14, 3.618], abcd: [1.0, 1.27, 1.618], sl: 2.0,
    note: 'BC 확장이 2.618을 넘길수록 신뢰도가 커진다',
  },
  {
    id: 'yc707', name: '영철(707)',
    b: [0.677, 0.737], c: [0.382, 0.99], d: [1.414, 1.414],
    bc: [2.0, 2.24, 2.618, 3.14, 3.618], abcd: [1.0, 1.27, 1.618], sl: 1.618,
    note: '0.707 : 1.414 짝. 나비와 크랩 사이를 메우는 자리',
  },
];

// 샤크는 구조가 다르다 — C가 A를 초과하고, D를 XA가 아니라 XC로 잰다.
const SHARK = {
  id: 'shark', name: '샤크',
  b: [0.382, 0.618],      // B = XA 되돌림
  cOfAB: [1.13, 1.618],   // C = AB의 확장 (A를 넘어선다)
  dOfXC: [0.886, 1.13],   // D = XC의 비율
  bc: [1.618, 2.0, 2.24],
  slOfXC: [1.13, 1.27],
  note: '샤크는 C가 A를 넘는 것이 정의다. X와 B에서 다이버전스가 자주 동반된다. ' +
        '완성 후 BC의 0.5에 D를 추가하면 5-0 패턴으로 이어진다',
};

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

// 실제 비율이 [min,max] 범위(또는 단일 목표)에 드는지. 허용 오차 포함.
function inRange(actual, [min, max], tol = TOL) {
  if (!Number.isFinite(actual)) return { ok: false, fit: 0 };
  const lo = min * (1 - tol);
  const hi = max * (1 + tol);
  if (actual < lo || actual > hi) return { ok: false, fit: 0 };
  // 범위 중심에 가까울수록 높은 점수
  const mid = (min + max) / 2;
  const span = Math.max(hi - lo, 1e-9);
  const fit = Math.max(0, 1 - Math.abs(actual - mid) / (span / 2)) * 0.5 + 0.5;
  return { ok: true, fit };
}

// 목록 중 가장 가까운 배수를 찾는다
function nearestOf(actual, list, tol = TOL) {
  if (!Number.isFinite(actual)) return { ok: false, fit: 0, nearest: null };
  let best = null;
  for (const t of list) {
    const dev = Math.abs(actual - t) / t;
    if (!best || dev < best.dev) best = { nearest: t, dev };
  }
  const ok = best.dev <= tol * 2;
  return { ok, fit: ok ? Math.max(0, 1 - best.dev / (tol * 2)) : 0, nearest: best.nearest, dev: best.dev };
}

// ---------------------------------------------------------------------------
// 앵커 검증 — 이 모듈의 핵심. 여기서 걸러야 노이즈 패턴이 안 나온다.
// ---------------------------------------------------------------------------
function validateAnchors(pts, atr, opts = {}) {
  const reasons = [];

  // ① 확정 피벗만. D(마지막)만 진행 중 허용
  for (let i = 0; i < pts.length - 1; i++) {
    if (!pts[i].confirmed) {
      reasons.push(`${'XABCD'[i]}점이 미확정 피벗 — 확정된 전환점만 앵커로 쓴다`);
    }
  }

  // ② H/L 엄격 교대
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].kind === pts[i - 1].kind) {
      reasons.push(`${'XABCD'[i - 1]}→${'XABCD'[i]}가 같은 종류의 극점 — 방향 전환이 아니다`);
    }
  }

  // ③④⑤ 각 다리의 크기·비중·시간
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const size = Math.abs(pts[i].price - pts[i - 1].price);
    const bars = pts[i].i - pts[i - 1].i;
    legs.push({ name: `${'XABCD'[i - 1]}${'XABCD'[i]}`, size, bars });
  }
  const xa = legs[0] ? legs[0].size : 0;
  if (!(xa > 0)) reasons.push('XA 다리 길이가 0');

  const atrAt = (idx) => {
    const v = atr && atr[idx] != null ? atr[idx] : null;
    return v;
  };

  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li];
    const a = atrAt(pts[li + 1].i);

    // ATR 기준은 모든 다리에 적용한다 — 이게 노이즈를 막는 주 방어선이다
    if (a != null && leg.size < a * MIN_LEG_ATR) {
      reasons.push(`${leg.name} 다리가 ATR의 ${MIN_LEG_ATR}배 미만 — 노이즈 크기`);
    }

    // XA 대비 최소 비중은 AB·CD 에만 적용한다.
    // BC를 XA로 재면 안 된다 — BC는 구조적으로 AB의 일부(0.382~0.886)이므로
    // B가 얕은 패턴(얼터너트 뱃은 B≤0.382)에서는 XA 대비로 작은 것이 정상이다.
    // 실제로 이 조건 때문에 얼터너트 뱃이 통째로 검출되지 않았다.
    // BC의 타당성은 패턴별 C 비율 범위가 이미 검증한다.
    const checkVsXA = leg.name !== 'BC';
    if (checkVsXA && xa > 0 && leg.size < xa * MIN_LEG_RATIO) {
      reasons.push(`${leg.name} 다리가 XA의 ${(MIN_LEG_RATIO * 100).toFixed(0)}% 미만 — 구조가 성립하지 않음`);
    }

    if (leg.bars < MIN_LEG_BARS) {
      reasons.push(`${leg.name} 다리가 ${leg.bars}봉뿐 — 진동이지 파동이 아니다`);
    }
  }

  return { ok: reasons.length === 0, reasons, legs, xa };
}

// ---------------------------------------------------------------------------
// 표준 XABCD (샤크 제외) 판정
// ---------------------------------------------------------------------------
function matchStandard(pts, spec, bullish) {
  const [X, A, B, C, D] = pts;
  const xa = Math.abs(A.price - X.price);
  const ab = Math.abs(B.price - A.price);
  const bc = Math.abs(C.price - B.price);
  const cd = Math.abs(D.price - C.price);
  const ad = Math.abs(D.price - A.price);
  if (!(xa > 0 && ab > 0 && bc > 0 && cd > 0)) return null;

  // ⑥ C는 A를 초과하지 않는다
  const cExceedsA = bullish ? C.price > A.price : C.price < A.price;
  if (cExceedsA) return null;

  const rB = ab / xa;          // B = XA 되돌림
  const rC = bc / ab;          // C = AB 되돌림
  // D = XA 되돌림. 기준점은 X가 아니라 A다 —
  // "D : 0.786XA"는 A에서 X 쪽으로 0.786만큼 되돌린 자리를 뜻한다.
  // X 기준으로 재면 가틀리 0.786이 0.214로 나와 전부 어긋난다.
  const rD = Math.abs(D.price - A.price) / xa;
  const rBC = cd / bc;         // CD = BC 확장
  const rABCD = cd / ab;       // AB=CD

  const fB = inRange(rB, spec.b);
  if (!fB.ok) return null;
  const fC = inRange(rC, spec.c);
  if (!fC.ok) return null;
  const fD = inRange(rD, spec.d);
  if (!fD.ok) return null;

  const fBC = nearestOf(rBC, spec.bc);
  const fABCD = nearestOf(rABCD, spec.abcd);

  // 점수 — B/D가 패턴 정체성을 결정하므로 가장 무겁다
  let score = Math.round(
    (fB.fit * 1.2 + fD.fit * 1.5 + fC.fit * 0.8 + fBC.fit * 1.0 + fABCD.fit * 0.8) /
      (1.2 + 1.5 + 0.8 + 1.0 + 0.8) * 100
  );

  // PRZ — 세 가지 방법이 각각 지목하는 D 가격들이 모이는 구간.
  // 단일 가격이 아니라 존으로 내는 것이 하모닉의 본래 사용법이고,
  // 그래야 근거 중첩(confluence.js)에 구간으로 들어간다.
  //
  // 방향 규약: 강세 패턴은 D가 A보다 아래에서 완성된다(거기서 매수).
  const sgn = bullish ? -1 : 1;
  const dTargets = spec.d.map((r) => A.price + sgn * r * xa);       // XA 비율 기준
  const bcTargets = spec.bc.map((r) => C.price + sgn * r * bc);     // BC 확장 기준
  const abcdTargets = spec.abcd.map((r) => C.price + sgn * r * ab); // AB=CD 기준

  const all = [...dTargets, ...bcTargets, ...abcdTargets].filter(Number.isFinite);
  const przLow = Math.min(...all);
  const przHigh = Math.max(...all);

  // 손절은 X 너머 — sl 배수가 1.0이면 정확히 X, 1.13이면 그 바깥
  // PRZ 폭 = 신뢰도. 세 방법(XA비율·BC확장·AB=CD)이 한 자리를 가리키면 좁고,
  // 흩어지면 넓다. 킹능사 강의의 "마딧가가 중첩 안 되면 신뢰도가 떨어진다"가 이것이다.
  const przWidthPct = A.price !== 0 ? ((przHigh - przLow) / Math.abs(A.price)) * 100 : null;
  let przGrade = '보통';
  if (przWidthPct != null) {
    if (przWidthPct <= 1.5) { przGrade = '매우 좁음 — 세 방법이 한 자리를 가리킴'; score += 10; }
    else if (przWidthPct <= 3.5) { przGrade = '좁음'; score += 4; }
    else if (przWidthPct <= 7) { przGrade = '보통'; }
    else { przGrade = '넓음 — 마딧가가 중첩되지 않아 신뢰도가 낮다'; score -= 12; }
  }
  score = Math.max(0, Math.min(100, score));

  const stop = A.price + sgn * spec.sl * xa;
  const tp1 = D.price - sgn * 0.382 * ad;
  const tp2 = D.price - sgn * 0.618 * ad;

  return {
    id: spec.id,
    name: spec.name,
    bullish,
    score,
    note: spec.note,
    points: { X, A, B, C, D },
    ratios: {
      B: rB, C: rC, D: rD, BC: rBC, ABCD: rABCD,
      Bfit: fB, Dfit: fD, BCnear: fBC.nearest, ABCDnear: fABCD.nearest,
    },
    prz: { low: przLow, high: przHigh, mid: (przLow + przHigh) / 2, widthPct: przWidthPct, grade: przGrade },
    stop,
    targets: [
      { label: 'TP1 (0.382 AD)', price: tp1 },
      { label: 'TP2 (0.618 AD)', price: tp2 },
    ],
  };
}

// ---------------------------------------------------------------------------
// 샤크 — C가 A를 초과하고 D를 XC로 잰다
// ---------------------------------------------------------------------------
function matchShark(pts, bullish) {
  const [X, A, B, C, D] = pts;
  const xa = Math.abs(A.price - X.price);
  const ab = Math.abs(B.price - A.price);
  const bc = Math.abs(C.price - B.price);
  const cd = Math.abs(D.price - C.price);
  const xc = Math.abs(C.price - X.price);
  if (!(xa > 0 && ab > 0 && bc > 0 && cd > 0 && xc > 0)) return null;

  // 샤크는 C가 A를 반드시 초과한다
  const cExceedsA = bullish ? C.price > A.price : C.price < A.price;
  if (!cExceedsA) return null;

  const rB = ab / xa;
  const rC = bc / ab;
  const rD = cd / xc;

  const fB = inRange(rB, SHARK.b);
  if (!fB.ok) return null;
  const fC = inRange(rC, SHARK.cOfAB);
  if (!fC.ok) return null;
  const fD = inRange(rD, SHARK.dOfXC);
  if (!fD.ok) return null;

  const fBC = nearestOf(cd / bc, SHARK.bc);
  const score = Math.round(
    (fB.fit * 1.0 + fC.fit * 1.2 + fD.fit * 1.5 + fBC.fit * 0.8) / (1.0 + 1.2 + 1.5 + 0.8) * 100
  );

  const sgn = bullish ? -1 : 1;
  const dLow = C.price + sgn * SHARK.dOfXC[0] * xc;
  const dHigh = C.price + sgn * SHARK.dOfXC[1] * xc;
  const stop = C.price + sgn * SHARK.slOfXC[1] * xc;

  return {
    id: SHARK.id,
    name: SHARK.name,
    bullish,
    score,
    note: SHARK.note,
    points: { X, A, B, C, D },
    ratios: { B: rB, C: rC, D: rD, BCnear: fBC.nearest },
    prz: { low: Math.min(dLow, dHigh), high: Math.max(dLow, dHigh), mid: (dLow + dHigh) / 2 },
    stop,
    targets: [
      { label: 'TP1 (0.5 CD)', price: D.price - sgn * 0.5 * cd },
      { label: 'TP2 (0.886 CD)', price: D.price - sgn * 0.886 * cd },
    ],
    followUp: '완성 후 BC의 0.5 지점에 D를 추가하면 5-0 패턴 — 목표 C점, 손절 0.618BC',
  };
}

// ---------------------------------------------------------------------------
function computeHarmonics(candles, pivots, opts = {}) {
  const maxResults = opts.maxResults || 3;
  const found = [];
  const rejected = [];

  if (!Array.isArray(pivots) || pivots.length < 5) {
    return { patterns: [], rejected: [], lines: ['하모닉: 피벗 5개 미만 — 판정 불가'] };
  }
  const atr = atrSeries(candles);

  // 최근 구간에서 5점 창을 훑는다. 창은 연속 피벗이어야 한다 —
  // 중간을 건너뛰며 고르면 "보고 싶은 것만 고르는" 짓이 된다.
  const startMin = Math.max(0, pivots.length - 12);
  for (let s = pivots.length - 5; s >= startMin; s--) {
    const pts = pivots.slice(s, s + 5);
    if (pts.length !== 5) continue;

    const anchor = validateAnchors(pts, atr);
    if (!anchor.ok) {
      rejected.push({ at: pts[4], reasons: anchor.reasons.slice(0, 2) });
      continue;
    }

    // 강세/약세는 X의 종류로 정해진다.
    // 강세 하모닉: X(저점) → A(고점) → B(저점) → C(고점) → D(저점)에서 매수.
    const bullish = pts[0].kind === 'L';
    for (const spec of PATTERNS) {
      const m = matchStandard(pts, spec, bullish);
      if (m && m.score >= 45) found.push(m);
    }
    const sh = matchShark(pts, bullish);
    if (sh && sh.score >= 45) found.push(sh);
  }

  found.sort((a, b) => b.score - a.score);
  const top = found.slice(0, maxResults);

  const lines = [];
  if (!top.length) {
    lines.push('검출된 하모닉 패턴 없음');
    if (rejected.length) {
      const r = rejected[0];
      lines.push(`  (앵커 검증 탈락 예: ${r.reasons.join(' / ')})`);
    }
    lines.push('  ※ 확정 피벗·ATR 최소 크기·봉 간격을 전부 통과한 5점만 후보로 삼는다');
  } else {
    for (const p of top) {
      const dir = p.bullish ? '강세(매수)' : '약세(매도)';
      lines.push(`${p.name} ${dir} — 정합도 ${p.score}점`);
      const P = p.points;
      lines.push(
        `   X ${money(P.X.price)} → A ${money(P.A.price)} → B ${money(P.B.price)} → ` +
          `C ${money(P.C.price)} → D ${money(P.D.price)}`
      );
      const r = p.ratios;
      lines.push(
        `   B=${(r.B * 100).toFixed(1)}%XA · C=${(r.C * 100).toFixed(1)}%AB · ` +
          `D=${(r.D * 100).toFixed(1)}%${p.id === 'shark' ? 'XC' : 'XA'}` +
          (r.BCnear ? ` · BC≈${r.BCnear}` : '')
      );
      lines.push(
        `   PRZ ${money(p.prz.low)} ~ ${money(p.prz.high)}` +
          (p.prz.widthPct != null ? ` (폭 ${p.prz.widthPct.toFixed(2)}% · ${p.prz.grade})` : '')
      );
      lines.push(`   손절 ${money(p.stop)} · ${p.targets.map((t) => `${t.label} ${money(t.price)}`).join(' · ')}`);
      lines.push(`   ${p.note}`);
      if (p.followUp) lines.push(`   ${p.followUp}`);
    }
    lines.push('※ PRZ 전체가 테스트된 뒤 즉시 되돌려야 유효하다. 관통하면 패턴 실패로 본다');
  }

  return { patterns: top, rejected, lines };
}

module.exports = { computeHarmonics, validateAnchors, PATTERNS, SHARK, MIN_LEG_ATR, MIN_LEG_RATIO, MIN_LEG_BARS };
