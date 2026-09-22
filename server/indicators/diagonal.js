'use strict';

// WAVE FLOOR — 다이아고날 스크리너
//
// 명세: docs/파동분석-통합본.md 4장
//
// elliott.js의 detectDiagonal은 "R3를 어겼는데 쐐기인가"를 판정하는 구조 검사다.
// 이 모듈은 다른 일을 한다 — SEALCRYPTO 강의의 **3대 조건**으로
// "지금 사도 되는 다이아고날인가"를 판정하는 실행 스크리너다.
//
//   ① 2파가 1파를 61.8~78.6% 되돌림 (78.6%이 정배)
//   ② 3파가 1파 되돌림 61.8% 수준 또는 0-1-2 확장 161.8%
//   ③ 3→4 조정이 irregular failure 또는 시간 소요 flat
//   → 세 조건이 모이면 4파 종료 지점이 매수 자리, 5파를 길게
//
// 더불어 닐리의 터미널 임펄스 감별법을 구현한다:
//   1파·3파는 깔끔한 임펄스인데 5파가 abc처럼 끊긴다 + 2파와 4파가 겹친다

const TOL = 0.06;

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

// 값이 [lo,hi] 안에 드는지 (허용 오차 포함) + 범위 내 위치 점수
function within(v, lo, hi, tol = TOL) {
  if (!Number.isFinite(v)) return { ok: false, fit: 0 };
  const l = lo * (1 - tol);
  const h = hi * (1 + tol);
  if (v < l || v > h) return { ok: false, fit: 0 };
  return { ok: true, fit: 1 };
}

function nearOne(v, target, tol = TOL) {
  if (!Number.isFinite(v)) return { ok: false, fit: 0 };
  const dev = Math.abs(v - target) / target;
  return { ok: dev <= tol * 2, fit: Math.max(0, 1 - dev / (tol * 2)) };
}

// ---------------------------------------------------------------------------
// 조건 ③ — 3→4 조정이 irregular failure 또는 시간 소요 flat 인가
//
// 코드로 볼 수 있는 것은 두 가지다:
//   · 시간 — 3→4 구간이 다른 파동보다 봉을 많이 먹었는가 (flat/복합조정의 특징)
//   · 형태 — 3→4 사이에 중간 피벗이 여러 개 끼어 있는가 (지저분한 흐름)
// 단일 모노파동으로 깔끔하게 떨어지면 irregular도 flat도 아니다.
// ---------------------------------------------------------------------------
function judgeW3toW4(pivots, p3, p4) {
  const i3 = pivots.indexOf(p3);
  const i4 = pivots.indexOf(p4);
  if (i3 < 0 || i4 < 0) return { ok: false, why: '3→4 구간을 특정할 수 없음' };

  const inner = i4 - i3; // 사이에 낀 피벗 수 (1이면 단일 모노파동)
  const bars = p4.i - p3.i;

  return {
    innerPivots: inner - 1,
    bars,
    // 중간 피벗이 2개 이상이면 단일 모노파동이 아니다 = 지저분한 조정
    messy: inner - 1 >= 2,
  };
}

