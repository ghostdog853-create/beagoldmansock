'use strict';

// WAVE FLOOR — 닐리 NEoWave 엔진 (되돌림 법칙 · 구조기호)
//
// 명세: docs/파동분석-통합본.md 1장
//
// 고전 엘리어트(elliott.js)는 "이 카운트가 규칙을 어겼는가"만 물을 수 있는 검증기다.
// 닐리는 다르다 — 각 모노파동의 내부 구조를 이웃과의 되돌림 비율만으로 판정한다.
// 즉 후보를 만들어내는 생성기다. 그래서 이쪽이 먼저 돌고, 고전 규칙이 뒤에서 거른다.
//
// 흐름:
//   피벗 → 모노파동 → (m0,m1,m2,m3 이웃 확정) → m2/m1로 법칙 → m0/m1로 조건
//   → 구조기호 + 신뢰도 → 방향성/비방향성 국면 판정 → 패턴 분리

const SCALE = require('./scale');
const PRE = require('./preconstruction');

// 되돌림 법칙 경계 — m2/m1 (백분율)
const RULE_BOUNDS = [
  { rule: 1, min: 0, max: 38.2, desc: 'm2 < 38.2% — 얕은 되돌림, m1이 충격파일 가능성' },
  { rule: 2, min: 38.2, max: 61.8, desc: 'm2 38.2~61.8% — 정상 되돌림' },
  { rule: 3, min: 61.8, max: 61.8, desc: 'm2 = 61.8% — 충격/조정 경계, 판정 최난' },
  { rule: 4, min: 61.8, max: 100, desc: 'm2 61.8~100% — 깊은 되돌림' },
  { rule: 5, min: 100, max: 161.8, desc: 'm2 100~161.8% — 완전 되돌림, m1이 조정파일 가능성' },
  { rule: 6, min: 161.8, max: 261.8, desc: 'm2 161.8~261.8% — 초과 되돌림' },
  { rule: 7, min: 261.8, max: Infinity, desc: 'm2 > 261.8% — 극단 초과' },
];

// 법칙별 조건 경계 — m0/m1 (백분율). 통합본 1.3 표 그대로.
// estimated:true 는 원문 스캔 손상으로 복원하지 못해 5번 패턴을 준용한 구간이다.
const CONDITIONS = {
  1: { bounds: [['a', 0, 61.8], ['b', 61.8, 100], ['c', 100, 161.8], ['d', 161.8, Infinity]] },
  2: { bounds: [['a', 0, 38.2], ['b', 38.2, 61.8], ['c', 61.8, 100], ['d', 100, 161.8], ['e', 161.8, Infinity]] },
  3: { bounds: [['a', 0, 38.2], ['b', 38.2, 61.8], ['c', 61.8, 100], ['d', 100, 161.8], ['e', 161.8, 261.8], ['f', 261.8, Infinity]] },
  4: { bounds: [['a', 0, 38.2], ['b', 38.2, 100], ['c', 100, 161.8], ['d', 161.8, 261.8], ['e', 261.8, Infinity]] },
  // 원문 p.151~158(preconstruction.js 표 작성 중 재확인) 에서 확인. 앞서 3구간으로
  // 추정했으나 실제는 4구간이다 — 6·7과 같은 구성.
  5: { bounds: [['a', 0, 100], ['b', 100, 161.8], ['c', 161.8, 261.8], ['d', 261.8, Infinity]] },
  // 원문 p.118 · p.159~164 에서 확인. 앞서 3구간으로 추정했으나 실제는 4구간이다.
  6: { bounds: [['a', 0, 100], ['b', 100, 161.8], ['c', 161.8, 261.8], ['d', 261.8, Infinity]] },
  7: { bounds: [['a', 0, 100], ['b', 100, 161.8], ['c', 161.8, 261.8], ['d', 261.8, Infinity]] },
};

// 법칙 4 전용 범주 — m3/m2
const CATEGORY_BOUNDS = [
  ['i', 100, 161.8],
  ['ii', 161.8, 261.8],
  ['iii', 261.8, Infinity],
];

