'use strict';

// WAVE FLOOR — 작도(作圖) 엔진
//
// "이 카운트가 어떻게 나왔는가"를 사람이 검산할 수 있게 만드는 모듈이다.
//
// 지금까지의 모듈은 결론만 냈다 — "상승 충격파 3파 완성, 정합도 48점".
// 그걸 믿으려면 어느 점에 피보나치를 걸었고 실측이 어디에 떨어졌는지를
// 봐야 한다. 이 모듈은 그 작도 과정을 좌표로 뽑아 그대로 화면에 넘긴다.
//
// 산출물:
//   anchors  — 어느 점을 찍었는지 (0,1,2,3,4,5 / 0,A,B,C)
//   tools    — 어떤 피보나치 도구를 어디에 걸었는지 (되돌림/확장)
//   levels   — 그 도구가 만든 가격 레벨들
//   actual   — 실측값이 어느 레벨에 떨어졌는지
//   scenarios— 방향이 갈리는 후보들 (이 카운트 말고 다른 해석)

// 되돌림 그리드 (파동 되돌림용)
const RETRACE_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0];
// 확장 그리드 (목표 투영용)
const EXTEND_LEVELS = [0.618, 1.0, 1.382, 1.618, 2.618, 4.236];

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

function pct(n, dp = 1) {
  return `${(n * 100).toFixed(dp)}%`;
}

// 실측 비율이 그리드의 어느 눈금에 가장 가까운가
function snapTo(actual, levels, tol = 0.05) {
  let best = null;
  for (const l of levels) {
    const d = Math.abs(actual - l);
    if (!best || d < best.d) best = { level: l, d };
  }
  return { ...best, hit: best.d <= tol };
}

// ---------------------------------------------------------------------------
// 피보나치 되돌림 도구
//   from → to 두 점에 걸고, 되돌림 눈금의 가격을 계산한다.
//   0% = to(끝점), 100% = from(시작점) — 트레이딩뷰와 같은 방향
// ---------------------------------------------------------------------------
function retracementTool(name, from, to, actualPrice, note, gridOverride) {
  const span = to.price - from.price;
  if (!span) return null;
  const GRID = gridOverride || RETRACE_LEVELS;
  const levels = GRID.map((r) => ({
    r,
    label: pct(r),
    price: to.price - span * r,
  }));
  let actual = null;
  if (Number.isFinite(actualPrice)) {
    const ratio = (to.price - actualPrice) / span;
    const snap = snapTo(ratio, GRID);
    actual = {
      price: actualPrice,
      ratio,
      label: pct(ratio),
      nearest: snap.level,
      nearestLabel: pct(snap.level),
      hit: snap.hit,
    };
  }
  return {
    type: 'retracement',
    name,
    note: note || '',
    anchors: [
      { label: '기준 시작', t: from.t, price: from.price },
      { label: '기준 끝', t: to.t, price: to.price },
    ],
    levels,
    actual,
  };
}

// ---------------------------------------------------------------------------
// 피보나치 확장 도구 (3점)
//   p0 → p1 길이를 p2에서 투영한다. 트레이딩뷰 "추세 기반 피보나치 확장"과 동일.
// ---------------------------------------------------------------------------
function extensionTool(name, p0, p1, p2, actualPrice, note) {
  const span = p1.price - p0.price;
  if (!span) return null;
  const levels = EXTEND_LEVELS.map((r) => ({
    r,
    label: pct(r),
    price: p2.price + span * r,
  }));
  let actual = null;
  if (Number.isFinite(actualPrice)) {
    const ratio = (actualPrice - p2.price) / span;
    const snap = snapTo(ratio, EXTEND_LEVELS, 0.12);
    actual = {
      price: actualPrice,
      ratio,
      label: pct(ratio),
      nearest: snap.level,
      nearestLabel: pct(snap.level),
      hit: snap.hit,
    };
  }
  return {
    type: 'extension',
    name,
    note: note || '',
    anchors: [
      { label: '0', t: p0.t, price: p0.price },
      { label: '1', t: p1.t, price: p1.price },
      { label: '2', t: p2.t, price: p2.price },
    ],
    levels,
    actual,
  };
}

