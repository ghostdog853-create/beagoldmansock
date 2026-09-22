'use strict';

// WAVE FLOOR — 엘리어트 파동 카운터
//
// 설계 원칙: 코드가 세고, LLM은 해석한다.
//
// LLM에게 캔들을 던지고 "파동을 세어봐"라고 하면 좌표 없는 환각이 나온다.
// 매번 다르게 센다. 그래서 여기서 피벗 수열로 파동 후보를 만들고, 엘리어트의
// 절대 규칙 3개로 무효 카운트를 걸러낸 뒤, 피보나치 정합도로 순위를 매긴다.
// LLM에게는 "살아남은 후보 목록"만 넘긴다.
//
// 절대 규칙 (깨지면 그 카운트는 무효):
//   R1. 2파는 1파의 시작점을 넘어 되돌리지 못한다
//   R2. 3파는 1·3·5파 중 가장 짧을 수 없다
//   R3. 4파는 1파의 가격 영역을 침범하지 못한다
//
// 가이드라인 (규칙이 아니라 점수):
//   2파 되돌림 50 / 61.8 / 78.6%
//   3파 확장   161.8 / 261.8%
//   4파 되돌림 23.6 / 38.2%
//   5파       1파의 61.8 / 100 / 161.8%
//   교대 지침 — 2파와 4파는 되돌림 성격이 달라야 한다

const NEELY = require('./neely-patterns');

const MIN_SCORE = 25; // 이 점수 미만 후보는 버린다

const FIB = {
  w2: [0.5, 0.618, 0.786],
  w3: [1.618, 2.618, 4.236],
  w4: [0.236, 0.382, 0.5],
  w5: [0.618, 1.0, 1.618],
};

function pct(n, dp = 1) {
  return `${(n * 100).toFixed(dp)}%`;
}

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

// 실제 비율이 가이드라인 목표 중 가장 가까운 것에 얼마나 부합하는지 (0~1)
function fibFit(actual, targets, tolerance = 0.3) {
  if (!Number.isFinite(actual) || actual <= 0) return { fit: 0, nearest: null, dev: null };
  let best = null;
  for (const t of targets) {
    const dev = Math.abs(actual - t) / t;
    if (!best || dev < best.dev) best = { nearest: t, dev };
  }
  return { fit: Math.max(0, 1 - best.dev / tolerance), nearest: best.nearest, dev: best.dev };
}

// ---------------------------------------------------------------------------
// 다이아고날(쐐기) 판정 — R3 면제의 근거 (통합본 5장)
//
// 주 추세 방향의 5파 구조인데 4파가 1파와 겹치는 유일한 형태다.
//   수렴형: 파동이 갈수록 작아진다 (w3<w1, w5<w3)
//   확산형: 갈수록 커진다
//   엔딩  : 5파 자리 — 추세 종료 임박, 강한 반전 신호
//   리딩  : 1파/A파 자리 — 추세 시작
// ---------------------------------------------------------------------------
function detectDiagonal(pv, up, w) {
  const P = pv.map((p) => p.price);
  // 겹침이 실제로 있어야 다이아고날이다
  const overlap = up ? P[4] <= P[1] : P[4] >= P[1];
  if (!overlap) return null;

  // 겹침이 지나치게 깊으면 구조가 무너진 것이지 쐐기가 아니다.
  // 4파가 2파 영역까지 먹으면 충격파 해석 자체를 포기한다.
  const tooDeep = up ? P[4] < P[2] : P[4] > P[2];
  if (tooDeep) return null;

  const { w1, w3, w5 } = w;
  let shape = null;
  if (w1 != null && w3 != null) {
    if (w5 != null) {
      if (w3 < w1 && w5 < w3) shape = '수렴형';
      else if (w3 > w1 && w5 > w3) shape = '확산형';
      else shape = '불규칙형';
    } else {
      shape = w3 < w1 ? '수렴형(진행)' : '확산형(진행)';
    }
  }

  // 겹침 깊이 — 1파 영역을 몇 % 먹었는지
  const w1Range = Math.abs(P[1] - P[0]);
  const bite = w1Range > 0 ? Math.abs(P[1] - P[4]) / w1Range : 0;

  return {
    isDiagonal: true,
    shape: shape || '판정 불가',
    overlapPct: bite * 100,
    // 5파까지 나왔으면 엔딩(종료 신호), 진행 중이면 아직 미확정
    position: pv.length > 5 ? '엔딩 다이아고날 가능 — 추세 종료 임박 신호' : '다이아고날 진행 중',
    note:
      '4파가 1파와 겹치지만 다이아고날에서는 정상이다(R3 면제). ' +
      (pv.length > 5
        ? '엔딩 다이아고날이면 완성 직후 되돌림이 빠르고 깊은 경향이 있다.'
        : '아직 5파가 완성되지 않아 리딩/엔딩 구분은 유보한다.'),
  };
}

