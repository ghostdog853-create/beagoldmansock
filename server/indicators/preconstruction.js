'use strict';

// WAVE FLOOR — 닐리 3장 「논리적 사전 구성법칙」
//
// 되돌림 법칙(neowave.js)은 m2/m1 로 **법칙 번호**를, m0/m1 로 **조건 문자**를 정한다.
// 거기까지 하면 법칙별 구조기호 목록이 나오는데, 그 목록은 보통 3~6개다.
// 그 중 어느 것인지를 가르는 것이 이 절이다.
//
// 원문의 형식은 이렇다:
//
//   법칙 1 {:5 / (:c3) / (x:c3) / [:sL3] / [:s5]}
//     조건 'a' — m0가 m1의 61.8%보다 작은 경우
//       "만약 m2가 형성되는 데 m1과 같거나 그보다 긴 시간이 걸렸거나 …
//        m1의 끝에 :5를 기입하라."
//
// 즉 **문단마다 첫 문장이 관문**이고, 통과하면 구조기호가 확정된다. 원문도 그렇게
// 지시한다 — "각각의 단락의 첫 번째 문장을 잘 따르는 것이 가장 중요하다. 만약 첫
// 번째 문장에서 기술된 조건이 실제 시장 움직임에 반영되지 않는다면 다음 단락으로
// 옮겨가야 한다."(p.124)
//
// ── 수록 범위에 대한 정직한 고지 ──────────────────────────────────────────
// 이 절은 원서에서 36,000자가 넘고 문단 수백 개다. 스캔 OCR 품질도 고르지 않아
// (m0 가 "mO"·"m07^"·"애"로 깨진 곳이 많다) 전량을 기계적으로 옮기면 없는 조건을
// 만들어내게 된다. 그래서 **원문을 직접 읽고 확인한 문단만** 표에 담았고,
// 각 항목에 조건 문자와 쪽수를 붙였다. 담기지 않은 조건은 `COVERAGE` 가
// "미수록"으로 보고하며, 그 경우 엔진은 기존처럼 등급별 목록만 낸다.
// **수록되지 않았다는 사실을 감추지 마라.** 그것이 이 표의 신뢰를 지키는 유일한 방법이다.

// ── 원문의 오차 규약 (p.123) ────────────────────────────────────────────────
//   · 비율 관계에는 상하 4%p 여유를 준다. "61.8% 관계"는 58~66% 를 뜻한다.
//   · "거의(almost)" · "가깝게(close to)" 는 언급된 비율의 10% 이내를 뜻한다.
//   · 반면 **시간 비교는 문자 그대로 정확히** 적용한다.
//   · m1 의 되돌림 시간을 비교할 때는 m1 의 소요 시간에 한 단위를 더한 뒤 비교한다.
const RATIO_TOL_PP = 4.0;
const ALMOST_TOL = 0.10;

function nearRatio(valuePct, targetPct) {
  return valuePct != null && Math.abs(valuePct - targetPct) <= RATIO_TOL_PP;
}

function almost(valuePct, targetPct) {
  return valuePct != null && Math.abs(valuePct - targetPct) <= targetPct * ALMOST_TOL;
}

function between(valuePct, lo, hi) {
  return valuePct != null && valuePct >= lo - RATIO_TOL_PP && valuePct <= hi + RATIO_TOL_PP;
}

// ---------------------------------------------------------------------------
// m(-2) … m5 컨텍스트
//
// neowave.js 의 resolveNeighbors 는 관측의 법칙에 따라 m0·m2 를 병합해 잡지만,
// 이 절의 m(-2)…m5 는 차트에 순서대로 매기는 라벨이다. 그래서 여기서는 피벗
// 인덱스를 그대로 세어 만든다. m1 = pivots[i] → pivots[i+1] 이 기준점이다.
// ---------------------------------------------------------------------------
function seg(pivots, a, b, scale) {
  const p = pivots[a];
  const q = pivots[b];
  if (!p || !q) return { exists: false };
  const len = scale ? scale.len(p.price, q.price) : Math.abs(q.price - p.price);
  const bars = q.i - p.i;
  return {
    exists: true,
    from: p,
    to: q,
    len,
    bars,
    up: q.price > p.price,
    slope: bars > 0 ? len / bars : null,
  };
}