// ---------------------------------------------------------------------------
// 충격파 후보 하나의 작도
// ---------------------------------------------------------------------------
function buildImpulseConstruction(cand) {
  const P = cand.pivots;
  const labels = ['0', '1', '2', '3', '4', '5'];
  const anchors = P.map((p, i) => ({
    label: labels[i],
    t: p.t,
    price: p.price,
    kind: p.kind,
    confirmed: p.confirmed,
  }));

  const tools = [];

  // ① 2파 되돌림 — 0→1 에 되돌림을 걸고 2파 저점이 어디 떨어졌는지
  if (P.length > 2) {
    const t = retracementTool(
      '2파 되돌림 (0→1 기준)',
      P[0], P[1], P[2].price,
      '1파 시작점과 고점에 되돌림을 걸었다. 2파가 61.8% 부근이면 전형적이고, 78.6%를 넘으면 2파가 아닐 수 있다'
    );
    if (t) tools.push(t);
  }

  // ② 3파 확장 — 0-1-2 에 확장을 걸고 3파 고점이 어디 떨어졌는지
  if (P.length > 3) {
    const t = extensionTool(
      '3파 확장 (0-1-2 기준)',
      P[0], P[1], P[2], P[3].price,
      '1파 길이를 2파 저점에서 투영했다. 3파는 161.8%가 가장 흔하다'
    );
    if (t) tools.push(t);
  }

  // ③ 4파 되돌림 — 2→3 에 되돌림
  if (P.length > 4) {
    const t = retracementTool(
      '4파 되돌림 (2→3 기준)',
      P[2], P[3], P[4].price,
      '3파 구간에 되돌림을 걸었다. 4파는 23.6~38.2%가 통상이며, 50%를 넘으면 4파가 아니다'
    );
    if (t) tools.push(t);
  }

  // ④ 5파 목표 — 진행 중이면 투영, 완성됐으면 실측
  if (P.length >= 5) {
    const actual5 = P.length > 5 ? P[5].price : null;
    const t = extensionTool(
      '5파 목표 (0-3-4 기준)',
      P[0], P[3], P[4], actual5,
      '3파 고점까지의 길이를 4파 저점에서 투영했다. 5파는 61.8~100%가 흔하다'
    );
    if (t) tools.push(t);
    // 1파 대비 5파
    const t2 = extensionTool(
      '5파 목표 (1파 대비)',
      P[0], P[1], P[4], actual5,
      '1파 길이를 4파 저점에서 투영했다. 5파가 1파의 100%면 균형형'
    );
    if (t2) tools.push(t2);
  }

  return { anchors, tools };
}

// ---------------------------------------------------------------------------
// 조정파(ABC) 후보의 작도
// ---------------------------------------------------------------------------
function buildCorrectiveConstruction(cand) {
  const P = cand.pivots;
  const labels = ['0', 'A', 'B', 'C'];
  const anchors = P.map((p, i) => ({
    label: labels[i],
    t: p.t,
    price: p.price,
    kind: p.kind,
    confirmed: p.confirmed,
  }));

  const tools = [];
  if (P.length > 2) {
    const t = retracementTool(
      'B파 되돌림 (0→A 기준)',
      P[0], P[1], P[2].price,
      'A파 구간에 되돌림을 걸었다. 61.8% 이하면 전형적 지그재그, 78.6%를 넘으면 플랫을 의심한다'
    );
    if (t) tools.push(t);
  }
  if (P.length > 2) {
    const actualC = P.length > 3 ? P[3].price : null;
    const t = extensionTool(
      'C파 확장 (0-A-B 기준)',
      P[0], P[1], P[2], actualC,
      'A파 길이를 B파 끝에서 투영했다. C파는 100%와 161.8%가 각각 40% 확률로 가장 흔하다'
    );
    if (t) tools.push(t);
  }
  return { anchors, tools };
}

// ---------------------------------------------------------------------------
// 복합조정(WXY / WXYXZ)의 작도
//
// 부분 패턴 하나하나가 아니라 "부분들이 어떤 비율로 이어졌는가"를 그린다.
// 복합조정의 판정은 x파동 크기 하나로 갈리므로, 그 눈금이 이 작도의 본론이다.
//   0.618 아래  → 범주 1 (세력 +2)
//   1.618 위    → 범주 2 (세력 -3, 러닝이면 +3)
// ---------------------------------------------------------------------------
const XWAVE_GRID = [0.382, 0.618, 1.0, 1.382, 1.618, 2.618];