// 법칙별 가능한 구조기호.
// 표기가 곧 신뢰도다 — 맨몸 > (소괄호) > [대괄호].
// partial:true 는 원문에서 일부만 복원된 집합.
const LABEL_SETS = {
  1: { labels: [':5', '(:c3)', '(x:c3)', '[:sL3]', '[:s5]'] },
  2: { labels: [':5', '(:sL3)', '[:c3]', '[:s5]'] },
  3: { labels: [':F3', ':c3', ':s5', ':5', '(:sL3)', '[:L5]'] },
  4: { labels: [':F3', ':c3', ':s5', '(:sL3)', '(x:c3)', '[:L5]'] },
  5: { labels: [':F3', ':c3', ':5', ':L5', '(:L3)'] },
  // p.159~164 확인: :5/:s5 외에 조건에 따라 :F3, :L5, (:L3) 도 나온다
  6: { labels: [':5', ':s5', ':F3', ':L5', '(:L3)'] },
  7: { labels: [':5', ':s5', ':F3', ':L5', '(:L3)'] },
};

// 괄호 표기 → 신뢰도 가중치 (통합본 1.4)
function labelWeight(label) {
  if (label.startsWith('[')) return 0.3; // 매우 낮음
  if (label.startsWith('(')) return 0.6; // 낮음
  return 1.0;                            // 유력
}

function stripLabel(label) {
  return label.replace(/^[[(]|[\])]$/g, '');
}

// 구조기호 뜻풀이 — 프롬프트에 그대로 나간다
const LABEL_MEANING = {
  ':5': '5파 구조 (충격적)',
  ':3': '3파 구조 (조정적)',
  ':F3': 'First 3 — 패턴을 여는 조정파',
  ':c3': 'center 3 — 패턴 중간의 조정파',
  ':L5': 'Last 5 — 패턴을 닫는 충격파',
  ':L3': 'Last 3 — 패턴을 닫는 조정파',
  ':s5': 'second 5 — 두 번째 위치의 충격파',
  ':sL3': 'second-Last 3',
  'x:c3': 'X파동 — 복합 조정의 연결부',
};

// 판정 경계에 붙었는지 (중립성의 법칙, 통합본 1.2 ②)
const NEUTRAL_TOL = 3.0; // ±3%p

function isNeutral(value, boundary) {
  return Math.abs(value - boundary) <= NEUTRAL_TOL;
}

// 되돌림 비율 → 법칙 번호. 경계에 붙으면 양쪽을 모두 후보로 돌려준다.
function pickRules(ratioPct) {
  const out = [];
  for (const b of RULE_BOUNDS) {
    if (b.rule === 3) {
      // 법칙 3은 "정확히 61.8%" — 중립 허용범위 안일 때만
      if (isNeutral(ratioPct, 61.8)) out.push({ ...b, neutral: true });
      continue;
    }
    if (ratioPct >= b.min && ratioPct < b.max) out.push({ ...b, neutral: false });
    else if (isNeutral(ratioPct, b.min) || isNeutral(ratioPct, b.max)) {
      out.push({ ...b, neutral: true }); // 경계 근접 — 후보로 남긴다
    }
  }
  // 중복 제거
  const seen = new Set();
  return out.filter((r) => (seen.has(r.rule) ? false : (seen.add(r.rule), true)));
}

function pickCondition(rule, ratioPct) {
  const spec = CONDITIONS[rule];
  if (!spec) return null;
  for (const [letter, min, max] of spec.bounds) {
    if (ratioPct >= min && ratioPct < max) {
      return { letter, min, max, estimated: !!spec.estimated, neutral: isNeutral(ratioPct, min) || isNeutral(ratioPct, max) };
    }
  }
  const last = spec.bounds[spec.bounds.length - 1];
  return { letter: last[0], min: last[1], max: last[2], estimated: !!spec.estimated, neutral: false };
}

function pickCategory(ratioPct) {
  for (const [letter, min, max] of CATEGORY_BOUNDS) {
    if (ratioPct >= min && ratioPct < max) return letter;
  }
  return ratioPct < 100 ? null : 'iii';
}