function buildContext(pivots, i, scale) {
  const m = {
    'm-3': seg(pivots, i - 4, i - 3, scale),
    'm-2': seg(pivots, i - 3, i - 2, scale),
    'm-1': seg(pivots, i - 2, i - 1, scale),
    m0: seg(pivots, i - 1, i, scale),
    m1: seg(pivots, i, i + 1, scale),
    m2: seg(pivots, i + 1, i + 2, scale),
    m3: seg(pivots, i + 2, i + 3, scale),
    m4: seg(pivots, i + 3, i + 4, scale),
    m5: seg(pivots, i + 4, i + 5, scale),
  };
  // 자주 쓰는 비율 (백분율)
  const r = (a, b) => (m[a].exists && m[b].exists && m[b].len > 0 ? (m[a].len / m[b].len) * 100 : null);
  m.ratios = {
    m0m1: r('m0', 'm1'),
    m2m1: r('m2', 'm1'),
    m3m1: r('m3', 'm1'),
    m3m2: r('m3', 'm2'),
    'm-1m0': r('m-1', 'm0'),
    'm-1m1': r('m-1', 'm1'),
  };
  // 시간 비교는 정확히 — 다만 m1 되돌림 시간 비교에는 한 단위를 더한다 (p.123)
  m.timeAtLeast = (a, b) => m[a].exists && m[b].exists && m[a].bars >= m[b].bars;
  m.retracedWithinM1Time = () =>
    m.m1.exists && m.m2.exists && m.m2.bars <= m.m1.bars + 1;

  // "m4가 m0의 끝을 넘어서지 않는다" — m0의 끝은 m1의 시작점이다.
  // m0·m2·m4 는 같은 방향이므로, m1 이 상승이면 m4 의 끝이 m1 시작가 위에 있어야 한다.
  m.m4WithinM0End = () => {
    if (!m.m4.exists || !m.m1.exists) return false;
    const p0 = m.m1.from.price;
    return m.m1.up ? m.m4.to.price >= p0 : m.m4.to.price <= p0;
  };
  // 기울기 비교 — 길이/봉수
  m.steeper = (a, b) =>
    m[a].exists && m[b].exists && m[a].slope != null && m[b].slope != null && m[a].slope > m[b].slope;
  m.longer = (a, b) => m[a].exists && m[b].exists && m[a].len > m[b].len;

  // "byKey 가 waveKey 를 완전히 되돌린다" (법칙 4~7에서 반복되는 관용구) —
  // byKey 의 종점이 waveKey 시작가를 (waveKey 반대 방향으로) 넘어섰는가.
  m.fullyRetraces = (byKey, waveKey) => {
    if (!m[byKey].exists || !m[waveKey].exists) return false;
    const startPrice = m[waveKey].from.price;
    return m[waveKey].up ? m[byKey].to.price <= startPrice : m[byKey].to.price >= startPrice;
  };
  // "waveKey 가 자신이 형성된 시간과 같거나 짧은 시간 내에" — byKey(되돌리는 파동)의 봉수가
  // waveKey 자신의 봉수를 넘지 않는가.
  m.retracedWithinOwnTime = (byKey, waveKey) =>
    m[byKey].exists && m[waveKey].exists && m[byKey].bars <= m[waveKey].bars;
  // X가 Y의 N% 이상/이하로 되돌려졌는가 (retracer 길이 ÷ 원파동 길이)
  m.retracePct = (byKey, waveKey) =>
    m[byKey].exists && m[waveKey].exists && m[waveKey].len > 0 ? (m[byKey].len / m[waveKey].len) * 100 : null;

  return m;
}