function buildComplexConstruction(cand) {
  const segs = cand.segments || [];
  if (segs.length < 3) return null;

  // 구간 경계만 앵커로 찍는다 — 내부 a·b·c까지 찍으면 읽을 수 없다
  const first = segs[0].pivots[0];
  const anchors = [{ label: '0', t: first.t, price: first.price, kind: first.kind, confirmed: first.confirmed }];
  for (const s of segs) {
    const end = s.pivots[s.pivots.length - 1];
    anchors.push({
      label: s.role,
      t: end.t,
      price: end.price,
      kind: end.kind,
      confirmed: end.confirmed,
      sub: s.name, // 그 구간이 무슨 패턴이었는지
    });
  }

  const tools = [];
  const wStart = segs[0].pivots[0];
  const wEnd = segs[0].pivots[segs[0].pivots.length - 1];

  // ① x파동 되돌림 — 범주를 가르는 눈금
  const x1 = segs[1];
  const x1End = x1.pivots[x1.pivots.length - 1];
  const tx = retracementTool(
    'x파동 되돌림 (0→W 기준)',
    wStart, wEnd, x1End.price,
    'W파 구간에 되돌림을 걸었다. 61.8% 이하면 범주1(집약형·세력 +2), ' +
    '161.8% 이상이면 범주2(확산형·세력 -3, 러닝이면 +3)다. 그 사이는 닐리가 정의하지 않았다',
    XWAVE_GRID
  );
  if (tx) tools.push(tx);

  // ② Y파 투영 — W 길이를 x 끝에서 투영한다
  const yEndPrice = segs[2] ? segs[2].pivots[segs[2].pivots.length - 1].price : null;
  const ty = extensionTool(
    'Y파 투영 (0-W-x 기준)',
    wStart, wEnd, x1End, yEndPrice,
    'W파 길이를 x파동 끝에서 투영했다. 횡보 복합조정이면 각 파동이 서로 78.6~138.2%에 든다'
  );
  if (ty) tools.push(ty);

  // ③ 삼중이면 Z파도 같은 방식으로
  if (segs.length >= 5) {
    const x2 = segs[3];
    const x2End = x2.pivots[x2.pivots.length - 1];
    const zEndPrice = segs[4].pivots[segs[4].pivots.length - 1].price;
    const tz = extensionTool(
      'Z파 투영 (0-W-x2 기준)',
      wStart, wEnd, x2End, zEndPrice,
      'W파 길이를 두 번째 x파동 끝에서 투영했다. 삼중은 닐리도 거의 없다고 본 형태다'
    );
    if (tz) tools.push(tz);
  }

  return { anchors, tools };
}

// ---------------------------------------------------------------------------
// 하모닉 후보의 작도 — XA 되돌림 + BC 확장
// ---------------------------------------------------------------------------
function buildHarmonicConstruction(h) {
  const isShark = h.id === 'shark';
  const pt = h.points;
  const anchors = ['X', 'A', 'B', 'C', 'D'].map((k) => ({
    label: k,
    t: pt[k].t,
    price: pt[k].price,
    kind: pt[k].kind,
    confirmed: pt[k].confirmed,
  }));
  const tools = [];
  const t1 = retracementTool(
    'B점 판정 (X→A 되돌림)',
    pt.X, pt.A, pt.B.price,
    'X와 A에 되돌림을 걸었다. B가 어느 눈금에 떨어지느냐로 패턴 종류가 거의 결정된다'
  );
  if (t1) tools.push(t1);
  // 샤크만 D를 XA가 아니라 XC로 잰다 — 패턴 정의가 다르다
  const t2 = isShark
    ? retracementTool(
        'D점 판정 (X→C 되돌림)',
        pt.X, pt.C, pt.D.price,
        '샤크는 XA가 아니라 XC에 되돌림을 건다. D는 88.6~113%가 유효 구간'
      )
    : retracementTool(
        'D점 판정 (X→A 되돌림)',
        pt.X, pt.A, pt.D.price,
        '같은 도구로 D를 본다. 가틀리 78.6%, 뱃 88.6%, 나비 127.2%, 크랩 161.8%'
      );
  if (t2) tools.push(t2);
  const t3 = extensionTool(
    'BC 확장 (A-B-C 기준)',
    pt.A, pt.B, pt.C, pt.D.price,
    'BC 마딧가가 XA 되돌림과 겹쳐야 PRZ가 좁아지고 신뢰도가 올라간다'
  );
  if (t3) tools.push(t3);
  return { anchors, tools };
}