// ---------------------------------------------------------------------------
// 관측의 법칙 — m0/m2의 끝점 확정 (통합본 1.2 ③)
// "m1의 고점 또는 저점을 이탈해야 그 모노파동이 끝난 것"이므로,
// 한 조각으로 못 넘으면 여러 조각을 합쳐 하나로 센다.
// ---------------------------------------------------------------------------
function resolveNeighbors(pivots, i) {
  // m1 = pivots[i] → pivots[i+1]
  const p0 = pivots[i];
  const p1 = pivots[i + 1];
  if (!p0 || !p1) return null;
  const up = p1.price > p0.price;

  // m2: p1 이후, m1의 시작점(p0.price)을 이탈할 때까지 누적
  let m2End = null;
  for (let k = i + 2; k < pivots.length; k++) {
    m2End = pivots[k];
    const broke = up ? pivots[k].price <= p0.price : pivots[k].price >= p0.price;
    // 방향이 되돌림 쪽인 극점만 본다
    if (pivots[k].kind === p0.kind) {
      if (broke || k >= i + 2) break;
    }
  }
  // m0: p0 이전, 시간 역순으로 m1의 끝점(p1.price)을 이탈할 때까지
  let m0Start = null;
  for (let k = i - 1; k >= 0; k--) {
    m0Start = pivots[k];
    if (pivots[k].kind === p1.kind) break;
  }
  // m3: m2 이후 한 조각
  let m3End = null;
  if (m2End) {
    const idx = pivots.indexOf(m2End);
    if (idx >= 0 && idx + 1 < pivots.length) m3End = pivots[idx + 1];
  }

  return { p0, p1, m0Start, m2End, m3End, up };
}