// 피벗 수열로 충격파(1-2-3-4-5) 후보 하나를 만든다.
// dir: 'up' = 상승 충격파, 'down' = 하락 충격파
function buildImpulse(pv, dir, lastPrice) {
  const up = dir === 'up';
  const sgn = up ? 1 : -1;

  // 상승 충격파는 L,H,L,H,L,H 순으로 교대해야 한다
  if (!pv.length || pv[0].kind !== (up ? 'L' : 'H')) return null;
  for (let i = 1; i < pv.length; i++) {
    if (pv[i].kind === pv[i - 1].kind) return null;
  }

  const P = pv.map((p) => p.price);
  const len = (a, b) => sgn * (P[b] - P[a]);

  const w1 = pv.length > 1 ? len(0, 1) : null;
  const w2 = pv.length > 2 ? -len(1, 2) : null; // 되돌림이라 부호 반대
  const w3 = pv.length > 3 ? len(2, 3) : null;
  const w4 = pv.length > 4 ? -len(3, 4) : null;
  const w5 = pv.length > 5 ? len(4, 5) : null;

  // 파동 길이가 음수면 애초에 충격파 구조가 아니다
  for (const w of [w1, w2, w3, w4, w5]) {
    if (w != null && w <= 0) return null;
  }

  const violations = [];
  const checks = [];

  // R1 — 2파는 1파 시작점을 넘어 되돌리지 못한다
  if (pv.length > 2) {
    const ok = up ? P[2] > P[0] : P[2] < P[0];
    checks.push({ rule: 'R1', label: '2파가 1파 시작점을 넘지 않음', ok });
    if (!ok) violations.push('R1: 2파가 1파 시작점을 넘어 되돌렸다');
  }
  // R3 — 4파는 1파 가격 영역을 침범하지 못한다.
  //
  // 단, 다이아고날(쐐기)에서는 R3가 면제된다 — 4파가 1파와 겹치는 것이
  // 오히려 다이아고날의 정의다. R3 위반을 무조건 버리면 엔딩 다이아고날
  // (강한 추세 종료 신호)을 통째로 놓친다. 그래서 버리기 전에 먼저 확인한다.
  let diagonal = null;
  if (pv.length > 4) {
    const ok = up ? P[4] > P[1] : P[4] < P[1];
    if (!ok) {
      diagonal = detectDiagonal(pv, up, { w1, w2, w3, w4, w5 });
    }
    checks.push({
      rule: 'R3',
      label: diagonal ? '4파가 1파 영역을 침범 — 다이아고날로 해석' : '4파가 1파 영역을 침범하지 않음',
      ok: ok || !!diagonal,
    });
    if (!ok && !diagonal) violations.push('R3: 4파가 1파 가격 영역을 침범했다');
  }
  // R2 — 3파는 최단 파동일 수 없다
  if (w1 != null && w3 != null && w5 != null) {
    const ok = !(w3 < w1 && w3 < w5);
    checks.push({ rule: 'R2', label: '3파가 최단 파동이 아님', ok });
    if (!ok) violations.push('R2: 3파가 1·5파보다 짧다');
  } else if (w1 != null && w3 != null) {
    // 5파가 아직 없으면 약한 형태로만 본다
    const ok = w3 >= w1 * 0.9;
    checks.push({ rule: 'R2*', label: '3파가 1파보다 크게 짧지 않음 (잠정)', ok });
    if (!ok) violations.push('R2*: 3파가 1파보다 뚜렷이 짧다');
  }

  // 하드 체크 — 통합본 2.3. 위반하면 그 카운트는 성립하지 않는다.
  if (w3 != null && w4 != null) {
    const ok = w4 <= w3 * 0.5;
    checks.push({ rule: 'H1', label: '4파가 3파의 50%를 넘지 않음', ok });
    if (!ok) violations.push(`H1: 4파가 3파의 ${((w4 / w3) * 100).toFixed(1)}%를 되돌렸다 — 50% 초과면 4파가 아니다`);
  }
  if (w1 != null && w2 != null && w2 > w1 * 0.786) {
    // 폐기까지는 아니고 경고 — 조정 AB파일 가능성
    checks.push({
      rule: 'H2',
      label: '2파가 1파의 0.786 이내',
      ok: false,
      warnOnly: true,
      note: `2파가 ${((w2 / w1) * 100).toFixed(1)}% 되돌렸다 — 0.786 초과면 2파가 아니라 조정 AB파일 수 있다`,
    });
  }

  // 절단(truncation) — 5파가 3파 고점을 넘지 못하고 끝났는가
  let truncation = null;
  if (pv.length > 5) {
    const beyond = up ? P[5] > P[3] : P[5] < P[3];
    if (!beyond) {
      truncation = {
        isTruncated: true,
        shortfall: Math.abs(P[3] - P[5]),
        note:
          '5파가 3파 고점을 넘지 못했다(절단). 3파가 예외적으로 길고 과도하게 늘어났을 때 ' +
          '발생하며, 절단 후에는 보통 큰 반전이 따른다.',
      };
    }
  }

  // 파동별 길이·기간 (아래 닐리 관문과 시간 채점이 공유한다)
  const bars = [];
  const lens = [];
  for (let i = 1; i < pv.length; i++) {
    bars.push(pv[i].i - pv[i - 1].i);
    lens.push(Math.abs(P[i] - P[i - 1]));
  }

  // ── 닐리 4장 · 유사성과 균형의 법칙 ────────────────────────────────────
  // 인접한 두 파동이 가격·시간 유사성 중 하나도 못 채우면 같은 등급이 아니다.
  // 등급이 다른 파동을 한 카운트로 묶으면 그 위의 계산이 전부 무의미해진다.
  const simFails = [];
  for (let i = 1; i < lens.length; i++) {
    const r = NEELY.checkSimilarity(lens[i - 1], lens[i], bars[i - 1], bars[i]);
    if (!r.ok) simFails.push(`${i}~${i + 1}파`);
  }
  const similarity = {
    fails: simFails,
    ok: simFails.length === 0,
    note: simFails.length
      ? `${simFails.join(', ')} 구간이 가격·시간 유사성을 둘 다 못 채웠다 — 같은 등급이 아닐 수 있다`
      : null,
  };
  checks.push({
    rule: 'N4',
    label: '유사성과 균형 (인접 파동이 같은 등급인가)',
    ok: similarity.ok,
    warnOnly: true,
    note: similarity.note,
  });

  // ── 닐리 9장 · 시간론 법칙 ────────────────────────────────────────────
  // 같은 등급의 인접한 3개 파동이 모두 같은 형성 기간을 가질 수 없다.
  const timeViolations = [];
  const nearBars = (x, y) => Math.abs(x - y) / Math.max(x, y) < 0.15;
  for (let i = 2; i < bars.length; i++) {
    const a = bars[i - 2], b = bars[i - 1], c = bars[i];
    if (a > 0 && b > 0 && c > 0 && nearBars(a, b) && nearBars(b, c)) {
      timeViolations.push(`${i - 1}~${i + 1}파`);
    }
  }
  const timeRule = {
    violations: timeViolations,
    ok: timeViolations.length === 0,
    note: timeViolations.length
      ? `${timeViolations.join(', ')}의 형성 기간이 모두 비슷하다 — 마지막 파동이 미완성이거나 셋이 같은 등급이 아니다`
      : null,
  };
  checks.push({
    rule: 'N9',
    label: '시간론 법칙 (인접 3파동의 기간이 모두 같을 수 없다)',
    ok: timeRule.ok,
    warnOnly: true,
    note: timeRule.note,
  });

  // ── 닐리 9장 · 예외의 법칙 ────────────────────────────────────────────
  // 중요 원칙 하나가 깨지는 것은 삼각형·터미널·패턴 마지막에서 허용된다.
  // 그러나 2개 이상이 동시에 깨지면 파동을 잘못 파악한 것이다.
  if (violations.length >= 2) {
    return {
      valid: false,
      violations: violations.concat([
        '예외의 법칙: 중요 원칙이 2개 이상 동시에 깨졌다 — 파동을 잘못 파악한 것이다',
      ]),
      dir,
      pivots: pv,
    };
  }
  if (violations.length) return { valid: false, violations, dir, pivots: pv };

  // ---- 피보나치 정합도 채점 ----
  const ratios = {};
  const fits = [];
  if (w1 && w2) {
    ratios.w2 = w2 / w1;
    ratios.w2fit = fibFit(ratios.w2, FIB.w2);
    fits.push({ weight: 1.0, ...ratios.w2fit });
  }
  if (w1 && w3) {
    ratios.w3 = w3 / w1;
    ratios.w3fit = fibFit(ratios.w3, FIB.w3);
    fits.push({ weight: 1.4, ...ratios.w3fit }); // 3파 정합도를 가장 무겁게
  }
  if (w3 && w4) {
    ratios.w4 = w4 / w3;
    ratios.w4fit = fibFit(ratios.w4, FIB.w4);
    fits.push({ weight: 1.0, ...ratios.w4fit });
  }
  if (w1 && w5) {
    ratios.w5 = w5 / w1;
    ratios.w5fit = fibFit(ratios.w5, FIB.w5);
    fits.push({ weight: 0.8, ...ratios.w5fit });
  }

  let score = 0;
  if (fits.length) {
    const wsum = fits.reduce((s, f) => s + f.weight, 0);
    score = (fits.reduce((s, f) => s + f.fit * f.weight, 0) / wsum) * 100;
  }

  // 교대 지침 — 2파와 4파의 되돌림 깊이가 다르면 가점
  let alternation = null;
  if (ratios.w2 != null && ratios.w4 != null) {
    const diff = Math.abs(ratios.w2 - ratios.w4);
    alternation = { diff, ok: diff > 0.15 };
    score += alternation.ok ? 6 : -6;
  }

  // ── 시간 비율 채점 — 닐리가 강조하는 나머지 절반 ──────────────────────
  //   · 3파 확장 시 1파와 5파는 크기·지속시간이 거의 같다
  //   · 2파는 되돌림 깊고 시간 짧다 ↔ 4파는 얕고 길다 (균형)
  const time = { bars };
  if (bars.length >= 5 && bars[0] > 0) {
    time.w1w5 = bars[4] / bars[0];
    if (w3 != null && w1 != null && w3 > w1 * 1.5) {
      time.expectedSimilar = true;
      time.aligned = Math.abs(time.w1w5 - 1) < 0.4;
      score += time.aligned ? 5 : -5;
    }
  }
  if (bars.length >= 4 && bars[1] > 0) {
    time.w2w4 = bars[3] / bars[1];
    if (ratios.w2 != null && ratios.w4 != null) {
      const deeper2 = ratios.w2 > ratios.w4;
      const longer4 = time.w2w4 > 1;
      time.balanced = deeper2 === longer4;
      score += time.balanced ? 5 : -5;
    }
  }

  // 교대의 방향성 — 2파 되돌림이 4파보다 큰 것이 정상이다 (닐리 2.4)
  if (ratios.w2 != null && ratios.w4 != null && ratios.w2 <= ratios.w4) {
    score -= 4;
  }

  // 닐리 관문을 못 넘긴 후보는 점수를 깎되 폐기하지는 않는다 —
  // 삼각형·터미널에서는 예외가 허용되므로 후보 자체는 남겨야 한다.
  if (!similarity.ok) score -= 8 * similarity.fails.length;
  if (!timeRule.ok) score -= 6 * timeRule.violations.length;

  // ---- 현재 위치 · 무효화 레벨 ----
  const stage = pv.length - 1; // 확정된 파동 수

  // 완성도 가중 — 파동 2개(비율 1개)짜리 카운트가 4파까지 확인된 카운트보다
  // 높은 점수를 받으면 순위가 거꾸로 선다. 근거가 적을수록 확신도 낮아야 한다.
  const completeness = 0.55 + 0.09 * Math.min(stage, 5);
  score = Math.max(0, Math.min(100, score * completeness));
  const stageName = ["시작", "1파 완성", "2파 완성", "3파 완성", "4파 완성", "5파 완성"][stage] || "?";
  const inProgress = stage < 5 ? stage + 1 : null;

  let invalidation = null;
  let invalidReason = '';
  if (inProgress === 2) {
    invalidation = P[0];
    invalidReason = '2파 진행 중 — 1파 시작점 이탈 시 무효 (R1)';
  } else if (inProgress === 3) {
    invalidation = P[2];
    invalidReason = '3파 진행 중 — 2파 저점 이탈 시 카운트 무효';
  } else if (inProgress === 4) {
    invalidation = P[1];
    invalidReason = '4파 진행 중 — 1파 영역 침범 시 무효 (R3)';
  } else if (inProgress === 5) {
    invalidation = P[4];
    invalidReason = '5파 진행 중 — 4파 저점 이탈 시 무효';
  } else if (stage === 5) {
    invalidation = P[4];
    invalidReason = '5파 완성 — 4파 저점 이탈이면 조정 국면 진입 확인';
  }

  // ---- 목표가 투영 ----
  const targets = [];
  if (inProgress === 2 && w1) {
    for (const r of [0.5, 0.618]) targets.push({ label: `2파 ${pct(r)} 되돌림`, price: P[1] - sgn * w1 * r });
  } else if (inProgress === 3 && w1) {
    for (const r of [1.618, 2.618]) targets.push({ label: `3파 ${pct(r)} 목표`, price: P[2] + sgn * w1 * r });
  } else if (inProgress === 4 && w3) {
    for (const r of [0.236, 0.382]) targets.push({ label: `4파 ${pct(r)} 되돌림`, price: P[3] - sgn * w3 * r });
  } else if (inProgress === 5 && w1) {
    for (const r of [0.618, 1.0, 1.618]) targets.push({ label: `5파 1파의 ${pct(r)}`, price: P[4] + sgn * w1 * r });
  } else if (stage === 5) {
    const total = sgn * (P[5] - P[0]);
    for (const r of [0.382, 0.618]) targets.push({ label: `조정 ${pct(r)} 되돌림`, price: P[5] - sgn * total * r });
  }

  return {
    valid: true,
    type: 'impulse',
    dir,
    dirLabel: up ? '상승 충격파' : '하락 충격파',
    stage,
    stageName,
    inProgress,
    score: Math.round(score),
    pivots: pv,
    waves: { w1, w2, w3, w4, w5 },
    ratios,
    checks,
    diagonal,
    truncation,
    similarity,
    timeRule,
    time,
    alternation,
    invalidation,
    invalidReason,
    targets,
    lastPrice,
  };
}