// ---------------------------------------------------------------------------
// 3대 조건 판정 — pv 는 [P0,P1,P2,P3,P4(,P5)] 형태의 피벗 배열
// ---------------------------------------------------------------------------
function screenDiagonal(pv, allPivots, opts = {}) {
  if (!Array.isArray(pv) || pv.length < 5) return null;
  const up = pv[1].price > pv[0].price;
  const sgn = up ? 1 : -1;
  const P = pv.map((p) => p.price);

  const w1 = sgn * (P[1] - P[0]);
  const w2 = -sgn * (P[2] - P[1]);
  const w3 = sgn * (P[3] - P[2]);
  const w4 = -sgn * (P[4] - P[3]);
  const w5 = pv.length > 5 ? sgn * (P[5] - P[4]) : null;
  if (!(w1 > 0 && w2 > 0 && w3 > 0 && w4 > 0)) return null;

  const conditions = [];

  // ① 2파 되돌림 61.8~78.6% (78.6%이 정배)
  const r2 = w2 / w1;
  const c1 = within(r2, 0.618, 0.786);
  conditions.push({
    id: 1,
    label: '2파 되돌림 61.8~78.6%',
    ok: c1.ok,
    detail: `실측 ${pct(r2)}` + (c1.ok ? (r2 >= 0.75 ? ' — 78.6% 정배' : ' — 61.8%대, 얕지만 충족') : ' — 범위 밖'),
    weight: 1.0,
  });

  // ② 3파가 1파 되돌림 61.8% 수준 또는 0-1-2 확장 161.8%
  //    A안: 3파 고점이 1파 되돌림 도구를 위로 연장한 61.8% 지점
  //         = P[0] + 1.618 * w1  (되돌림 61.8%를 위로 확장한 값)
  //    B안: 0-1-2 피보 확장 161.8% = P[2] + 1.618 * w1
  const targetA = P[0] + sgn * w1 * 1.618;
  const targetB = P[2] + sgn * w1 * 1.618;
  const hitA = nearOne(Math.abs(P[3] - P[0]) / w1, 1.618);
  const hitB = nearOne(w3 / w1, 1.618);
  const c2ok = hitA.ok || hitB.ok;
  conditions.push({
    id: 2,
    label: '3파가 61.8% 되돌림 확장 또는 0-1-2 확장 161.8%',
    ok: c2ok,
    detail:
      `A안 ${money(targetA)} (실측비 ${pct(Math.abs(P[3] - P[0]) / w1)}) · ` +
      `B안 ${money(targetB)} (3파/1파 ${pct(w3 / w1)})` +
      (c2ok ? ` — ${hitB.ok ? 'B안' : 'A안'} 충족` : ' — 둘 다 미달'),
    weight: 1.0,
  });

  // ③ 3→4 조정이 지저분한가
  const j = judgeW3toW4(allPivots || pv, pv[3], pv[4]);
  const avgBars =
    (pv[1].i - pv[0].i + (pv[2].i - pv[1].i) + (pv[3].i - pv[2].i)) / 3;
  const slow = j.bars != null && avgBars > 0 && j.bars > avgBars * 1.3;
  const c3ok = !!(j.messy || slow);
  conditions.push({
    id: 3,
    label: '3→4 조정이 irregular failure 또는 시간 소요 flat',
    ok: c3ok,
    detail:
      j.innerPivots != null
        ? `중간 피벗 ${j.innerPivots}개 · ${j.bars}봉 (앞 파동 평균 ${avgBars.toFixed(0)}봉)` +
          (c3ok ? (j.messy ? ' — 지저분한 조정 확인' : ' — 시간 소요형 확인') : ' — 단순 조정, 미충족')
        : j.why || '판정 불가',
    weight: 1.2, // 이 조건이 매수 준비 구간을 정의하므로 가장 무겁다
  });

  const passed = conditions.filter((c) => c.ok).length;
  const wsum = conditions.reduce((s, c) => s + c.weight, 0);
  const score = Math.round(
    (conditions.reduce((s, c) => s + (c.ok ? c.weight : 0), 0) / wsum) * 100
  );

  // 3파가 상대적으로 짧으면 5파가 크게 나온다는 신호
  const w3Short = w3 < w1 * 1.2;

  // 4파 종료 예상 구간 = 매수 준비 구간.
  // 다이아고날의 4파는 1파와 겹치므로 1파 영역 안쪽이 목표대다.
  const zoneA = P[1] - sgn * w3 * 0.382;
  const zoneB = P[1] - sgn * w3 * 0.5;
  const buyZone = { low: Math.min(zoneA, zoneB), high: Math.max(zoneA, zoneB) };

  // 5파 목표 — 자료의 "추세선 범위 1.5배" 및 확장 비율
  const targets = [];
  if (w1) {
    targets.push({ label: '5파 1파의 100%', price: P[4] + sgn * w1 * 1.0 });
    targets.push({ label: '5파 1파의 161.8%', price: P[4] + sgn * w1 * 1.618 });
  }

  return {
    passed,
    score,
    conditions,
    up,
    dirLabel: up ? '상승 다이아고날' : '하락 다이아고날',
    waves: { w1, w2, w3, w4, w5 },
    ratios: { r2, r3: w3 / w1, r4: w4 / w3 },
    w3Short,
    buyZone,
    targets,
    pivots: pv,
    verdict:
      passed === 3
        ? '3대 조건 모두 충족 — 4파 종료 지점이 매수 자리'
        : passed === 2
          ? '2개 충족 — 조건부 관심'
          : '조건 미달',
  };
}