// ---------------------------------------------------------------------------
// 모노파동 하나에 대한 닐리 판정
// ---------------------------------------------------------------------------
function analyzeMonowave(pivots, i, scale) {
  const n = resolveNeighbors(pivots, i);
  if (!n || !n.m2End) return null;

  const m1 = Math.abs(n.p1.price - n.p0.price);
  if (!(m1 > 0)) return null;
  const m2 = Math.abs(n.m2End.price - n.p1.price);
  const m0 = n.m0Start ? Math.abs(n.p0.price - n.m0Start.price) : null;
  const m3 = n.m3End ? Math.abs(n.m3End.price - n.m2End.price) : null;

  const r21 = (m2 / m1) * 100;
  const r01 = m0 != null ? (m0 / m1) * 100 : null;
  const r32 = m3 != null && m2 > 0 ? (m3 / m2) * 100 : null;

  // ── 비례의 법칙 (닐리 1장) · 척도 교차 검증 ───────────────────────────
  // 같은 세 점이라도 산술로 재느냐 로그로 재느냐에 따라 법칙 번호가 갈릴 수 있다.
  // 등락폭이 큰 구간에서는 로그 쪽이 실제 되돌림의 체감에 가깝다.
  //
  // 그래서 척도 판정(scale.useLog)이 **주 측정치를 정하고**, 다른 척도에서만
  // 나오는 법칙은 보조 후보로 붙인다. 갈리지 않으면 아무 일도 일어나지 않는다.
  let logCheck = null;
  let primaryPct = r21;
  let rules;

  const dual = scale ? SCALE.dualRatio(n.p0.price, n.p1.price, n.m2End.price) : null;
  if (dual && dual.log != null) {
    const useLog = !!scale.useLog;
    primaryPct = useLog ? dual.log : dual.lin;
    const otherPct = useLog ? dual.lin : dual.log;

    rules = pickRules(primaryPct);
    if (!rules.length) return null;

    const primarySet = new Set(rules.map((r) => r.rule));
    const extra = pickRules(otherPct).filter((r) => !primarySet.has(r.rule));
    logCheck = {
      lin: dual.lin,
      log: dual.log,
      deltaPP: dual.deltaPP,
      diverges: dual.diverges,
      useLog,
      primaryScale: useLog ? '로그' : '산술',
      otherScale: useLog ? '산술' : '로그',
      split: extra.length > 0,
      addedRules: extra.map((r) => r.rule),
    };
    // 다른 척도에서만 나오는 법칙 — 후보로는 남기되 경계 취급한다
    if (extra.length) {
      rules = rules.concat(extra.map((r) => ({ ...r, fromOtherScale: true, neutral: true })));
    }
  } else {
    rules = pickRules(r21);
    if (!rules.length) return null;
  }

  // 조건(m0/m1)도 같은 척도로 재야 앞뒤가 맞는다
  let condPct = r01;
  if (scale && scale.useLog && n.m0Start) {
    const d0 = SCALE.dualRatio(n.m0Start.price, n.p0.price, n.p1.price);
    // dualRatio 는 (b→c)/(a→b) 이므로 m1/m0 이 나온다. 역수를 취해 m0/m1 로 되돌린다.
    if (d0.log != null && d0.log > 0) condPct = (100 / d0.log) * 100;
  }

  const readings = rules.map((r) => {
    const cond = condPct != null ? pickCondition(r.rule, condPct) : null;
    const cat = r.rule === 4 && r32 != null ? pickCategory(r32) : null;
    const set = LABEL_SETS[r.rule] || { labels: [] };
    const labels = set.labels.map((l) => ({
      label: l,
      clean: stripLabel(l),
      weight: labelWeight(l),
      meaning: LABEL_MEANING[stripLabel(l)] || '',
    }));
    const code =
      `R${r.rule}` +
      (cond ? cond.letter : '') +
      (cat ? `-${cat}` : '');
    return {
      rule: r.rule,
      ruleDesc: r.desc,
      neutral: r.neutral,
      condition: cond,
      category: cat,
      code,
      labels,
      partial: !!set.partial,
      estimated: !!(cond && cond.estimated),
      fromOtherScale: !!r.fromOtherScale,
    };
  });

  // ── 닐리 3장 · 논리적 사전 구성법칙 ─────────────────────────────────
  // 여기까지는 "법칙 N, 조건 x" 까지만 왔고 구조기호는 여전히 목록이다.
  // 이 절이 그 목록에서 어느 것인지를 가른다. 표에 없는 조건이면 조용히 넘어간다.
  const preCtx = PRE.buildContext(pivots, i, scale);
  for (const rd of readings) {
    const res = PRE.resolveStructure(rd, preCtx);
    rd.pre = res;
    if (res.applied && res.resolved && res.resolved.length) {
      // 확정된 기호에 표시를 달고 앞으로 끌어올린다
      for (const l of rd.labels) l.confirmed = res.resolved.includes(l.clean);
      if (res.exclusive) {
        // 원문이 "이것뿐"이라고 못박은 경우에만 목록을 줄인다
        const kept = rd.labels.filter((l) => l.confirmed);
        if (kept.length) rd.labels = kept;
      } else {
        rd.labels.sort((a, b) => (b.confirmed ? 1 : 0) - (a.confirmed ? 1 : 0) || b.weight - a.weight);
      }
    }
  }

  return {
    index: i,
    from: n.p0,
    to: n.p1,
    up: n.up,
    lengths: { m0, m1, m2, m3 },
    ratios: { m2m1: r21, m0m1: r01, m3m2: r32, primary: primaryPct, condPct },
    logCheck,
    readings,
    // 가장 유력한 구조기호 (첫 법칙의 최고 가중치 라벨)
    primary: readings[0] && readings[0].labels[0] ? readings[0].labels[0] : null,
    ambiguous: readings.length > 1,
  };
}

// ---------------------------------------------------------------------------
// 방향성 / 비방향성 국면 판정 (통합본 1.5)
// 비방향성 국면에서 방향 베팅을 설계하는 것이 손실의 주된 원인이므로,
// 이 판정은 시간축 정렬(PRISM)의 1급 재료다.
// ---------------------------------------------------------------------------
function classifyPhase(pivots, lookback = 7) {
  const pv = pivots.slice(-Math.max(4, lookback));
  if (pv.length < 4) {
    return { phase: '판정 불가', detail: '모노파동 부족', retraces: [] };
  }
  const retraces = [];
  for (let i = 1; i + 1 < pv.length; i++) {
    const prev = Math.abs(pv[i].price - pv[i - 1].price);
    const next = Math.abs(pv[i + 1].price - pv[i].price);
    if (prev > 0) retraces.push((next / prev) * 100);
  }
  if (!retraces.length) {
    return { phase: '판정 불가', detail: '되돌림 계산 불가', retraces };
  }
  const over = retraces.filter((r) => r >= 61.8).length;
  const ratio = over / retraces.length;

  // 비방향성: 예외 1구간을 제외한 전 구간이 61.8% 이상 되돌려진다
  if (retraces.length - over <= 1 && ratio >= 0.6) {
    return {
      phase: '비방향성',
      detail:
        `최근 되돌림 ${retraces.length}건 중 ${over}건이 61.8% 이상 — 가치 정체 국면. ` +
        '방향 베팅에 가장 불리하며, 구간 범위의 161.8%를 벗어날 때 종료된다',
      retraces,
      overCount: over,
    };
  }
  if (ratio <= 0.4) {
    return {
      phase: '방향성',
      detail:
        `최근 되돌림 ${retraces.length}건 중 ${over}건만 61.8%를 넘음 — 추세가 살아 있는 국면. ` +
        '중심 추세 방향 모노파동이 100% 되돌려질 때 종료된다',
      retraces,
      overCount: over,
    };
  }
  return {
    phase: '혼재',
    detail: `되돌림 ${retraces.length}건 중 ${over}건이 61.8% 이상 — 방향성/비방향성 경계`,
    retraces,
    overCount: over,
  };
}