// ---------------------------------------------------------------------------
// 표 — 원문에서 직접 확인한 문단만 담는다
//
//   rule / cond : 어느 법칙 어느 조건의 문단인가
//   gate        : 원문 첫 문장(관문)을 한국어로 옮긴 것
//   when(m)     : 그 관문의 코드판
//   emit        : 관문을 통과했을 때 기입하라고 지시된 구조기호
//   exclusive   : 원문이 "이것뿐"이라고 못박은 경우에만 true
//   page        : 원서 쪽수
// ---------------------------------------------------------------------------
const ENTRIES = [
  // ── 법칙 1 {:5 / (:c3) / (x:c3) / [:sL3] / [:s5]} ────────────────────────
  {
    id: 'R1a-1', rule: 1, cond: 'a', page: 'p.125',
    gate: 'm2가 m1과 같거나 긴 시간에 걸쳐 형성되었거나, m2가 m3와 같거나 긴 시간에 걸쳐 형성됨',
    when: (m) => m.timeAtLeast('m2', 'm1') || m.timeAtLeast('m2', 'm3'),
    emit: [':5'], exclusive: false,
    note: 'm1 의 끝에 :5 를 기입하라',
  },
  {
    id: 'R1a-2', rule: 1, cond: 'a', page: 'p.125',
    gate: 'm(-1)이 m0의 100~161.8%이고, m0가 m1의 61.8%와 거의 같고, m4가 m0의 끝을 넘지 않음',
    when: (m) =>
      between(m.ratios['m-1m0'], 100, 161.8) &&
      almost(m.ratios.m0m1, 61.8) &&
      m.m4WithinM0End(),
    emit: [':s5'], exclusive: false,
    note: 'm2가 x파동(x:c3)이고 m1은 복합패턴 내부 플랫조정의 마지막 내부파동이다',
  },
  {
    id: 'R1b-1', rule: 1, cond: 'b', page: 'p.127',
    gate: '조건 b 자체 (m0가 m1의 61.8% 이상 100% 미만) — 추가 조건 없음',
    when: () => true,
    emit: [':5'], exclusive: false,
    note: ':5를 m1의 끝에 기록하라 (조건 b 는 무조건 :5 로 시작한다)',
  },
  {
    id: 'R1b-2', rule: 1, cond: 'b', page: 'p.127',
    gate: 'm(-1)이 m0의 100~161.8%이고, m4가 m0의 끝을 넘지 않음',
    when: (m) => between(m.ratios['m-1m0'], 100, 161.8) && m.m4WithinM0End(),
    emit: [':s5'], exclusive: false,
    note: 'm1은 m2가 조파동인 복합조정 내 플랫조정의 마지막 파동일 수 있다 (m2 끝에 x:c3?)',
  },
  {
    id: 'R1c-1', rule: 1, cond: 'c', page: 'p.127',
    gate: '조건 c 자체 (m0가 m1의 100~161.8%) — 추가 조건 없음',
    when: () => true,
    emit: [':5'], exclusive: false,
    note: 'm1의 끝에 :5를 기입하라',
  },
  {
    id: 'R1d-1', rule: 1, cond: 'd', page: 'p.128',
    gate: '조건 d 자체 (m0가 m1의 161.8% 초과)',
    when: () => true,
    emit: [':5'], exclusive: true,
    note: '원문: "이런 상황에서는 하나의 가능성만이 존재한다" — :5 외의 후보는 없다',
  },

  // ── 법칙 2 {:5 / (:sL3) / [:c3] / [:s5]} ─────────────────────────────────
  {
    id: 'R2a-1', rule: 2, cond: 'a', page: 'p.128',
    gate: '조건 a 자체 (m0가 m1의 38.2% 미만) — 추가 조건 없음',
    when: () => true,
    emit: [':5'], exclusive: false,
    note: 'm1의 끝에 :5라고 표시하라',
  },
  {
    id: 'R2a-2', rule: 2, cond: 'a', page: 'p.128',
    gate: 'm4가 m0의 끝을 넘지 않음',
    when: (m) => m.m4WithinM0End(),
    emit: [':s5'], exclusive: false,
    note: 'm1은 복합조정 내부에서 조정패턴을 끝내는 파동이고 m2가 조파동이다 (m2 끝에 x:c3?)',
  },
  {
    id: 'R2b-1', rule: 2, cond: 'b', page: 'p.130',
    gate: '조건 b 자체 (m0가 m1의 38.2~61.8%) — 추가 조건 없음',
    when: () => true,
    emit: [':5'], exclusive: false,
    note: 'm1의 끝에 :5를 기입하라',
  },
  {
    id: 'R2c-1', rule: 2, cond: 'c', page: 'p.131',
    gate: '조건 c 자체 (m0가 m1의 61.8% 이상 100% 미만)',
    when: () => true,
    emit: [':5'], exclusive: false,
    note: '원문: "이 경우 모든 상황에서 m1의 끝에 :5라고 기록하라"',
  },
  {
    id: 'R2c-2', rule: 2, cond: 'c', page: 'p.131',
    gate: 'm4가 m0의 끝을 넘지 않음',
    when: (m) => m.m4WithinM0End(),
    emit: [':s5'], exclusive: false,
    note: 'm1은 m2가 x파동인 복합패턴 내 플랫패턴의 마지막 파동일 수 있다',
  },
  {
    id: 'R2d-1', rule: 2, cond: 'd', page: 'p.132',
    gate: 'm2가 m1과 같거나 많은 시간을 소비했거나, m2가 m3와 같거나 긴 시간에 걸쳐 형성됨',
    when: (m) => m.timeAtLeast('m2', 'm1') || m.timeAtLeast('m2', 'm3'),
    emit: [':5'], exclusive: false,
    note: 'm1의 마지막 부분에 :5라고 기입하라',
  },
  {
    id: 'R2d-2', rule: 2, cond: 'd', page: 'p.133',
    gate: 'm3가 m1보다 짧고, m1이 m0보다 짧은 시간에 형성되고, m2가 m1과 같거나 더 오래 걸림',
    when: (m) =>
      m.m3.exists && m.m1.exists && m.m3.len < m.m1.len &&
      m.m0.exists && m.m1.bars < m.m0.bars &&
      m.timeAtLeast('m2', 'm1'),
    emit: [':5'], exclusive: false,
    note: 'm1은 m3로 끝나는 지그재그의 한 부분일 가능성이 높다',
  },
  {
    id: 'R2e-1', rule: 2, cond: 'e', page: 'p.134',
    gate: '조건 e 자체 (m0가 m1의 161.8% 초과)',
    when: () => true,
    emit: [':5'], exclusive: false,
    note: '원문: "어떤 상황에서도 :5가 m1의 구조기호가 될 가능성이 매우 높다"',
  },
  {
    id: 'R2e-2', rule: 2, cond: 'e', page: 'p.134',
    gate: 'm3가 m1보다 짧고 기울기가 완만함',
    when: (m) =>
      m.m3.exists && m.m1.exists && m.m3.len < m.m1.len && m.steeper('m1', 'm3'),
    emit: [':5'], exclusive: true,
    note: '원문: "선택 대상은 :5밖에 없다"',
  },

  // ── 법칙 3 {:F3/:c3/:s5/:5/(:sL3)/[:L5]} ──────────────────────────────────
  // 조건 a~c 는 m3/m1 의 3구간(>261.8% · 161.8~261.8% · 100~161.8%)으로 갈리고,
  // 조건 d~f 는 같은 3구간을 m3/m2 로 잰다 (원문이 그렇게 바뀐다 — p.136 이후).
  {
    id: 'R3a-1', rule: 3, cond: 'a', page: 'p.132',
    gate: 'm3가 m1의 261.8%보다 큼',
    when: (m) => m.m3.exists && m.m1.exists && (m.m3.len / m.m1.len) * 100 > 261.8,
    emit: [':c3', ':s5'], exclusive: false,
    note: '런닝조정의 중심부이거나 복합조정 내부 지그재그의 마지막 파동',
  },
  {
    id: 'R3a-2', rule: 3, cond: 'a', page: 'p.133',
    gate: 'm3가 m1의 161.8~261.8%',
    when: (m) => m.m3.exists && m.m1.exists && between((m.m3.len / m.m1.len) * 100, 161.8, 261.8),
    emit: [':s5', ':c3', ':F3'], exclusive: false,
    note: '5파 연장 충격패턴의 중심부 · 강세조정의 중심부 · 복합조정의 첫 내부파동 중 하나',
  },
  {
    id: 'R3a-3', rule: 3, cond: 'a', page: 'p.132',
    gate: 'm3가 m1의 100~161.8%',
    when: (m) => m.m3.exists && m.m1.exists && between((m.m3.len / m.m1.len) * 100, 100, 161.8),
    emit: [':F3', ':5', ':s5'], exclusive: false,
    note: '복합조정 내 표준패턴의 첫 내부파동 · 5파 연장 충격의 3파 · 복합조정 지그재그의 c파 중 하나',
  },
  {
    id: 'R3b-1', rule: 3, cond: 'b', page: 'p.134',
    gate: 'm3가 m1의 261.8%보다 큼',
    when: (m) => m.m3.exists && m.m1.exists && (m.m3.len / m.m1.len) * 100 > 261.8,
    emit: [':c3', ':s5'], exclusive: false,
    note: '불규칙 미달형의 중심부이거나 복합조정 내 지그재그의 마지막 내부파동',
  },
  {
    id: 'R3b-2', rule: 3, cond: 'b', page: 'p.135',
    gate: 'm3가 m1의 161.8~261.8%',
    when: (m) => m.m3.exists && m.m1.exists && between((m.m3.len / m.m1.len) * 100, 161.8, 261.8),
    emit: [':c3', ':s5'], exclusive: false,
    note: '불규칙 미달형 중심부 · 복합조정 지그재그 c파 · 5파연장 터미널 중심부 중 하나',
  },
  {
    id: 'R3b-3', rule: 3, cond: 'b', page: 'p.134',
    gate: 'm3가 m1의 100~161.8%',
    when: (m) => m.m3.exists && m.m1.exists && between((m.m3.len / m.m1.len) * 100, 100, 161.8),
    emit: [':5', ':s5', ':c3'], exclusive: false,
    note: '복합조정 내 지그재그의 첫/마지막 내부파동이거나 5파연장 터미널 중심부',
  },
  {
    id: 'R3c-1', rule: 3, cond: 'c', page: 'p.136',
    gate: 'm3가 m1의 261.8%보다 큼',
    when: (m) => m.m3.exists && m.m1.exists && (m.m3.len / m.m1.len) * 100 > 261.8,
    emit: [':c3', ':sL3'], exclusive: false,
    note: '불규칙 미달형 플랫 또는 무제한 삼각형의 마지막 파동',
  },
  {
    id: 'R3c-2', rule: 3, cond: 'c', page: 'p.136',
    gate: 'm3가 m1의 161.8~261.8%',
    when: (m) => m.m3.exists && m.m1.exists && between((m.m3.len / m.m1.len) * 100, 161.8, 261.8),
    emit: [':F3', ':c3', ':sL3', ':s5'], exclusive: false,
    note: '불규칙 미달형 중심 · 수렴형 삼각형 끝에서 두 번째 · 복합조정 내부파동 중 하나',
  },
  {
    id: 'R3c-3', rule: 3, cond: 'c', page: 'p.137',
    gate: 'm3가 m1의 100~161.8%',
    when: (m) => m.m3.exists && m.m1.exists && between((m.m3.len / m.m1.len) * 100, 100, 161.8),
    emit: [':F3', ':c3', ':sL3', ':s5'], exclusive: false,
    note: '불규칙 미달형 플랫 중심 · 수렴형 삼각형 끝에서 두 번째 · 5파연장 터미널 중심 중 하나',
  },
  {
    id: 'R3d-1', rule: 3, cond: 'd', page: 'p.138',
    gate: 'm3가 m2의 261.8%보다 큼',
    when: (m) => m.m3.exists && m.m2.exists && (m.m3.len / m.m2.len) * 100 > 261.8,
    emit: [':5', ':c3', ':sL3'], exclusive: false,
    note: '지그재그 첫 내부파동 · c파 미달형 플랫 중앙 · 삼각형 끝에서 두 번째 중 하나',
  },
  {
    id: 'R3d-2', rule: 3, cond: 'd', page: 'p.138',
    gate: 'm3가 m2의 161.8~261.8%',
    when: (m) => m.m3.exists && m.m2.exists && between((m.m3.len / m.m2.len) * 100, 161.8, 261.8),
    emit: [':c3', ':sL3', ':5'], exclusive: false,
    note: 'c파 미달형 플랫 중앙 · 수렴형 삼각형 끝에서 두 번째 · 지그재그 첫 내부파동 중 하나',
  },
  {
    id: 'R3d-3', rule: 3, cond: 'd', page: 'p.139',
    gate: 'm3가 m2의 100~161.8%',
    when: (m) => m.m3.exists && m.m2.exists && between((m.m3.len / m.m2.len) * 100, 100, 161.8),
    emit: [':5', ':c3', ':F3'], exclusive: false,
    note: '지그재그 첫 내부파동일 가능성이 높지만 삼각형 내부파동일 수도 있음',
  },
  {
    id: 'R3e-1', rule: 3, cond: 'e', page: 'p.133',
    gate: 'm3가 m2의 261.8%보다 큼',
    when: (m) => m.m3.exists && m.m2.exists && (m.m3.len / m.m2.len) * 100 > 261.8,
    emit: [':5', ':c3', ':sL3'], exclusive: false,
    note: '지그재그 첫 내부파동 · c파 미달형 플랫(mO 중심에 조파동 숨음) · 삼각형 끝에서 두 번째 중 하나',
  },
  {
    id: 'R3e-2', rule: 3, cond: 'e', page: 'p.133',
    gate: 'm3가 m2의 161.8~261.8%',
    when: (m) => m.m3.exists && m.m2.exists && between((m.m3.len / m.m2.len) * 100, 161.8, 261.8),
    emit: [':5', ':c3'], exclusive: false,
    note: '지그재그 첫 내부파동 또는 c파 미달형 플랫(mO 중심에 조파동 숨음) 중앙',
  },
  {
    id: 'R3e-3', rule: 3, cond: 'e', page: 'p.134',
    gate: 'm3가 m2의 100~161.8%',
    when: (m) => m.m3.exists && m.m2.exists && between((m.m3.len / m.m2.len) * 100, 100, 161.8),
    emit: [':5', ':F3'], exclusive: false,
    note: '지그재그 첫 내부파동 또는 삼각형 첫 내부파동',
  },
  {
    id: 'R3f-1', rule: 3, cond: 'f', page: 'p.139',
    gate: 'm3가 m2의 261.8%보다 큼',
    when: (m) => m.m3.exists && m.m2.exists && (m.m3.len / m.m2.len) * 100 > 261.8,
    emit: [':5', ':c3'], exclusive: false,
    note: '지그재그 첫 내부파동 또는 c파 미달형 플랫(mO 중심에 조파동 생략) 중앙',
  },
  {
    id: 'R3f-2', rule: 3, cond: 'f', page: 'p.139',
    gate: 'm3가 m2의 161.8~261.8%',
    when: (m) => m.m3.exists && m.m2.exists && between((m.m3.len / m.m2.len) * 100, 161.8, 261.8),
    emit: [':5', ':c3'], exclusive: false,
    note: '지그재그 첫 내부파동 또는 c파 미달형 플랫 중앙',
  },
  {
    id: 'R3f-3', rule: 3, cond: 'f', page: 'p.140',
    gate: 'm3가 m2의 100~161.8%',
    when: (m) => m.m3.exists && m.m2.exists && between((m.m3.len / m.m2.len) * 100, 100, 161.8),
    emit: [':5', ':F3'], exclusive: false,
    note: '지그재그 첫 내부파동 또는 삼각형 첫 내부파동',
  },

  // ── 법칙 4 {:F3/:c3/:s5/(:sL3)/(x:c3)/[:L5]} — m3/m2 범주(i/ii/iii)가 한 단계 더 갈린다 ──
  {
    id: 'R4a-i-1', rule: 4, cond: 'a', cat: ['i'], page: 'p.139',
    gate: 'm3가 m3 자신의 형성 시간보다 긴 시간에 걸쳐 완전히 되돌려짐(m4)',
    when: (m) => m.m4.exists && m.m3.exists && !m.retracedWithinOwnTime('m4', 'm3') && m.fullyRetraces('m4', 'm3'),
    emit: [':F3', ':s5'], exclusive: false,
    note: '조파동 뒤 조정파의 첫 내부파동이거나 더 큰 패턴의 마지막 조정파',
  },
  {
    id: 'R4a-ii-1', rule: 4, cond: 'a', cat: ['ii'], page: 'p.141',
    gate: 'm(-1)이 m1의 261.8%보다 크거나, m4가 m3보다 김',
    when: (m) =>
      (m['m-1'].exists && m.m1.exists && (m['m-1'].len / m.m1.len) * 100 > 261.8) ||
      m.longer('m4', 'm3'),
    emit: [':F3'], exclusive: true,
    note: '원문: "m1이 엘리어트 패턴의 마지막 파동일 가능성은 거의 없다 — :F3만을 입력하라"',
  },
  {
    id: 'R4a-iii-1', rule: 4, cond: 'a', cat: ['iii'], page: 'p.141',
    gate: 'm(-1)이 m1의 261.8%보다 크거나, m3가 m4에 의해 완전히 되돌려짐',
    when: (m) =>
      (m['m-1'].exists && m.m1.exists && (m['m-1'].len / m.m1.len) * 100 > 261.8) ||
      m.fullyRetraces('m4', 'm3'),
    emit: [':F3'], exclusive: true,
    note: '원문: ":F3만 기록하라" (두 조건 모두 같은 결론)',
  },
  {
    id: 'R4b-i-1', rule: 4, cond: 'b', cat: ['i'], page: 'p.142',
    gate: 'm3가 자신의 형성 시간 이내로 완전히 되돌려짐(m4)',
    when: (m) => m.retracedWithinOwnTime('m4', 'm3') && m.fullyRetraces('m4', 'm3'),
    emit: [':F3', ':c3'], exclusive: true,
    note: '원문: "m1이 엘리어트 패턴의 마지막 파동일 가능성은 매우 낮다 — :F3/:c3만을 입력하라"',
  },
  {
    id: 'R4b-ii-1', rule: 4, cond: 'b', cat: ['ii'], page: 'p.143',
    gate: 'm(-1)이 m1의 261.8%보다 큼',
    when: (m) => m['m-1'].exists && m.m1.exists && (m['m-1'].len / m.m1.len) * 100 > 261.8,
    emit: [':F3', ':c3'], exclusive: true,
    note: '원문: ":F3/:c3만을 기록하라"',
  },
  {
    id: 'R4b-iii-1', rule: 4, cond: 'b', cat: ['iii'], page: 'p.145',
    gate: 'm(-1)이 m1의 261.8%보다 김',
    when: (m) => m['m-1'].exists && m.m1.exists && (m['m-1'].len / m.m1.len) * 100 > 261.8,
    emit: [':c3', ':F3'], exclusive: true,
    note: '원문: ":c3/(:F3)만 기입하라"',
  },
  {
    id: 'R4c-i-1', rule: 4, cond: 'c', cat: ['i'], page: 'p.146',
    gate: '조건 c · 범주 i 자체 — 추가 조건 없음',
    when: () => true,
    emit: [':F3', ':c3'], exclusive: false,
    note: '원문: "특별한 계량적 조건을 고려하지 않고 :F3/:c3를 입력하면 된다"',
  },
  {
    id: 'R4c-ii-1', rule: 4, cond: 'c', cat: ['ii'], page: 'p.146',
    gate: 'm2가 자신의 형성 시간 이내로 완전히 되돌려지고(m1), m3가 m1의 161.8%보다 김',
    when: (m) =>
      m.retracedWithinOwnTime('m2', 'm1') && m.fullyRetraces('m2', 'm1') &&
      m.m3.exists && m.m1.exists && (m.m3.len / m.m1.len) * 100 > 161.8,
    emit: [':c3', ':F3'], exclusive: false,
    note: '파동 c가 미달형인 플랫이나 수렴형 삼각형의 중심부',
  },
  {
    id: 'R4c-iii-1', rule: 4, cond: 'c', cat: ['iii'], page: 'p.147',
    gate: 'm2가 자신의 형성 시간 이내로 완전히 되돌려짐(m1)',
    when: (m) => m.retracedWithinOwnTime('m2', 'm1') && m.fullyRetraces('m2', 'm1'),
    emit: [':c3', ':F3'], exclusive: false,
    note: '파동 c가 미달형인 플랫 또는 무제한 수렴형 삼각형의 중심부',
  },
  {
    id: 'R4d-1', rule: 4, cond: 'd', cat: ['i', 'ii'], page: 'p.149',
    gate: 'm3가 자신의 형성 시간 이내로 완전히 되돌려짐(m4)',
    when: (m) => m.retracedWithinOwnTime('m4', 'm3') && m.fullyRetraces('m4', 'm3'),
    emit: [':F3'], exclusive: true,
    note: '원문: "m1에 대한 유일한 합리적 선택은 :F3"',
  },
  {
    id: 'R4d-2', rule: 4, cond: 'd', cat: ['iii'], page: 'p.150',
    gate: 'm3가 m1과 같거나 짧은 시간을 소비하거나, m1이 자신의 형성 시간 이내로 완전히 되돌려짐(m2)',
    when: (m) =>
      m.timeAtLeast('m1', 'm3') ||
      (m.retracedWithinOwnTime('m2', 'm1') && m.fullyRetraces('m2', 'm1')),
    emit: [':c3'], exclusive: false,
    note: 'mO 중간에 숨겨진 x파동이 있을 가능성이 매우 높음',
  },
  {
    id: 'R4e-1', rule: 4, cond: 'e', cat: ['i', 'ii'], page: 'p.151',
    gate: 'm3가 자신의 형성 시간 이내로 완전히 되돌려짐(m4)',
    when: (m) => m.retracedWithinOwnTime('m4', 'm3') && m.fullyRetraces('m4', 'm3'),
    emit: [':F3'], exclusive: true,
    note: '원문: ":F3만이 유일한 선택치"',
  },
  {
    id: 'R4e-2', rule: 4, cond: 'e', cat: ['iii'], page: 'p.152',
    gate: 'm3가 m4에 의해 61.8% 이상 되돌려짐',
    when: (m) => {
      const pct = m.retracePct('m4', 'm3');
      return pct != null && pct >= 61.8;
    },
    emit: [':F3'], exclusive: false,
    note: '연장된 플랫의 첫 번째 내부파동일 가능성 (mO~m5 돌파 여부는 단순화로 생략)',
  },

  // ── 법칙 5 {:F3/:c3/:5/:L5/(:L3)} ──────────────────────────────────────────
  // m2·m3가 3개 이상의 모노파동(폴리파동)으로 이루어진 분기는 이 프로젝트의 피벗
  // 단위(단일 모노파동)로는 판별할 수 없어 담지 않았다 — 항상 "3개 이하" 분기로 본다.
  {
    id: 'R5a-1', rule: 5, cond: 'a', page: 'p.153',
    gate: 'm1이 자신의 형성 시간 이내로 완전히 되돌려지고(m2), m2가 m(-2)보다 짧음',
    when: (m) =>
      m.retracedWithinOwnTime('m2', 'm1') && m.fullyRetraces('m2', 'm1') && m.longer('m-2', 'm2'),
    emit: [':L5'], exclusive: false,
    note: '플랫이나 지그재그가 m1으로 마감',
  },
  {
    id: 'R5b-1', rule: 5, cond: 'b', page: 'p.153',
    gate: 'm3가 m2보다 길고, m0가 m1의 100%에 가까움',
    when: (m) => m.longer('m3', 'm2') && almost(m.ratios.m0m1, 100),
    emit: [':c3'], exclusive: false,
    note: '',
  },
  {
    id: 'R5c-1', rule: 5, cond: 'c', page: 'p.156',
    gate: 'm3가 m1의 61.8~161.8%, m2가 m0의 61.8% 미만, m4가 m2·m0의 100% 이상',
    when: (m) => {
      if (!m.m3.exists || !m.m1.exists || !m.m2.exists || !m.m0.exists || !m.m4.exists) return false;
      const r31 = (m.m3.len / m.m1.len) * 100;
      const r20 = (m.m2.len / m.m0.len) * 100;
      const r42 = (m.m4.len / m.m2.len) * 100;
      const r40 = (m.m4.len / m.m0.len) * 100;
      return between(r31, 61.8, 161.8) && r20 < 61.8 && r42 >= 100 && r40 >= 100;
    },
    emit: [':F3'], exclusive: false,
    note: '불규칙 플랫이나 강세 삼각형의 첫 번째 내부파동',
  },
  {
    id: 'R5d-1', rule: 5, cond: 'd', page: 'p.157',
    gate: 'm3가 m2의 61.8% 미만',
    when: (m) => m.m3.exists && m.m2.exists && (m.m3.len / m.m2.len) * 100 < 61.8,
    emit: [':F3', ':c3'], exclusive: false,
    note: '',
  },

  // ── 법칙 6 {:5/:s5/:F3/:L5/(:L3)} ──────────────────────────────────────────
  {
    id: 'R6a-1', rule: 6, cond: 'a', page: 'p.159',
    gate: 'm2가 m3에 의해 61.8% 이하로 되돌려짐',
    when: (m) => {
      const pct = m.retracePct('m3', 'm2');
      return pct != null && pct <= 61.8;
    },
    emit: [':L5'], exclusive: false,
    note: '',
  },
  {
    id: 'R6b-1', rule: 6, cond: 'b', page: 'p.160',
    gate: 'm1이 m0와 같거나 긴 시간, 또는 m2와 같거나 긴 시간에 걸쳐 형성되거나, m0가 m1의 161.8%에 근접',
    when: (m) => m.timeAtLeast('m1', 'm0') || m.timeAtLeast('m1', 'm2') || almost(m.ratios.m0m1, 161.8),
    emit: [':F3'], exclusive: false,
    note: 'm1은 지그재그 또는 충격패턴의 한 부분',
  },
  {
    id: 'R6c-1', rule: 6, cond: 'c', page: 'p.161',
    gate: '조건 c 자체 — 추가 조건 없음',
    when: () => true,
    emit: [':F3'], exclusive: false,
    note: '원문: "어떤 특정한 환경에서도 :F3가 가장 좋은 선택이 될 가능성이 높다"',
  },
  {
    id: 'R6d-1', rule: 6, cond: 'd', page: 'p.162',
    gate: 'm1이 m0·m2 모두와 같거나 긴 시간에 걸쳐 형성됨(m1이 셋 중 가장 짧지 않음)',
    when: (m) => m.timeAtLeast('m1', 'm0') && m.timeAtLeast('m1', 'm2'),
    emit: [':F3'], exclusive: false,
    note: '보다 큰 조정의 첫 국면이거나 지그재그/충격패턴 안의 조정을 마감하는 파동',
  },

  // ── 법칙 7 {:5/:s5/:F3/:L5/(:L3)} ──────────────────────────────────────────
  {
    id: 'R7a-1', rule: 7, cond: 'a', page: 'p.164',
    gate: '(m2 단일 모노파동 전제 — 원문의 "3개 이하" 분기)',
    when: () => true,
    emit: [':L5'], exclusive: false,
    note: '원문: "주변의 정황이 어떻든 :L5일 가능성이 매우 높다" — 폴리파동 분기는 이 모델에서 다루지 않음',
  },
  {
    id: 'R7b-1', rule: 7, cond: 'b', page: 'p.165',
    gate: 'm2가 자신의 형성 시간 이내로 완전히 되돌려짐(m3)',
    when: (m) => m.retracedWithinOwnTime('m3', 'm2') && m.fullyRetraces('m3', 'm2'),
    emit: [':L5'], exclusive: false,
    note: '추세 방향 충격패턴이 m2로 마감',
  },
  {
    id: 'R7c-1', rule: 7, cond: 'c', page: 'p.166',
    gate: 'm1이 m0와 같거나 긴 시간, 또는 m2와 같거나 긴 시간에 걸쳐 형성됨',
    when: (m) => m.timeAtLeast('m1', 'm0') || m.timeAtLeast('m1', 'm2'),
    emit: [':F3'], exclusive: false,
    note: '원문: "다른 여건과 관련 없이 :F3일 가능성이 매우 높다"',
  },
  {
    id: 'R7d-1', rule: 7, cond: 'd', page: 'p.167',
    gate: 'm1이 m0·m2 모두와 같거나 긴 시간에 걸쳐 형성됨(m1이 셋 중 가장 짧지 않음)',
    when: (m) => m.timeAtLeast('m1', 'm0') && m.timeAtLeast('m1', 'm2'),
    emit: [':F3'], exclusive: false,
    note: 'm1은 지그재그나 충격패턴의 한 부분',
  },
];