// ---------------------------------------------------------------------------
// 터미널 임펄스 감별 (닐리) — 1·3파는 임펄스인데 5파가 abc처럼 끊긴다
// ---------------------------------------------------------------------------
function detectTerminal(pv, allPivots) {
  if (!Array.isArray(pv) || pv.length < 6) return null;
  const up = pv[1].price > pv[0].price;
  const P = pv.map((p) => p.price);

  // 2파와 4파가 겹치는가
  const overlap = up ? P[4] <= P[1] : P[4] >= P[1];
  if (!overlap) return null;

  // 5파 구간에 중간 피벗이 2개 이상 = abc처럼 끊긴 것
  const i4 = allPivots.indexOf(pv[4]);
  const i5 = allPivots.indexOf(pv[5]);
  const innerIn5 = i4 >= 0 && i5 >= 0 ? i5 - i4 - 1 : 0;

  // 1파·3파 구간은 상대적으로 깔끔해야 한다
  const i0 = allPivots.indexOf(pv[0]);
  const i1 = allPivots.indexOf(pv[1]);
  const i2 = allPivots.indexOf(pv[2]);
  const i3 = allPivots.indexOf(pv[3]);
  const innerIn1 = i0 >= 0 && i1 >= 0 ? i1 - i0 - 1 : 0;
  const innerIn3 = i2 >= 0 && i3 >= 0 ? i3 - i2 - 1 : 0;

  const choppy5 = innerIn5 >= 2;
  const clean13 = innerIn1 <= 1 && innerIn3 <= 1;

  if (!choppy5) return null;

  return {
    isTerminal: true,
    confidence: clean13 ? '높음' : '보통',
    detail:
      `5파 구간에 중간 전환점 ${innerIn5}개 — abc처럼 끊겼다. ` +
      `1파 ${innerIn1}개 / 3파 ${innerIn3}개로 ` +
      (clean13 ? '앞 파동은 깔끔해 터미널 조건에 부합한다.' : '앞 파동도 다소 지저분해 확신은 낮다.'),
    note:
      '터미널 임펄스는 2파와 4파가 겹치고 5파만 3파 구조로 끊긴다. ' +
      '겉모습은 임펄스지만 파동의 종류가 다르며, 완성 후 되돌림이 빠르고 깊다.',
  };
}

// ---------------------------------------------------------------------------
function computeDiagonal(candles, pivots, opts = {}) {
  const out = { screens: [], terminal: null, lines: [] };
  if (!Array.isArray(pivots) || pivots.length < 5) {
    out.lines.push('다이아고날: 피벗 5개 미만 — 판정 불가');
    return out;
  }

  // 최근 구간에서 5~6점 창을 훑는다
  const pool = pivots.slice(-10);
  const results = [];
  for (let take of [6, 5]) {
    for (let s = pool.length - take; s >= 0; s--) {
      const win = pool.slice(s, s + take);
      if (win.length !== take) continue;
      // 마지막 피벗이 전체의 마지막이어야 "지금 진행 중"인 구조
      if (win[win.length - 1] !== pool[pool.length - 1]) continue;
      // H/L 교대 필수
      let alt = true;
      for (let i = 1; i < win.length; i++) if (win[i].kind === win[i - 1].kind) alt = false;
      if (!alt) continue;

      const r = screenDiagonal(win, pivots);
      if (r && r.passed >= 2) results.push(r);
      if (take === 6 && !out.terminal) {
        const t = detectTerminal(win, pivots);
        if (t) out.terminal = t;
      }
    }
  }

  results.sort((a, b) => b.score - a.score);
  out.screens = results.slice(0, 2);

  // 문장화
  if (!out.screens.length) {
    out.lines.push('다이아고날 3대 조건: 2개 이상 충족하는 구조 없음');
  } else {
    for (const r of out.screens) {
      out.lines.push(`${r.dirLabel} — ${r.passed}/3 조건 충족 (${r.score}점) · ${r.verdict}`);
      for (const c of r.conditions) {
        out.lines.push(`   ${c.ok ? '✔' : '✘'} 조건${c.id} ${c.label}`);
        out.lines.push(`      ${c.detail}`);
      }
      if (r.w3Short) {
        out.lines.push('   ※ 3파가 상대적으로 짧다 — 5파가 크게 나올 수 있다는 신호');
      }
      out.lines.push(
        `   매수 준비 구간(4파 종료 예상): ${money(r.buyZone.low)} ~ ${money(r.buyZone.high)}`
      );
      out.lines.push(
        `   5파 목표: ${r.targets.map((t) => `${t.label} ${money(t.price)}`).join(' · ')}`
      );
    }
    out.lines.push('※ 3개 모두 충족해야 "4파 끝 매수, 5파 장기 보유" 셋업이 성립한다');
  }

  if (out.terminal) {
    out.lines.push('');
    out.lines.push(`터미널 임펄스 의심 (확신 ${out.terminal.confidence})`);
    out.lines.push(`   ${out.terminal.detail}`);
    out.lines.push(`   ${out.terminal.note}`);
  }

  return out;
}

module.exports = { computeDiagonal, screenDiagonal, detectTerminal };