// ---------------------------------------------------------------------------
// 국면이 끝나는 가격 (통합본 1.5의 종료 조건을 구체적 레벨로 환산)
//
// 이 두 레벨이 닐리 체계에서 가장 실행에 가까운 숫자다.
//   방향성  → 중심 추세 방향 모노파동이 100% 되돌려지는 가격
//   비방향성 → 구간 범위의 161.8%를 벗어나는 가격 (양쪽)
// 근거 중첩(confluence.js)에 최고 가중치로 들어간다.
// ---------------------------------------------------------------------------
function phaseLevels(pivots, phase, lookback = 7) {
  const pv = pivots.slice(-Math.max(4, lookback));
  if (pv.length < 3) return [];
  const out = [];

  if (phase && phase.phase === '방향성') {
    // 마지막 확정 모노파동이 100% 되돌려지는 가격 = 그 시작점
    const last = pv[pv.length - 1];
    const prev = pv[pv.length - 2];
    if (prev) {
      out.push({
        price: prev.price,
        label: '방향성 국면 종료 — 직전 모노파동 100% 되돌림',
        kind: 'phase_end',
      });
    }
  } else if (phase && phase.phase === '비방향성') {
    // 구간 범위의 161.8% 이탈 지점 (양쪽)
    const prices = pv.map((p) => p.price);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const range = hi - lo;
    if (range > 0) {
      out.push({
        price: hi + range * 0.618,
        label: '비방향성 국면 종료(상방) — 구간의 161.8% 돌파',
        kind: 'phase_end',
      });
      out.push({
        price: lo - range * 0.618,
        label: '비방향성 국면 종료(하방) — 구간의 161.8% 이탈',
        kind: 'phase_end',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 패턴 분리 (통합본 1.6) — :L5 / :L3 가 한 엘리어트 패턴의 끝이다
// ---------------------------------------------------------------------------
function separatePatterns(monowaves) {
  const marks = [];
  monowaves.forEach((mw) => {
    if (!mw) return;
    const hasL = mw.readings.some((r) =>
      r.labels.some((l) => l.weight >= 0.6 && /^:L[35]$/.test(l.clean))
    );
    if (hasL) marks.push({ index: mw.index, at: mw.to, price: mw.to.price, t: mw.to.t });
  });
  return marks;
}

// ---------------------------------------------------------------------------
function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

// 전체 분석 — 최근 모노파동들을 판정한다
function analyzeNeoWave(pivots, opts = {}) {
  const maxWaves = opts.maxWaves || 6;
  if (!Array.isArray(pivots) || pivots.length < 4) {
    return { monowaves: [], phase: classifyPhase(pivots || []), patternMarks: [], note: '피벗 부족' };
  }
  const monowaves = [];
  // 최근 구간부터 뒤로 maxWaves개
  const scale = opts.scale || null;
  const start = Math.max(0, pivots.length - 1 - maxWaves);
  for (let i = start; i + 1 < pivots.length; i++) {
    const mw = analyzeMonowave(pivots, i, scale);
    if (mw) monowaves.push(mw);
  }
  const phase = classifyPhase(pivots);
  // ── 닐리 3장 · 포지션 지표 규칙으로 후보를 걸러낸다 ──────────────────
  //   :c3  는 패턴의 시작점이나 끝점이 될 수 없다
  //   x:c3 도 연속 파동의 시작·끝점에서 쓸 수 없다
  // 첫 모노파동과 마지막 모노파동에서 이 둘을 빼면 후보가 실제로 좁혀진다.
  if (monowaves.length >= 2) {
    const edges = [monowaves[0], monowaves[monowaves.length - 1]];
    for (const mw of edges) {
      for (const rd of mw.readings) {
        const before = rd.labels.length;
        rd.labels = rd.labels.filter((l) => l.clean !== ':c3' && l.clean !== 'x:c3');
        if (rd.labels.length !== before) {
          rd.edgeFiltered = true;
          rd.edgeNote = '패턴 가장자리라 :c3 / x:c3 를 제외했다 (닐리 3장 포지션 규칙)';
        }
        // 전부 걸러졌으면 원래 목록을 되살린다 — 후보를 0으로 만들 수는 없다
        if (!rd.labels.length) {
          rd.labels = (LABEL_SETS[rd.rule] || { labels: [] }).labels.map((l) => ({
            label: l,
            clean: stripLabel(l),
            weight: labelWeight(l),
            meaning: LABEL_MEANING[stripLabel(l)] || '',
          }));
          rd.edgeFiltered = false;
          rd.edgeNote = null;
        }
      }
    }
  }

  return {
    monowaves,
    preCoverage: PRE.coverageReport(),
    phase,
    phaseLevels: phaseLevels(pivots, phase),
    patternMarks: separatePatterns(monowaves),
    note: monowaves.length ? '' : '되돌림 법칙을 적용할 이웃 관계가 성립하지 않음',
  };
}

// LLM 프롬프트용 문장화
function describeNeoWave(result) {
  if (!result) return ['NEoWave 분석 불가'];
  const out = [];

  out.push(`국면 판정: ${result.phase.phase} — ${result.phase.detail}`);
  if (result.preCoverage) out.push(result.preCoverage.note);
  out.push('');

  if (!result.monowaves.length) {
    out.push(result.note || '모노파동 판정 결과 없음');
    return out;
  }

  out.push('모노파동별 구조기호 (닐리 되돌림 법칙):');
  for (const mw of result.monowaves.slice(-5)) {
    const dir = mw.up ? '상승' : '하락';
    const when = new Date(mw.to.t).toISOString().slice(0, 16).replace('T', ' ');
    out.push(
      `  ${when} ${dir} ${money(mw.from.price)} → ${money(mw.to.price)}`
    );
    const r = mw.ratios;
    out.push(
      // 법칙 번호를 실제로 정한 값(주 척도)을 앞에 낸다.
      // 로그 척도를 쓰는 구간에서 산술값을 보여주면 "34.4% 인데 왜 법칙 2인가"가 된다.
      `     m2/m1 ${(r.primary != null ? r.primary : r.m2m1).toFixed(1)}%` +
        (mw.logCheck && mw.logCheck.useLog ? ` (로그 기준 · 산술 ${r.m2m1.toFixed(1)}%)` : '') +
        (r.condPct != null ? ` · m0/m1 ${r.condPct.toFixed(1)}%` : '') +
        (r.m3m2 != null ? ` · m3/m2 ${r.m3m2.toFixed(1)}%` : '')
    );
    // 비례의 법칙 — 척도가 답을 바꾸는 자리만 말한다. 안 바꾸면 침묵한다.
    if (mw.logCheck && mw.logCheck.split) {
      out.push(
        `     ⚠ 비례의 법칙: m2/m1 이 산술 ${mw.logCheck.lin.toFixed(1)}% / ` +
        `로그 ${mw.logCheck.log.toFixed(1)}% 로 갈린다 — ` +
        `로그 기준에선 법칙 ${mw.logCheck.addedRules.join('·')}도 성립한다`
      );
    } else if (mw.logCheck && mw.logCheck.diverges) {
      out.push(
        `     비례의 법칙: 로그로 재면 ${mw.logCheck.log.toFixed(1)}% ` +
        `(${mw.logCheck.deltaPP.toFixed(1)}%p 차) — 법칙 번호는 그대로다`
      );
    }
    for (const rd of mw.readings) {
      const flags = [
        rd.neutral ? '경계(중립성)' : null,
        rd.estimated ? '조건 추정' : null,
        rd.partial ? '기호집합 일부' : null,
        rd.edgeFiltered ? '가장자리 필터' : null,
        rd.fromOtherScale ? '다른 척도에서만' : null,
      ].filter(Boolean);
      out.push(
        `     ${rd.code}: ${rd.ruleDesc}` + (flags.length ? ` [${flags.join(', ')}]` : '')
      );
      // 등급별로 묶어서 보여준다. 닐리에서 맨몸 기호들 사이의 우열은
      // 조건별 매핑(논리적 사전 구성법칙)이 가르는데 그 표를 원문에서
      // 완전히 복원하지 못했다. 하나를 임의로 "유력"이라 찍으면 없는
      // 근거를 만들어내는 것이므로, 등급까지만 정직하게 낸다.
      const tiers = [
        ['유력', rd.labels.filter((l) => l.weight === 1.0)],
        ['가능성 낮음', rd.labels.filter((l) => l.weight === 0.6)],
        ['매우 낮음', rd.labels.filter((l) => l.weight === 0.3)],
      ];
      for (const [tierName, group] of tiers) {
        if (!group.length) continue;
        out.push(`        ${tierName}: ${group.map((l) => l.clean).join(' / ')}`);
      }
      // 논리적 사전 구성법칙이 답을 준 경우 — 어느 문단이 왜 통과했는지까지 낸다
      if (rd.pre && rd.pre.applied && rd.pre.resolved && rd.pre.resolved.length) {
        const tag = rd.pre.exclusive ? '확정(유일)' : '확정';
        out.push(`        ▶ 사전 구성법칙 ${tag}: ${rd.pre.resolved.join(' / ')}`);
        for (const e of rd.pre.matched) {
          out.push(`           [${e.id} ${e.page}] ${e.gate} → ${e.emit.join('/')}`);
          if (e.note) out.push(`             ${e.note}`);
        }
      } else {
        const strong = rd.labels.filter((l) => l.weight === 1.0);
        if (strong.length === 1 && strong[0].meaning) {
          out.push(`        → ${strong[0].clean} = ${strong[0].meaning}`);
        } else if (strong.length > 1) {
          const why = rd.pre && rd.pre.reason ? rd.pre.reason : '조건 미확정';
          out.push(
            `        → 유력 후보가 ${strong.length}개다. 주변 패턴과의 연결로 판단해야 한다 ` +
            `(${why})`
          );
        }
      }
    }
    if (mw.ambiguous) {
      out.push('     ※ 경계값이라 복수 법칙이 살아 있음 — 하나로 확정하지 마라');
    }
  }

  if (result.phaseLevels && result.phaseLevels.length) {
    out.push('');
    out.push('국면 종료 레벨 (닐리 — 이 가격을 넘으면 현재 국면이 끝난다):');
    for (const l of result.phaseLevels) {
      out.push(`  ${money(l.price)} — ${l.label}`);
    }
  }

  if (result.patternMarks.length) {
    out.push('');
    out.push('패턴 종료 후보 (:L5 / :L3 검출 지점):');
    for (const m of result.patternMarks.slice(-3)) {
      const when = new Date(m.t).toISOString().slice(0, 16).replace('T', ' ');
      out.push(`  ${when} ${money(m.price)} — 이 지점이 한 엘리어트 패턴의 끝일 수 있다`);
    }
  }

  out.push('');
  out.push(
    '※ 구조기호 신뢰도는 닐리의 괄호 표기를 그대로 따랐다 — 맨몸이 유력, (소괄호)는 낮음, ' +
      '[대괄호]는 매우 낮음. 법칙 1~7의 조건 경계와 기호집합은 원서 3장(p.107~166)에서 ' +
      '전부 확인했다. 다만 조건별로 어느 기호 하나로 확정할지는 m0~m5의 시간 비교까지 ' +
      '따지는 별도 결정트리라 여기서는 후보 집합까지만 낸다.'
  );
  return out;
}

module.exports = {
  analyzeNeoWave,
  describeNeoWave,
  phaseLevels,
  analyzeMonowave,
  classifyPhase,
  separatePatterns,
  RULE_BOUNDS,
  CONDITIONS,
  LABEL_SETS,
  LABEL_MEANING,
};