// 조정파 ABC (지그재그) 후보
function buildCorrective(pv, dir, lastPrice) {
  const up = dir === 'up'; // 'up' = 상승 조정 (하락 추세 속 반등)
  const sgn = up ? 1 : -1;
  if (pv.length < 3 || pv[0].kind !== (up ? 'L' : 'H')) return null;
  for (let i = 1; i < pv.length; i++) if (pv[i].kind === pv[i - 1].kind) return null;

  const P = pv.map((p) => p.price);
  const a = sgn * (P[1] - P[0]);
  const b = pv.length > 2 ? -sgn * (P[2] - P[1]) : null;
  const c = pv.length > 3 ? sgn * (P[3] - P[2]) : null;
  if (a <= 0 || (b != null && b <= 0) || (c != null && c <= 0)) return null;

  // 지그재그 조건 — B파는 A파 시작점을 넘지 않는다
  if (b != null) {
    const ok = up ? P[2] > P[0] : P[2] < P[0];
    if (!ok) {
      return { valid: false, violations: ['B파가 A파 시작점을 넘었다 — 지그재그 아님'], dir, pivots: pv };
    }
  }

  const ratios = {};
  const fits = [];
  if (a && b) {
    ratios.b = b / a;
    ratios.bfit = fibFit(ratios.b, [0.382, 0.5, 0.618]);
    fits.push({ weight: 1.0, ...ratios.bfit });
  }
  if (a && c) {
    ratios.c = c / a;
    ratios.cfit = fibFit(ratios.c, [0.618, 1.0, 1.618]);
    fits.push({ weight: 1.2, ...ratios.cfit });
  }
  let score = 0;
  if (fits.length) {
    const wsum = fits.reduce((s, f) => s + f.weight, 0);
    score = (fits.reduce((s, f) => s + f.fit * f.weight, 0) / wsum) * 100;
  }

  const stage = pv.length - 1;
  const stageName = ['시작', 'A파 완성', 'B파 완성', 'C파 완성'][stage] || '?';
  const nextWave = stage < 3 ? ['', 'B', 'C'][stage] : null;

  const targets = [];
  if (nextWave === 'C' && a) {
    for (const r of [1.0, 1.618]) targets.push({ label: `C파 A파의 ${pct(r)}`, price: P[2] + sgn * a * r });
  }

  return {
    valid: true,
    type: 'corrective',
    dir,
    dirLabel: up ? '상승 조정 (ABC)' : '하락 조정 (ABC)',
    stage,
    stageName,
    inProgress: nextWave ? `${nextWave}파` : null,
    score: Math.round(score),
    pivots: pv,
    waves: { a, b, c },
    ratios,
    invalidation: b != null ? P[0] : null,
    invalidReason: 'A파 시작점 이탈 시 지그재그 카운트 무효',
    targets,
    lastPrice,
  };
}

