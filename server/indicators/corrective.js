'use strict';

// WAVE FLOOR — 조정 패턴 (지그재그 · 플랫 · 삼각형 · 복합조정)
//
// 명세: docs/파동분석-통합본.md 3장
//
// 조정 패턴을 제대로 가르는 것이 4파 판정의 정확도를 좌우한다.
// 특히 플랫의 C파를 임펄스로 오인하고 진입하는 것이 자료가 반복해서 경고하는 함정이다.

const NEELY = require('./neely-patterns');

// 지그재그 B파 등급 — 자료마다 상한이 달라(0.618 / 0.786 / 100%) 등급으로 나눴다.
// 하나를 임의로 고르면 정보를 버리게 되므로 전부 살리고 점수로 표현한다.
const ZIGZAG_B_TIERS = [
  { max: 0.618, tier: '전형적', bonus: 10, note: '가장 흔한 지그재그 되돌림' },
  { max: 0.786, tier: '정상', bonus: 0, note: '지그재그로 인정되는 범위' },
  { max: 1.0, tier: '약함', bonus: -20, note: '플랫 가능성 병기 필요 — 지그재그로 확정하지 마라' },
];

// C파 확률 분포 — 통합본 3.3.
// 확률이 명시된 유일한 자료라 목표가를 단일 값이 아니라 분포로 낼 수 있다.
// PILOT(실행 설계관)의 손익비 계산에 직접 쓴다.
function cWaveDistribution(bRetrace) {
  if (!Number.isFinite(bRetrace)) return null;
  if (bRetrace >= 0.7) {
    return {
      band: 'B파 0.7 이상 되돌림',
      dist: [
        { ratio: 1.0, prob: 20 },
        { ratio: 1.382, prob: 40 },
        { ratio: 1.618, prob: 40 },
      ],
    };
  }
  return {
    band: 'B파 0.618 부근 되돌림',
    dist: [
      { ratio: 0.618, prob: 5 },
      { ratio: 1.0, prob: 40 },
      { ratio: 1.382, prob: 5 },
      { ratio: 1.618, prob: 40 },
      { ratio: 2.618, prob: 10 },
    ],
  };
}

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}
function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function nearest(v, list) {
  let best = null;
  for (const t of list) {
    const dev = Math.abs(v - t) / t;
    if (!best || dev < best.dev) best = { t, dev };
  }
  return best;
}