// 표가 담고 있는 (법칙, 조건) 쌍
const COVERED = new Set(ENTRIES.map((e) => `${e.rule}${e.cond}`));

// 되돌림 법칙 전체의 (법칙, 조건) 쌍 — neowave.js CONDITIONS 와 같은 구성
// 법칙 5 는 원문이 4구간(a~d)인데 neowave.js CONDITIONS[5] 가 3구간으로 잘못
// 추정돼 있었다 — 이 표를 채우며 원문(p.151~158)을 다시 확인해 함께 고쳤다.
const ALL_CONDS = [
  ['1', 'abcd'], ['2', 'abcde'], ['3', 'abcdef'],
  ['4', 'abcde'], ['5', 'abcd'], ['6', 'abcd'], ['7', 'abcd'],
];

function coverageReport() {
  const covered = [];
  const missing = [];
  for (const [rule, letters] of ALL_CONDS) {
    for (const c of letters) {
      (COVERED.has(`${rule}${c}`) ? covered : missing).push(`R${rule}${c}`);
    }
  }
  return {
    covered,
    missing,
    total: covered.length + missing.length,
    note: `논리적 사전 구성법칙 ${covered.length}/${covered.length + missing.length} 조건 수록 ` +
      `(미수록: ${missing.join(' ')}) — 미수록 조건에서는 등급별 후보 목록만 낸다`,
  };
}