// 가능한 카운트를 전부 만들어 유효한 것만 점수순으로 반환.
// 하나의 "정답"을 강요하지 않고 복수 시나리오를 남기는 것이 엘리어트의 정직한 사용법이다.
function countWaves(pivots, lastPrice, opts = {}) {
  const maxCandidates = opts.maxCandidates || 4;
  if (!Array.isArray(pivots) || pivots.length < 3) {
    return { candidates: [], note: '피벗이 3개 미만 — 파동 카운트 불가' };
  }

  const results = [];
  const pool = pivots.slice(-12); // 최근 12개 피벗 안에서 시작점을 여러 개 시도
  const lastPivot = pool[pool.length - 1];

  for (let start = 0; start < pool.length - 2; start++) {
    for (let take = 6; take >= 3; take--) {
      const win = pool.slice(start, start + take);
      if (win.length < 3) continue;
      // 마지막 피벗이 전체의 마지막이어야 "지금 진행 중"인 카운트다
      if (win[win.length - 1] !== lastPivot) continue;

      for (const dir of ['up', 'down']) {
        const imp = buildImpulse(win, dir, lastPrice);
        if (imp && imp.valid && imp.score >= MIN_SCORE) results.push(imp);
        if (win.length <= 4) {
          const cor = buildCorrective(win, dir, lastPrice);
          if (cor && cor.valid && cor.score >= MIN_SCORE) results.push(cor);
        }
      }
    }
  }

  // 같은 피벗 조합·같은 타입은 하나만 남긴다
  const seen = new Set();
  const uniq = [];
  for (const r of results.sort((a, b) => b.score - a.score)) {
    const key = `${r.type}:${r.dir}:${r.pivots.map((p) => p.i).join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(r);
    if (uniq.length >= maxCandidates) break;
  }

  return {
    candidates: uniq,
    note: uniq.length ? '' : '유효한 파동 카운트 없음 — 규칙을 만족하는 구조가 잡히지 않는다',
  };
}

// LLM 프롬프트용 문장화 — 이게 이 모듈의 최종 산출물이다.
function describeWaves(result) {
  if (!result || !result.candidates || !result.candidates.length) {
    return [result && result.note ? result.note : '파동 카운트 불가'];
  }
  const out = [];
  result.candidates.forEach((c, idx) => {
    const tag = String.fromCharCode(65 + idx); // A, B, C…
    const prog = c.inProgress
      ? ` · 현재 ${typeof c.inProgress === 'number' ? c.inProgress + '파' : c.inProgress} 진행 중`
      : '';
    out.push(`후보 ${tag} (정합도 ${c.score}점) — ${c.dirLabel} · ${c.stageName}${prog}`);

    const P = c.pivots;
    const labels = c.type === 'impulse' ? ['0', '1', '2', '3', '4', '5'] : ['0', 'A', 'B', 'C'];
    for (let i = 1; i < P.length; i++) {
      const from = P[i - 1];
      const to = P[i];
      const chg = ((to.price - from.price) / from.price) * 100;
      out.push(`   ${labels[i]}파: ${money(from.price)} → ${money(to.price)} (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)`);
    }

    const r = c.ratios || {};
    const fib = [];
    if (r.w2 != null) fib.push(`2파 되돌림 ${pct(r.w2)} (근접 ${pct(r.w2fit.nearest)})`);
    if (r.w3 != null) fib.push(`3파 확장 ${pct(r.w3)} (근접 ${pct(r.w3fit.nearest)})`);
    if (r.w4 != null) fib.push(`4파 되돌림 ${pct(r.w4)} (근접 ${pct(r.w4fit.nearest)})`);
    if (r.w5 != null) fib.push(`5파 ${pct(r.w5)} (근접 ${pct(r.w5fit.nearest)})`);
    if (r.b != null) fib.push(`B파 ${pct(r.b)} (근접 ${pct(r.bfit.nearest)})`);
    if (r.c != null) fib.push(`C파 ${pct(r.c)} (근접 ${pct(r.cfit.nearest)})`);
    if (fib.length) out.push(`   피보나치: ${fib.join(' · ')}`);

    if (c.targets && c.targets.length) {
      out.push(`   투영 목표: ${c.targets.map((t) => `${t.label} ${money(t.price)}`).join(' · ')}`);
    }
    if (c.similarity && !c.similarity.ok) {
      out.push(`   ⚠ 유사성·균형: ${c.similarity.note}`);
    }
    if (c.timeRule && !c.timeRule.ok) {
      out.push(`   ⚠ 시간론: ${c.timeRule.note}`);
    }
    if (c.truncation) {
      out.push(`   ⚠ 절단: ${c.truncation.note}`);
    }
    if (c.diagonal) {
      out.push(`   다이아고날 ${c.diagonal.shape} — ${c.diagonal.position}`);
    }
    if (c.invalidation != null) {
      out.push(`   무효화: ${money(c.invalidation)} — ${c.invalidReason}`);
    }
  });
  return out;
}

module.exports = { countWaves, describeWaves, buildImpulse, buildCorrective, fibFit };