// ---------------------------------------------------------------------------
// 지그재그 (5-3-5) — A, B, C
// ---------------------------------------------------------------------------
function detectZigzag(pv) {
  if (pv.length < 4) return null;
  const [P0, PA, PB, PC] = pv.slice(0, 4).map((p) => p.price);
  const down = PA < P0; // A가 하락이면 하락 지그재그
  const sgn = down ? -1 : 1;

  const a = sgn * (PA - P0);
  const b = -sgn * (PB - PA);
  const c = sgn * (PC - PB);
  if (!(a > 0 && b > 0 && c > 0)) return null;

  const rB = b / a;
  if (rB > 1.0) {
    return { valid: false, why: `B파가 A파를 ${pct(rB)} 되돌림 — 100% 초과라 지그재그가 아니다` };
  }

  // B파 등급
  let grade = ZIGZAG_B_TIERS[ZIGZAG_B_TIERS.length - 1];
  for (const t of ZIGZAG_B_TIERS) {
    if (rB <= t.max) { grade = t; break; }
  }

  const rC = c / a;
  const cNear = nearest(rC, [0.618, 1.0, 1.618]);

  // 절단 — A:C가 1:0.618을 넘지 못하면 절단, 최소 81% 되돌림 예상
  const truncated = rC < 0.618;

  // 시간 비율 — A:C가 1:1이면 소요 시간도 1:1이어야 한다
  const barsA = pv[1].i - pv[0].i;
  const barsC = pv[3].i - pv[2].i;
  const timeRatio = barsA > 0 ? barsC / barsA : null;
  const timeAligned =
    Math.abs(rC - 1.0) < 0.15 && timeRatio != null && Math.abs(timeRatio - 1.0) < 0.35;

  let score = 60;
  score += grade.bonus;
  score += Math.max(0, 25 * (1 - cNear.dev / 0.3));
  if (timeAligned) score += 10;
  if (truncated) score -= 15;
  score = Math.max(0, Math.min(100, Math.round(score)));

  // 닐리 5장 — 파동 c 길이로 변형을 가른다 (불완전 / 표준 / 연장).
  // 카탈로그가 기준이다. 닐리가 "지그재그 아님"이라고 하면 여기서 폐기한다 —
  // 우리 자체 판정이 더 느슨해서 c/a가 38.2%에도 못 미치는 것을 통과시키고 있었다.
  const neelyVariant = NEELY.classifyZigzag(rC);
  if (!neelyVariant.id) {
    return { valid: false, why: `${neelyVariant.name} — ${neelyVariant.note || ''}` };
  }
  // 닐리 10장 — 그 변형의 세력 순위와 되돌림 한계
  const power = NEELY.powerOf(neelyVariant.id, { completedDown: down });

  return {
    valid: true,
    type: 'zigzag',
    name: down ? '하락 지그재그 (5-3-5)' : '상승 지그재그 (5-3-5)',
    neely: neelyVariant,
    power,
    down,
    score,
    ratios: { B: rB, C: rC, cNear: cNear.t, timeRatio },
    grade,
    truncated,
    timeAligned,
    invalidation: P0,
    invalidLabel: `A파 시작점 ${money(P0)} 이탈 시 지그재그 무효`,
    cDist: cWaveDistribution(rB),
    targets: (cWaveDistribution(rB) || { dist: [] }).dist.map((d) => ({
      label: `C파 A의 ${pct(d.ratio)} (${d.prob}%)`,
      price: PB + sgn * a * d.ratio,
      prob: d.prob,
    })),
    pivots: pv.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// 플랫 (3-3-5) — B파는 A파를 90% 이상 되돌려야 한다
// ---------------------------------------------------------------------------
function detectFlat(pv) {
  if (pv.length < 4) return null;
  const [P0, PA, PB, PC] = pv.slice(0, 4).map((p) => p.price);
  const down = PA < P0;
  const sgn = down ? -1 : 1;

  const a = sgn * (PA - P0);
  const b = -sgn * (PB - PA);
  const c = sgn * (PC - PB);
  if (!(a > 0 && b > 0 && c > 0)) return null;

  const rB = b / a;
  if (rB < 0.9) {
    return { valid: false, why: `B파가 A파의 ${pct(rB)}만 되돌림 — 플랫은 90% 이상이어야 한다` };
  }

  const rC = c / a;

  // 종류 판정
  //  러닝  : B가 A 시작점을 넘고, C가 A 끝을 못 넘는다
  //  확장  : C가 A 끝을 넘는다 (가장 흔함)
  //  레귤러: 그 외
  const bExceedsStart = down ? PB > P0 : PB < P0;
  const cExceedsA = down ? PC < PA : PC > PA;

  let kind, kindNote, expectC;
  if (bExceedsStart && !cExceedsA) {
    kind = '러닝 플랫';
    kindNote = '매우 드물다. 한 방향 힘이 강할 때 나오며, 2파에서 러닝이면 3파가 강하게 간다';
    expectC = [0.618, 0.786];
  } else if (cExceedsA) {
    kind = '확장(익스팬디드) 플랫';
    kindNote = '가장 흔한 플랫. C가 A 끝을 넘어선다';
    expectC = [1.618, 2.236, 2.618];
  } else {
    kind = '레귤러 플랫';
    kindNote = '드물게 등장. a≈b≈c 형태';
    expectC = [1.0, 1.382, 1.618];
  }

  // 하드 체크 — 확장 플랫의 C는 A의 3배를 넘을 수 없다
  if (kind.startsWith('확장') && rC > 3.0) {
    return { valid: false, why: `C파가 A파의 ${pct(rC)} — 확장 플랫도 3배를 넘을 수 없다` };
  }
  // 확장 플랫이 아니면 1.618이 상한
  if (!kind.startsWith('확장') && rC > 1.786) {
    return {
      valid: false,
      why: `C파가 A파의 ${pct(rC)} — 확장 플랫이 아닌데 1.786을 넘었다. ABC가 아니라 A파일 수 있다`,
    };
  }

  const cNear = nearest(rC, expectC);
  let score = 55 + Math.max(0, 30 * (1 - cNear.dev / 0.35));
  if (kind.startsWith('러닝')) score += 8; // 드물지만 신호가 강하다
  score = Math.max(0, Math.min(100, Math.round(score)));

  // 닐리 5장 — 파동 b 강도(3분류) → 파동 c 로 최종 변형(8종)을 확정한다.
  // 기존의 레귤러/확장/러닝 3분류보다 훨씬 세밀하다.
  const neelyVariant = NEELY.classifyFlat(rB, rC / rB, rC);
  const power = neelyVariant && neelyVariant.ok && neelyVariant.id
    ? NEELY.powerOf(neelyVariant.id, { completedDown: down })
    : null;

  return {
    valid: true,
    type: 'flat',
    name: `${down ? '하락' : '상승'} ${kind} (3-3-5)`,
    kind,
    kindNote,
    neely: neelyVariant,
    power,
    down,
    score,
    ratios: { B: rB, C: rC, cNear: cNear.t },
    warning:
      '플랫의 C파를 임펄스로 보고 진입하면 크게 당한다. 둘은 비슷해 보이지만 플랫은 조정파동이다',
    invalidation: P0,
    invalidLabel: `A파 시작점 ${money(P0)}`,
    targets: expectC.map((r) => ({ label: `C파 A의 ${pct(r)}`, price: PB + sgn * a * r })),
    pivots: pv.slice(0, 4),
  };
}

// ---------------------------------------------------------------------------
// 삼각형 (3-3-3-3-3) — ABCDE 5파동
// 위치 제한: 임펄스 4파 / 지그재그·플랫 B파 / Double Three Y / Triple Three Z
// ---------------------------------------------------------------------------
function detectTriangle(pv) {
  if (pv.length < 6) return null;
  const p = pv.slice(0, 6);
  const P = p.map((x) => x.price);
  // A,B,C,D,E 각 파동
  const legs = [];
  for (let i = 1; i < 6; i++) legs.push(Math.abs(P[i] - P[i - 1]));
  if (legs.some((l) => !(l > 0))) return null;

  const [A, B, C, D, E] = legs;

  // 수렴: C<A, D<B, E<C
  const contracting = C < A && D < B && E < C;
  // 확산: C>A, D>B, E>C
  const expanding = C > A && D > B && E > C;
  if (!contracting && !expanding) return null;

  // 러닝 수렴삼각형 — B가 A를 넘어선다 (약 60%로 꽤 흔하다)
  const running = contracting && B > A;

  const ratios = { CA: C / A, DB: D / B, EC: E / C, BA: B / A };
  let score = 50;
  let note;

  if (contracting) {
    // 수렴형은 대부분 파동이 이전 파동의 0.618~0.786 되돌림
    const fits = [ratios.CA, ratios.DB, ratios.EC].map((r) => {
      const n = nearest(r, [0.618, 0.786]);
      return Math.max(0, 1 - n.dev / 0.35);
    });
    score += (fits.reduce((s, f) => s + f, 0) / 3) * 40;
    note = running
      ? '러닝 수렴삼각형 — B가 A를 넘는 형태로 약 60% 빈도로 나온다'
      : '수렴삼각형 — 진행하며 거래량과 모멘텀이 감소해야 한다';
    // 러닝은 B가 A의 1.618 이하여야 한다
    if (running && ratios.BA > 1.618) {
      return { valid: false, why: `러닝 삼각형인데 B가 A의 ${pct(ratios.BA)} — 1.618을 넘을 수 없다` };
    }
  } else {
    // 확산형은 각각 1.618 되돌림
    const fits = [ratios.CA, ratios.DB, ratios.EC].map((r) => {
      const n = nearest(r, [1.618]);
      return Math.max(0, 1 - n.dev / 0.4);
    });
    score += (fits.reduce((s, f) => s + f, 0) / 3) * 40;
    note = '확산삼각형 — 수렴형보다 훨씬 드물게 나온다';
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  // E파 완성 후 5파는 시작부 추세 힘과 비슷한 추력이 생긴다.
  // 매수는 수렴 안이 아니라 삼각형 입구 크기의 1:1 지점에서.
  const mouth = Math.abs(P[1] - P[0]); // 입구 크기 = A파
  const breakUp = Math.max(...P.slice(1)) ;
  const breakDown = Math.min(...P.slice(1));

  return {
    valid: true,
    type: 'triangle',
    name: contracting ? (running ? '러닝 수렴삼각형' : '수렴삼각형') : '확산삼각형',
    contracting,
    running,
    score,
    ratios,
    note,
    position: '임펄스 4파 / 지그재그·플랫의 B파 / 복합조정의 마지막 파동에서만 나온다',
    targets: [
      { label: '상방 이탈 목표 (입구 1:1)', price: breakUp + mouth },
      { label: '하방 이탈 목표 (입구 1:1)', price: breakDown - mouth },
    ],
    entryNote: '수렴 안에서 매수하지 말고 삼각형 입구 크기의 1:1 지점에서 받는 것이 신뢰도가 높다',
    pivots: p,
  };
}

// ---------------------------------------------------------------------------
// 복합조정 (WXY / WXYXZ) — 닐리 8장 x파동 · 표 A · 세력 순위 범주 1/2
//
// 구조: 표준 조정패턴 두세 개를 x파동이 잇는다. 각 부분을 따로 검증한 뒤
// 이어붙이는 방식이라, 부분이 하나라도 지그재그·플랫·삼각형이 아니면 성립하지 않는다.
//
// 판정의 핵심은 "x파동이 얼마나 큰가" 하나다. 이것이 범주를 가르고,
// 범주가 세력 순위를 정하고, 세력 순위가 다음 파동의 되돌림 한계를 정한다.
//   작은 x (≤61.8%)  → 범주 1 → 세력 +2 → 되돌림 80% 이하
//   큰 x  (≥161.8%) → 범주 2 → 세력 -3 → 되돌림 70% 이하 + 후속 충격파 161.8% 이상
// ---------------------------------------------------------------------------

// 부분 구간 하나를 표준 조정패턴으로 판정한다.
// seg 는 피벗 배열. 4개면 지그재그·플랫, 6개면 삼각형을 시도한다.
function classifySegment(seg, { allowTriangle }) {
  if (seg.length === 2) {
    return { kind: 'mono', name: '조정 모노파동', legs: 1, detail: null, score: 55 };
  }
  if (seg.length === 4) {
    const cands = [];
    const z = detectZigzag(seg);
    if (z && z.valid) cands.push({ kind: 'zigzag', name: z.name, legs: 3, detail: z, score: z.score });
    const f = detectFlat(seg);
    if (f && f.valid) cands.push({ kind: 'flat', name: f.name, legs: 3, detail: f, score: f.score });
    cands.sort((a, b) => b.score - a.score);
    return cands[0] || null;
  }
  if (seg.length === 6) {
    if (!allowTriangle) return null;
    const t = detectTriangle(seg);
    // 표 A 의 삼각형은 전부 "수렴만" 이다. 확산형은 복합조정의 부분이 될 수 없다.
    if (t && t.valid && t.contracting) {
      return { kind: 'triangle', name: t.name, legs: 5, detail: t, score: t.score };
    }
    return null;
  }
  return null;
}

const lastLabelOf = (parts) => (parts.length >= 3 ? 'Z' : 'Y');

// x파동 교대 — 직전 조정파동에서 형태가 바뀌어야 한다 (XWAVE.alternation)
function xAlternationOk(prevKind, xKind) {
  if (xKind === 'mono') return true; // 모노파동은 어느 경우에도 허용된다
  if (prevKind === 'zigzag') return xKind === 'flat' || xKind === 'triangle';
  if (prevKind === 'flat') return xKind === 'zigzag';
  return true;
}

function detectComplex(pool) {
  if (!Array.isArray(pool) || pool.length < 8) return null;

  const results = [];
  const W_LENS = [4];           // W 는 지그재그·플랫만 (삼각형은 마지막 파동에서만)
  const X_LENS = [2, 4];        // x파동: 모노파동 또는 표준 조정패턴
  const LAST_LENS = [4, 6];     // 마지막 파동만 삼각형(6피벗) 가능

  // 이중(WXY) 과 삼중(WXYXZ) 을 모두 시도한다.
  // 삼중은 닐리도 "실제로 거의 존재하지 않는다"고 적었으므로 감점해서 내보낸다.
  const shapes = [];
  for (const wl of W_LENS) for (const xl of X_LENS) for (const yl of LAST_LENS) {
    shapes.push([wl, xl, yl]);
    for (const x2 of X_LENS) for (const zl of LAST_LENS) shapes.push([wl, xl, 4, x2, zl]);
  }

  for (const shape of shapes) {
    // 피벗 소비량 — 이웃한 구간은 끝점을 공유한다
    const need = shape.reduce((s, n) => s + n - 1, 0) + 1;
    if (need > pool.length) continue;
    const win = pool.slice(pool.length - need); // 항상 최신 피벗에서 끝난다

    // 피벗이 고·저로 교대하지 않으면 애초에 파동이 아니다
    let alt = true;
    for (let i = 1; i < win.length; i++) if (win[i].kind === win[i - 1].kind) alt = false;
    if (!alt) continue;

    // 구간별로 잘라 각각 판정
    const segs = [];
    let cur = 0;
    let ok = true;
    for (let k = 0; k < shape.length; k++) {
      const seg = win.slice(cur, cur + shape[k]);
      const isX = k % 2 === 1;
      const isLast = k === shape.length - 1;
      const c = classifySegment(seg, { allowTriangle: isLast });
      // x파동 자리에 삼각형은 두지 않는다 (표 A 의 삼각형은 전부 마지막 자리다)
      if (!c || (isX && c.kind === 'triangle')) { ok = false; break; }
      // W·Y·Z 자리에 모노파동은 둘 수 없다 — 표준 조정패턴이어야 한다
      if (!isX && c.kind === 'mono') { ok = false; break; }
      segs.push({ ...c, role: isX ? 'x' : ['W', 'Y', 'Z'][k / 2], pivots: seg });
      cur += shape[k] - 1;
    }
    if (!ok) continue;

    const parts = segs.filter((s) => s.role !== 'x');
    const xs = segs.filter((s) => s.role === 'x');

    // ---- 방향 ----
    // W 와 Y(Z) 는 조정 방향, x파동은 그 반대(직전 추세 방향)로 뻗는다
    const dirOf = (s) => Math.sign(s.pivots[s.pivots.length - 1].price - s.pivots[0].price);
    const wDir = dirOf(parts[0]);
    if (wDir === 0) continue;
    let dirOk = true;
    for (const s of parts.slice(1)) if (dirOf(s) !== wDir && s.kind !== 'triangle') dirOk = false;
    for (const s of xs) if (dirOf(s) === wDir) dirOk = false;
    if (!dirOk) continue;

    // ---- 크기와 기간 ----
    const lenOf = (s) => Math.abs(s.pivots[s.pivots.length - 1].price - s.pivots[0].price);
    const barsOf = (s) => s.pivots[s.pivots.length - 1].i - s.pivots[0].i;
    const lenW = lenOf(parts[0]);
    if (!(lenW > 0)) continue;

    const xRatios = xs.map((s) => lenOf(s) / lenW);
    const partRatios = parts.slice(1).map((s) => lenOf(s) / lenW);

    // 부분끼리 지나치게 어긋나면 복합조정이 아니라 다른 패턴이다
    if (partRatios.some((r) => r > 2.618)) continue;

    // ── 유사성과 균형의 법칙 (닐리 4장) ──────────────────────────────────
    // 복합조정은 "같은 등급의 조정파동을 x파동이 이은 것"이다. 등급이 같다는 말은
    // 가격이든 시간이든 최소 1/3 은 닮아 있어야 한다는 뜻이다. W 의 17% 짜리 Y 를
    // 붙여놓고 이중조정이라 부르면 등급이 다른 것을 묶은 셈이라 그 위가 전부 무의미해진다.
    // 여기서는 경고가 아니라 폐기다 — 등급이 같다는 것이 이 패턴의 정의 자체이기 때문.
    // 닐리의 기준은 "가격 또는 시간" 이므로 가격이 크게 어긋나도 기간이 비슷하면 통과한다.
    // 통과시키되 그 사실을 숨기지는 않는다 — 시간만으로 붙은 등급은 약한 근거다.
    const barsW = barsOf(parts[0]);
    const degree = { ok: true, timeOnly: false };
    for (const s of parts.slice(1)) {
      const sim = NEELY.checkSimilarity(lenW, lenOf(s), barsW, barsOf(s));
      if (!sim.ok) degree.ok = false;
      else if (!sim.priceOk) degree.timeOnly = true;
    }
    if (!degree.ok) continue;

    // ---- 닐리 판정 ----
    const xInfo = NEELY.classifyXWave(xRatios[0]);
    const combo = NEELY.classifyCombo(parts.map((p) => p.kind), xInfo);

    // 강세조정 판별 — 마지막 파동이 W 의 끝을 넘지 못하면 러닝이다.
    // 같은 범주 2 안에서도 세력이 -3 과 +3 으로 갈리므로 반드시 나눠야 한다.
    const wEnd = parts[0].pivots[parts[0].pivots.length - 1].price;
    const lastEnd = parts[parts.length - 1].pivots[parts[parts.length - 1].pivots.length - 1].price;
    const running = wDir < 0 ? lastEnd > wEnd : lastEnd < wEnd;
    let powerId = combo.id;
    if (xInfo.category === 2 && running) {
      powerId = parts.length >= 3 ? 'tripleRunning' : 'doubleRunning';
    }
    const power = NEELY.powerOf(powerId, { completedDown: wDir < 0 });

    // 범주가 미확정이면 양쪽 세력을 모두 남긴다 (경계에서 하나만 고르지 않는다)
    // 범주 2 로 읽었을 때도 러닝 여부에 따라 세력이 +3 / -3 으로 갈린다.
    // 대안 쪽에서도 이 분기를 그대로 적용해야 비교가 성립한다.
    let powerAlt = null;
    if (xInfo.category == null) {
      const altId = running
        ? (parts.length >= 3 ? 'tripleRunning' : 'doubleRunning')
        : (parts.length >= 3 ? 'tripleThree' : 'doubleThree');
      powerAlt = NEELY.powerOf(altId, { completedDown: wDir < 0 });
    }

    // ---- 경고 ----
    const warnings = [];
    // 시간 — x파동은 복합파동 내에서 거의 항상 가장 짧다
    const partBars = parts.map(barsOf);
    const xBars = xs.map(barsOf);
    const timeOk = xBars.every((b) => b < Math.min(...partBars));
    if (!timeOk) warnings.push('x파동이 W·Y보다 오래 걸렸다 — 닐리는 x파동이 시간상 거의 항상 가장 작다고 본다');
    // 교대
    for (let k = 0; k < xs.length; k++) {
      if (!xAlternationOk(parts[k].kind, xs[k].kind)) {
        warnings.push(`x${xs.length > 1 ? k + 1 : ''}파동이 직전 조정과 같은 형태다 — 교대 원칙에 어긋난다`);
      }
    }
    // 복잡성 — 작은 x파동은 한 등급 낮아야 하므로 모노파동이 자연스럽다
    if (xInfo.size === 'small' && xs[0].kind !== 'mono') {
      warnings.push('작은 x파동인데 표준 패턴이다 — 닐리는 이 경우 복잡성이 한 등급 낮다고 본다');
    }
    if (xInfo.size === 'large' && xs[0].kind === 'mono') {
      warnings.push('큰 x파동인데 모노파동이다 — 조건 2는 모든 조정파동이 같은 복잡성 등급이라고 본다');
    }
    if (degree.timeOnly) {
      warnings.push(
        `W와 ${lastLabelOf(parts)}파의 가격 차이가 3배를 넘는다 — 기간이 비슷해서 같은 등급으로 통과했을 뿐이다`
      );
    }
    // 횡보 복합조정 비율대
    const sideways = partRatios.every((r) => r >= 0.786 && r <= 1.382);

    // ---- 채점 ----
    let score = 52;
    score += Math.round(parts.reduce((s, p) => s + p.score, 0) / parts.length * 0.25);
    if (xInfo.category != null) score += 8; else score -= 6;
    if (timeOk) score += 6;
    if (sideways) score += 5;
    score -= 7 * warnings.length;
    if (parts.length >= 3) score -= 12; // 삼중은 닐리도 "거의 존재하지 않는다"
    if (!combo.fromTable) score -= 5;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // ---- 무효화 · 목표 ----
    const P0 = parts[0].pivots[0].price;
    const xEnd = xs[xs.length - 1].pivots[xs[xs.length - 1].pivots.length - 1].price;
    const sgn = wDir;
    const lastLabel = parts.length >= 3 ? 'Z' : 'Y';

    results.push({
      valid: true,
      type: 'complex',
      name: `${wDir < 0 ? '하락' : '상승'} 복합조정 ${parts.length >= 3 ? 'WXYXZ' : 'WXY'} — ${combo.name}`,
      neely: { name: combo.name, structName: combo.structName, collapse: combo.collapse },
      combo,
      xInfo,
      power,
      powerAlt,
      running,
      down: wDir < 0,
      score,
      segments: segs,
      ratios: { x: xRatios, parts: partRatios, sideways },
      warnings,
      timeOk,
      invalidation: P0,
      invalidLabel: `W파 시작점 ${money(P0)} 이탈 시 복합조정 무효 (전량 되돌림)`,
      // 마지막 파동이 아직 진행 중일 수 있으므로 W 길이 투영 눈금을 함께 낸다
      targets: [0.786, 1.0, 1.382, 1.618].map((r) => ({
        label: `${lastLabel}파 W의 ${pct(r)}`,
        price: xEnd + sgn * lenW * r,
        prob: null,
      })),
      pivots: win,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results[0] || null;
}

// ---------------------------------------------------------------------------
function computeCorrective(candles, pivots, opts = {}) {
  const out = { patterns: [], lines: [] };
  if (!Array.isArray(pivots) || pivots.length < 4) {
    out.lines.push('조정 패턴: 피벗 부족 — 판정 불가');
    return out;
  }

  const found = [];
  const rejected = [];
  const pool = pivots.slice(-9);
  // 복합조정은 최소 8개, 삼중은 12개 이상의 피벗을 쓴다 — 더 넓게 본다
  const wide = pivots.slice(-16);

  // 최근에서 시작해 여러 창을 시도
  for (let take of [6, 4]) {
    for (let s = pool.length - take; s >= 0; s--) {
      const win = pool.slice(s, s + take);
      if (win.length !== take) continue;
      if (win[win.length - 1] !== pool[pool.length - 1]) continue;
      let alt = true;
      for (let i = 1; i < win.length; i++) if (win[i].kind === win[i - 1].kind) alt = false;
      if (!alt) continue;

      if (take === 6) {
        const t = detectTriangle(win);
        if (t && t.valid) found.push(t);
        else if (t && t.why) rejected.push(t.why);
      } else {
        for (const fn of [detectZigzag, detectFlat]) {
          const r = fn(win);
          if (r && r.valid) found.push(r);
          else if (r && r.why) rejected.push(r.why);
        }
      }
    }
  }

  // 복합조정 — 단순 패턴과 같은 목록에 올려 점수로 경쟁시킨다.
  // 같은 구간을 지그재그 하나로도, WXY 로도 읽을 수 있으므로 둘 다 후보로 남긴다.
  const cx = detectComplex(wide);
  if (cx) found.push(cx);

  found.sort((a, b) => b.score - a.score);
  out.patterns = found.slice(0, 3);

  if (!out.patterns.length) {
    out.lines.push('검출된 조정 패턴 없음');
    if (rejected.length) out.lines.push(`  (탈락 사유 예: ${rejected[0]})`);
  } else {
    for (const p of out.patterns) {
      out.lines.push(`${p.name} — ${p.score}점`);
      // 닐리 변형명과 세력 순위를 먼저 보여준다 — 다음 파동의 되돌림 한계를 정하는 값이다
      if (p.neely && p.neely.name) {
        out.lines.push(`   닐리 분류: ${p.neely.name}` +
          (p.neely.needsHorizontalCheck ? ' (수평선 겹침 확인 필요)' : ''));
      }
      if (p.power) {
        out.lines.push(
          `   세력 ${p.power.power >= 0 ? '+' : ''}${p.power.power} → ` +
          `다음 파동 되돌림 ${p.power.maxRetracePct ? p.power.maxRetracePct + '% 이하' : '제한 없음'}` +
          (p.power.nextImpulseMin ? ` · 후속 충격파 최소 ${p.power.nextImpulseMin}배` : '')
        );
      }
      if (p.type === 'zigzag') {
        out.lines.push(
          `   B파 ${pct(p.ratios.B)} [${p.grade.tier}] — ${p.grade.note}`
        );
        out.lines.push(`   C파 ${pct(p.ratios.C)} (근접 ${pct(p.ratios.cNear)})`);
        if (p.timeAligned) out.lines.push('   A:C 가격 1:1 + 시간도 1:1 대응 — 정합도 높음');
        if (p.truncated) out.lines.push('   ⚠ C파 절단 — 최소 81% 되돌림을 예상해야 한다');
      } else if (p.type === 'flat') {
        out.lines.push(`   ${p.kindNote}`);
        out.lines.push(`   B파 ${pct(p.ratios.B)} · C파 ${pct(p.ratios.C)} (근접 ${pct(p.ratios.cNear)})`);
        out.lines.push(`   ⚠ ${p.warning}`);
      } else if (p.type === 'complex') {
        out.lines.push(
          `   구성: ${p.segments.map((s) => (s.role === 'x' ? `x(${s.name})` : `${s.role}=${s.name}`)).join(' → ')}`
        );
        out.lines.push(`   x파동 ${pct(p.ratios.x[0])} → ${p.xInfo.name} · ${p.xInfo.note}`);
        if (p.running) out.lines.push('   마지막 파동이 W 끝을 넘지 못했다 — 강세조정(러닝)이다');
        if (p.ratios.sideways) out.lines.push('   각 파동이 서로 78.6~138.2% — 횡보형 복합조정');
        if (p.powerAlt) {
          out.lines.push(
            `   ⚠ 범주 미확정이라 세력이 갈린다: 범주1이면 ${p.power.power >= 0 ? '+' : ''}${p.power.power}, ` +
            `범주2면 ${p.powerAlt.power >= 0 ? '+' : ''}${p.powerAlt.power} — 되돌림 한계가 ` +
            `${p.power.maxRetracePct}% 와 ${p.powerAlt.maxRetracePct}% 로 달라진다`
          );
        }
        out.lines.push(`   상위 등급에서는 ${p.combo.collapse} 하나로 접힌다`);
        for (const w of p.warnings) out.lines.push(`   ⚠ ${w}`);
      } else if (p.type === 'triangle') {
        out.lines.push(`   ${p.note}`);
        out.lines.push(
          `   C/A ${pct(p.ratios.CA)} · D/B ${pct(p.ratios.DB)} · E/C ${pct(p.ratios.EC)}`
        );
        out.lines.push(`   위치 제한: ${p.position}`);
        out.lines.push(`   ${p.entryNote}`);
      }
      if (p.targets && p.targets.length) {
        out.lines.push(`   목표: ${p.targets.map((t) => `${t.label} ${money(t.price)}`).join(' · ')}`);
      }
      if (p.invalidLabel) out.lines.push(`   무효화: ${p.invalidLabel}`);
    }
  }
  return out;
}

module.exports = {
  computeCorrective,
  detectZigzag,
  detectFlat,
  detectTriangle,
  detectComplex,
  cWaveDistribution,
  ZIGZAG_B_TIERS,
};