// ---------------------------------------------------------------------------
// 판정 — 한 reading(법칙+조건)에 대해 표를 돌린다
//
// 반환:
//   applied   : 이 조건이 표에 수록돼 있는가
//   matched   : 관문을 통과한 항목들
//   resolved  : 확정된 구조기호 목록 (없으면 null)
//   exclusive : 원문이 "이것뿐"이라고 못박았는가
// ---------------------------------------------------------------------------
function resolveStructure(reading, ctx) {
  const cond = reading.condition && reading.condition.letter;
  if (!cond) return { applied: false, reason: '조건 문자 미확정 (m0 없음)' };
  const key = `${reading.rule}${cond}`;
  if (!COVERED.has(key)) {
    return { applied: false, reason: `R${key} 는 아직 표에 수록되지 않았다` };
  }

  // 법칙 4 는 조건 문자 위에 m3/m2 범주(i/ii/iii)가 한 단계 더 갈린다 — 항목에
  // cat 이 있으면 지금 판정의 범주와 겹칠 때만 후보로 본다.
  const cat = reading.category;
  const pool = ENTRIES.filter(
    (e) => e.rule === reading.rule && e.cond === cond && (!e.cat || (cat && e.cat.includes(cat)))
  );
  const matched = [];
  for (const e of pool) {
    let ok = false;
    try {
      ok = !!e.when(ctx);
    } catch (_) {
      ok = false;
    }
    if (ok) matched.push(e);
  }
  if (!matched.length) {
    return { applied: true, matched: [], resolved: null, reason: `R${key} 의 어떤 문단도 관문을 통과하지 못했다` };
  }

  const exclusive = matched.find((e) => e.exclusive) || null;
  const emitted = [];
  for (const e of (exclusive ? [exclusive] : matched)) {
    for (const l of e.emit) if (!emitted.includes(l)) emitted.push(l);
  }
  return {
    applied: true,
    matched,
    resolved: emitted,
    exclusive: !!exclusive,
    reason: null,
  };
}

module.exports = {
  RATIO_TOL_PP,
  ALMOST_TOL,
  nearRatio,
  almost,
  between,
  buildContext,
  ENTRIES,
  coverageReport,
  resolveStructure,
};