// ---------------------------------------------------------------------------
// 시나리오 목록 — 방향이 갈리는 해석들을 전부 세운다.
// "이 카운트가 맞다" 가 아니라 "이런 갈래가 있고 각각 이렇게 되면 죽는다"를 낸다.
// ---------------------------------------------------------------------------
function buildScenarios(analysis, price) {
  const out = [];

  // 고전 엘리어트 후보들
  for (const [i, c] of (analysis.wave && analysis.wave.candidates || []).entries()) {
    const tag = String.fromCharCode(65 + i);
    const up = c.dir === 'up';
    const construction =
      c.type === 'impulse' ? buildImpulseConstruction(c) : buildCorrectiveConstruction(c);
    out.push({
      id: `wave${tag}`,
      source: '엘리어트',
      tag,
      title: `${c.dirLabel} · ${c.stageName}`,
      progress: c.inProgress
        ? `${typeof c.inProgress === 'number' ? c.inProgress + '파' : c.inProgress} 진행 중`
        : '완성',
      direction: up ? 'UP' : 'DOWN',
      score: c.score,
      invalidation: c.invalidation,
      invalidReason: c.invalidReason,
      targets: (c.targets || []).map((t) => ({ label: t.label, price: t.price })),
      diagonal: c.diagonal || null,
      truncation: c.truncation || null,
      construction,
    });
  }

  // 조정 패턴 후보들 (지그재그·플랫·삼각형)
  for (const p of (analysis.corrective && analysis.corrective.patterns) || []) {
    out.push({
      id: `corr_${p.type}_${out.length}`,
      source: '조정패턴',
      tag: p.type === 'zigzag' ? 'Z' : p.type === 'flat' ? 'F' : p.type === 'complex' ? 'W' : 'T',
      title: p.name,
      progress: '',
      direction: p.down === true ? 'DOWN' : p.down === false ? 'UP' : 'NEUTRAL',
      score: p.score,
      invalidation: p.invalidation,
      invalidReason: p.invalidLabel,
      targets: (p.targets || []).map((t) => ({ label: t.label, price: t.price, prob: t.prob })),
      construction: p.type === 'complex'
        ? buildComplexConstruction(p)
        : (p.pivots ? buildCorrectiveConstruction({ pivots: p.pivots }) : null),
    });
  }

  // 하모닉 후보들
  for (const h of (analysis.harmonic && analysis.harmonic.patterns) || []) {
    out.push({
      id: `harm_${h.id}`,
      source: '하모닉',
      tag: 'H',
      title: `${h.name} ${h.bullish ? '강세' : '약세'}`,
      progress: `PRZ ${money(h.prz.low)}~${money(h.prz.high)}`,
      direction: h.bullish ? 'UP' : 'DOWN',
      score: h.score,
      invalidation: h.stop,
      invalidReason: '손절 레벨 이탈 시 패턴 실패',
      targets: (h.targets || []).map((t) => ({ label: t.label, price: t.price })),
      construction: buildHarmonicConstruction(h),
    });
  }

  // 방향 집계 — "가짓수"를 숫자로 보여준다
  const upN = out.filter((s) => s.direction === 'UP').length;
  const downN = out.filter((s) => s.direction === 'DOWN').length;
  const summary = {
    total: out.length,
    up: upN,
    down: downN,
    verdict:
      out.length === 0
        ? '유효한 시나리오 없음'
        : upN > downN * 2
          ? '상방 해석이 우세'
          : downN > upN * 2
            ? '하방 해석이 우세'
            : '상·하방 해석이 갈린다 — 방향 확정 불가',
  };

  return { scenarios: out.sort((a, b) => b.score - a.score), summary };
}

// 문장화 — 프롬프트에도 들어간다
function describeConstruction(result) {
  const out = [];
  if (!result || !result.scenarios.length) return ['작도 가능한 시나리오 없음'];

  const s = result.summary;
  out.push(`시나리오 ${s.total}갈래 — 상방 ${s.up} / 하방 ${s.down} · ${s.verdict}`);
  out.push('');

  for (const sc of result.scenarios.slice(0, 4)) {
    out.push(
      `[${sc.source} ${sc.tag}] ${sc.title}${sc.progress ? ' · ' + sc.progress : ''} · ` +
        `${sc.direction === 'UP' ? '▲상방' : sc.direction === 'DOWN' ? '▼하방' : '●중립'} · ${sc.score}점`
    );
    if (sc.construction) {
      const a = sc.construction.anchors.map((x) => `${x.label}=${money(x.price)}`).join(' → ');
      out.push(`   앵커: ${a}`);
      for (const t of sc.construction.tools) {
        let line = `   ${t.name}`;
        if (t.actual) {
          line += ` → 실측 ${t.actual.label}` +
            (t.actual.hit ? ` (${t.actual.nearestLabel} 부합 ✔)` : ` (근접 ${t.actual.nearestLabel}, 어긋남)`);
        }
        out.push(line);
      }
    }
    if (sc.invalidation != null) {
      out.push(`   무효화: ${money(sc.invalidation)} — ${sc.invalidReason || ''}`);
    }
    if (sc.targets && sc.targets.length) {
      out.push(
        `   목표: ${sc.targets.map((t) => `${t.label} ${money(t.price)}${t.prob ? `(${t.prob}%)` : ''}`).join(' · ')}`
      );
    }
  }
  return out;
}

function computeConstruction(candles, analysis) {
  const price = candles[candles.length - 1].c;
  const r = buildScenarios(analysis, price);
  return { ...r, lines: describeConstruction(r) };
}

module.exports = {
  computeConstruction,
  buildScenarios,
  retracementTool,
  extensionTool,
  buildComplexConstruction,
  RETRACE_LEVELS,
  EXTEND_LEVELS,
};
