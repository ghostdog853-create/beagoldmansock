'use strict';

// WAVE FLOOR — 중재(仲裁) 레이어
//
// 닐리는 이 프로젝트의 기반이지만 **100%가 아니다.** 텔레그램 실전 기법들도
// 마찬가지다. 그래서 둘이 다른 답을 낼 때 "누가 옳다"를 미리 정해두지 않는다.
//
// 대신 **이 차트에서 각 기법이 실제로 맞혔는지를 세어** 나란히 보여준다.
// 예측을 내는 기법은 과거 구간에 그대로 적용해볼 수 있고, 그 결과는 의견이
// 아니라 숫자다. 종목마다·시간축마다 잘 맞는 기법이 다르다는 것이
// 텔레그램 강의자들 본인의 말이기도 하다 —
//   "알트별로 임펄스가 잘 맞는 분봉들이 따로 있는데…"
//   "카야바는 30분봉이 잘 적용되고 니어는 4시간봉이 잘 적용된다"
//
// ── 표본이 작다는 사실을 절대 감추지 않는다 ────────────────────────────────
// 시간축당 피벗은 15~25개다. 백테스트 표본은 잘해야 3~8건이다.
// 그 정도 표본의 적중률은 신뢰구간이 사실상 0~100%다. 그래서
//   · n < MIN_SAMPLE 이면 적중률을 **점수로 쓰지 않고** "표본 부족"으로만 낸다
//   · 표본이 충분해도 "우세"라고만 말하고 "옳다"고 말하지 않는다
// 이 규칙을 지우면 이 모듈은 근거가 아니라 소음이 된다.

const METHODS = require('./methods');

const MIN_SAMPLE = 5;      // 이 미만이면 적중률을 판단 근거로 쓰지 않는다
const CLEAR_MARGIN = 0.15; // 초과수익(edge) 차이가 이만큼은 나야 "우세"라고 말한다

// ── 적중률만 보면 안 되는 이유 ─────────────────────────────────────────────
// "84% 적중"이라는 숫자는 그 사건이 원래 얼마나 흔한지를 모르면 아무 뜻이 없다.
// 되돌림이 100% 미만인 경우가 원래 56%라면, 56%를 맞히는 기법은 아무것도
// 맞히지 못한 것이다. 실제로 초기 구현에서 닐리 국면 판정이 84%로 나왔는데,
// 뜯어보니 32개 창이 전부 비방향성으로 분류됐고 검증식이 분류식과 같은
// 61.8% 조건을 다시 묻고 있었다 — 자기상관이지 예측력이 아니었다.
//
// 그래서 모든 백테스트는 **기저율(baseRate)** 을 함께 낸다.
//   edge = 적중률 − 기저율
// 비교는 적중률이 아니라 이 edge 로 한다. edge 가 0 근처면 그 기법은
// 이 차트에서 아무 정보도 더하지 않은 것이다. 음수면 오히려 해로웠다는 뜻이다.
function withEdge(name, results, baseRate) {
  const hits = results.filter((r) => r.hit).length;
  const rate = results.length ? hits / results.length : null;
  return {
    name,
    n: results.length,
    hits,
    rate,
    baseRate,
    edge: rate != null && baseRate != null ? rate - baseRate : null,
    results: results.slice(-6),
  };
}

function pct(n, dp = 0) {
  return n == null ? '-' : `${(n * 100).toFixed(dp)}%`;
}

// ---------------------------------------------------------------------------
// 백테스트 ① [T2] 역피보 38.2 / 61.8 반등 판정
//
// 규칙:  반등이 38.2%에 걸리면 → 조정 미완, 추가 진행이 온다
//        반등이 61.8%에 걸리면 → 조정 종결, 추세 재개
// 검증:  그 다음 구간이 실제로 그렇게 갔는가
//   · "38.2 걸림" → 직후 구간이 A의 끝점을 갱신했으면 적중
//   · "61.8 걸림" → 직후 구간이 A의 끝점을 갱신하지 못했으면 적중
// ---------------------------------------------------------------------------
function backtestBounce(pivots) {
  const results = [];
  if (!Array.isArray(pivots) || pivots.length < 5) {
    return { name: '[T2] 역피보 반등 판정', n: 0, hits: 0, rate: null, results };
  }
  // s,e,b 세 점 + 그 다음 점(n)이 있어야 검증할 수 있다
  for (let k = 3; k < pivots.length; k++) {
    const window = pivots.slice(k - 3, k);
    const j = METHODS.bounceJudgement(window);
    if (!j) continue;
    if (j.verdict !== '38.2 걸림' && j.verdict !== '61.8 걸림') continue;
    const e = window[1];              // A의 끝점
    const next = pivots[k];           // 반등 다음 구간의 끝
    const extended = j.down ? next.price < e.price : next.price > e.price;
    const predictedExtend = j.verdict === '38.2 걸림';
    results.push({
      at: e.t,
      verdict: j.verdict,
      retracePct: j.retracePct,
      predicted: predictedExtend ? '추가 진행' : '조정 종결',
      actual: extended ? '추가 진행' : '조정 종결',
      hit: extended === predictedExtend,
    });
  }
  // 기저율 — "다음 구간이 직전 끝점을 갱신한다"가 원래 얼마나 흔한가
  let baseExt = 0;
  let baseTot = 0;
  for (let k = 3; k < pivots.length; k++) {
    const e = pivots[k - 2];
    const s2 = pivots[k - 3];
    const next = pivots[k];
    const down = e.price < s2.price;
    baseTot++;
    if (down ? next.price < e.price : next.price > e.price) baseExt++;
  }
  // 이 기법이 "추가 진행"을 예측한 비율만큼 기저율을 섞어 공정하게 맞춘다
  const pExt = baseTot ? baseExt / baseTot : null;
  const predExt = results.filter((r) => r.predicted === '추가 진행').length / (results.length || 1);
  const base = pExt == null ? null : predExt * pExt + (1 - predExt) * (1 - pExt);
  return withEdge('[T2] 역피보 반등 판정', results, base);
}

// 고전 엘리어트 절대 규칙 3개 — 백테스트 창을 거르는 용도의 가벼운 판정
//   R1 2파는 1파 시작점을 넘지 못한다 · R2 3파는 최단일 수 없다
//   R3 4파는 1파 영역을 침범하지 못한다
function passesAbsoluteRules(P) {
  if (!P || P.length < 6) return false;
  const p = P.map((x) => x.price);
  const up = p[1] > p[0];
  const sgn = up ? 1 : -1;
  const w1 = sgn * (p[1] - p[0]);
  const w3 = sgn * (p[3] - p[2]);
  const w5 = sgn * (p[5] - p[4]);
  if (!(w1 > 0 && w3 > 0 && w5 > 0)) return false;
  if (up ? p[2] <= p[0] : p[2] >= p[0]) return false;          // R1
  if (w3 < w1 && w3 < w5) return false;                         // R2
  if (up ? p[4] <= p[1] : p[4] >= p[1]) return false;           // R3
  return true;
}

// ---------------------------------------------------------------------------
// 백테스트 ② [T3] 엘리엇 앵커 채널의 5파 종료 좌표
//
// 규칙:  5파는 2-3-4 채널의 상단 또는 중앙에서 마감한다
//        (3파가 과도하게 길면 (중앙+하단)/2 에서 절단 종료)
// 검증:  6개 피벗 창을 훑으며 예측 좌표와 실제 5파 종점의 거리를 잰다.
//        채널 폭의 15% 이내면 적중.
// ---------------------------------------------------------------------------
function backtestChannel(pivots) {
  const results = [];
  if (!Array.isArray(pivots) || pivots.length < 6) {
    return { name: '[T3] 엘리엇 앵커 채널 (5파 좌표)', n: 0, hits: 0, rate: null, results };
  }
  for (let s = 0; s + 6 <= pivots.length; s++) {
    const P = pivots.slice(s, s + 6);
    // 고·저가 번갈아야 파동으로 볼 수 있다
    let alt = true;
    for (let i = 1; i < P.length; i++) if (P[i].kind === P[i - 1].kind) alt = false;
    if (!alt) continue;
    // **충격파로 성립하는 창에만 적용한다.**
    // 이 기법은 애초에 "임펄스일 때 5파가 어디서 끝나는가"를 답하는 것이므로,
    // 아무 6개 피벗에나 갖다 대고 안 맞는다고 하면 기법을 부당하게 깎는 셈이다.
    if (!passesAbsoluteRules(P)) continue;
    const ch = METHODS.elliottChannels({ type: 'impulse', pivots: P });
    if (!ch || !ch.wave5 || !ch.wave5.actual) continue;
    results.push({
      at: P[5].t,
      nearest: ch.wave5.actual.nearest,
      devPct: ch.wave5.actual.devPct,
      hit: ch.wave5.actual.hit,
    });
  }
  // 기저율 — 세 목표(상단 1.0 · 중앙 0.5 · 절단 0.25)에 각각 ±15% 창을 두면
  // 채널 폭의 상당 부분이 이미 "적중"으로 덮인다. 그 덮인 비율이 기저율이다.
  //   [0.85,1.15] ∪ [0.35,0.65] ∪ [0.10,0.40] → 채널 안에서 약 0.70
  // 즉 적중률이 70%를 넘지 못하면 이 좌표는 정보를 더하지 못한 것이다.
  return withEdge('[T3] 엘리엇 앵커 채널 (5파 좌표)', results, 0.70);
}

// ---------------------------------------------------------------------------
// 백테스트 ③ 닐리 국면 판정
//
// 규칙:  방향성 국면은 "중심 추세 방향 모노파동이 100% 되돌려질 때" 끝나고,
//        비방향성 국면은 "구간 범위의 161.8%를 벗어날 때" 끝난다.
//
// 검증을 무엇으로 할 것인가가 이 백테스트의 전부다.
// 처음에는 "다음 되돌림이 61.8% 이상인가"로 쟀는데 그건 자기상관이었다 —
// 국면 분류식이 바로 그 61.8%를 보고 판정하기 때문이다. 84%가 나왔지만
// 예측력이 아니라 같은 질문을 두 번 한 것이었다.
//
// 그래서 **국면 판정이 실제로 주장하는 것**으로 바꿨다:
//   방향성   → 추세가 살아 있다 = 다음 같은 방향 구간이 신고점/신저점을 만든다
//   비방향성 → 가치가 정체돼 있다 = 신고점/신저점을 만들지 못한다
// 분류는 되돌림 깊이를 보고, 검증은 극점 갱신 여부를 본다. 서로 다른 양이다.
// ---------------------------------------------------------------------------
function backtestNeelyPhase(pivots, classifyPhase) {
  const results = [];
  if (!Array.isArray(pivots) || pivots.length < 8 || typeof classifyPhase !== 'function') {
    return { name: '[닐리] 국면 판정', n: 0, hits: 0, rate: null, results };
  }
  for (let end = 6; end < pivots.length; end++) {
    const hist = pivots.slice(0, end);
    let ph;
    try {
      ph = classifyPhase(hist);
    } catch (_) {
      continue;
    }
    if (!ph || (ph.phase !== '방향성' && ph.phase !== '비방향성')) continue;
    const b = pivots[end - 1];
    const next = pivots[end];
    // 직전 같은 종류(고점/저점)의 극점과 비교해 갱신 여부를 본다
    let prevSame = null;
    for (let j = end - 2; j >= 0; j--) {
      if (pivots[j].kind === next.kind) { prevSame = pivots[j]; break; }
    }
    if (!prevSame) continue;
    const madeExtreme =
      next.kind === 'H' ? next.price > prevSame.price : next.price < prevSame.price;
    const predicted = ph.phase === '방향성'; // 방향성이면 극점 갱신을 예측
    results.push({
      at: b.t,
      phase: ph.phase,
      predicted: predicted ? '극점 갱신' : '갱신 실패(정체)',
      actual: madeExtreme ? '극점 갱신' : '갱신 실패(정체)',
      hit: madeExtreme === predicted,
    });
  }
  // 기저율 — 극점 갱신이 원래 얼마나 흔한가 (전 구간 무조건 예측했을 때)
  let baseExt = 0;
  let baseTot = 0;
  for (let k = 2; k < pivots.length; k++) {
    let prevSame = null;
    for (let j = k - 1; j >= 0; j--) {
      if (pivots[j].kind === pivots[k].kind) { prevSame = pivots[j]; break; }
    }
    if (!prevSame) continue;
    baseTot++;
    const made = pivots[k].kind === 'H' ? pivots[k].price > prevSame.price : pivots[k].price < prevSame.price;
    if (made) baseExt++;
  }
  const pExt = baseTot ? baseExt / baseTot : null;
  const predExt = results.filter((r) => r.predicted === '극점 갱신').length / (results.length || 1);
  const base = pExt == null ? null : predExt * pExt + (1 - predExt) * (1 - pExt);
  return withEdge('[닐리] 국면 판정', results, base);
}

// ---------------------------------------------------------------------------
// 쟁점 하나에 대해 두 출처를 나란히 놓는다
// ---------------------------------------------------------------------------
function compare(question, sides) {
  const usable = sides.filter(
    (s) => s.score && s.score.n >= MIN_SAMPLE && s.score.edge != null
  );
  let lead = null;
  let note;
  if (usable.length >= 2) {
    // 적중률이 아니라 기저율 대비 초과분(edge)으로 비교한다
    const sorted = [...usable].sort((a, b) => b.score.edge - a.score.edge);
    const gap = sorted[0].score.edge - sorted[1].score.edge;
    const fmt = (x) => `${pct(x.score.rate)}(기저 ${pct(x.score.baseRate)}, 초과 ${pct(x.score.edge)})`;
    if (sorted[0].score.edge <= 0.02) {
      note =
        `둘 다 기저율을 넘지 못했다 — ${sorted.map((x) => `${x.source} ${fmt(x)}`).join(' / ')}. ` +
        '이 차트에서는 두 기법 모두 추가 정보를 주지 못했으니 다른 근거를 봐라';
    } else if (gap >= CLEAR_MARGIN) {
      lead = sorted[0];
      note =
        `이 차트에서는 ${sorted[0].source} 가 우세하다 — ${fmt(sorted[0])} vs ${fmt(sorted[1])} ` +
        `(표본 ${sorted[0].score.n}·${sorted[1].score.n}건). ` +
        '표본이 작으므로 "옳다"가 아니라 "이 구간에서 더 맞았다"로만 읽어라';
    } else {
      note =
        `기저율 대비 초과분 차이가 ${pct(gap)} 로 작다 — 어느 쪽이 낫다고 말할 수 없다. ` +
        '둘 다 근거로 놓고 겹치는 곳을 봐라';
    }
  } else {
    const ns = sides.map((s) => `${s.source} ${s.score ? s.score.n : 0}건`).join(' · ');
    note = `표본 부족 (${ns}, 최소 ${MIN_SAMPLE}건 필요) — 적중률로 우열을 가리지 않는다`;
  }
  return { question, sides, lead: lead ? lead.source : null, note };
}

// ---------------------------------------------------------------------------
// 진입점 — 분석 결과를 받아 쟁점별 비교표를 만든다
// ---------------------------------------------------------------------------
function arbitrate(candles, pivots, parts) {
  const { neo, wave, corrective, classifyPhase } = parts || {};

  const bounceScore = backtestBounce(pivots);
  const channelScore = backtestChannel(pivots);
  const phaseScore = backtestNeelyPhase(pivots, classifyPhase);

  const issues = [];

  // ── 쟁점 1 · 직전 조정이 끝났는가 ─────────────────────────────────────
  const bounce = METHODS.bounceJudgement(pivots);
  const neelyPhase = neo && neo.phase ? neo.phase : null;
  if (bounce) {
    const neelySays = neelyPhase
      ? neelyPhase.phase === '방향성'
        ? '추세가 살아 있는 국면 — 조정은 끝났거나 얕게 끝난다'
        : neelyPhase.phase === '비방향성'
        ? '가치 정체 국면 — 조정이 계속 이어진다'
        : '혼재 — 판정 유보'
      : '판정 없음';
    issues.push(
      compare('직전 조정이 끝났는가', [
        { source: '닐리 국면 판정', answer: neelySays, score: phaseScore },
        { source: '[T2] 역피보 반등', answer: `${bounce.retracePct.toFixed(1)}% → ${bounce.verdict} · ${bounce.meaning}`, score: bounceScore },
      ])
    );
  }

  // ── 쟁점 2 · 다음 파동이 어디서 끝나는가 ──────────────────────────────
  const best = wave && wave.candidates && wave.candidates[0];
  if (best && best.pivots && best.pivots.length >= 5) {
    const ch = METHODS.elliottChannels(best);
    const fibTargets = (best.targets || []).slice(0, 2).map((t) => t.label).join(' · ');
    const chTargets = ch && ch.wave5
      ? ch.wave5.targets.map((t) => `${t.label} ${t.price.toFixed(2)}`).join(' · ')
      : '산출 불가';
    issues.push(
      compare('다음 파동의 종료 좌표', [
        { source: '피보나치 투영 (고전)', answer: fibTargets || '목표 없음', score: { n: 0, rate: null } },
        { source: '[T3] 앵커 채널', answer: chTargets, score: channelScore },
      ])
    );
    if (ch) issues[issues.length - 1].channel = ch;
  }

  // ── 쟁점 3 · 복합조정 예고가 일치하는가 ───────────────────────────────
  // 닐리 쪽 복합조정 검출(corrective)과 [T2]의 38.2 힌트가 같은 말을 하는지 본다.
  const cxDetected = !!(corrective && (corrective.patterns || []).some((p) => p.type === 'complex'));
  if (bounce) {
    const agree = cxDetected === bounce.complexHint;
    issues.push({
      question: '복합조정(WXY)이 진행 중인가',
      sides: [
        { source: '닐리 복합조정 검출', answer: cxDetected ? '검출됨' : '검출 안 됨', score: null },
        { source: '[T2] 38.2 힌트', answer: bounce.complexHint ? '복합조정 의심' : '단순 조정' , score: bounceScore },
      ],
      lead: null,
      note: agree
        ? '두 방법이 같은 결론이다 — 복합조정 판단의 신뢰도가 올라간다'
        : '두 방법이 엇갈린다. 닐리는 구조(부분 패턴이 실제로 성립하는가)를, ' +
          '[T2]는 되돌림 깊이를 본다. 구조 쪽이 더 엄격하므로 진입 근거로는 닐리를 우선하되, ' +
          '[T2]가 경고하면 목표를 보수적으로 잡아라',
    });
  }

  return {
    scores: [phaseScore, bounceScore, channelScore],
    issues,
    minSample: MIN_SAMPLE,
  };
}

// ---------------------------------------------------------------------------
function describeArbitration(res) {
  const out = [];
  if (!res || !res.issues.length) return ['중재할 쟁점 없음'];

  out.push('이 차트에서의 기법별 적중 이력:');
  for (const s of res.scores) {
    out.push(
      `  ${s.name}: ${s.n}건 중 ${s.hits}건 적중 (${pct(s.rate)})` +
        (s.baseRate != null ? ` · 기저율 ${pct(s.baseRate)} → 초과 ${pct(s.edge)}` : '') +
        (s.n < res.minSample
          ? ' — 표본 부족, 우열 판단에 쓰지 않음'
          : s.edge != null && s.edge <= 0
          ? ' — 기저율을 못 넘었다. 이 차트에서 정보를 더하지 못했다'
          : '')
    );
  }
  out.push('');
  for (const iss of res.issues) {
    out.push(`쟁점: ${iss.question}`);
    for (const side of iss.sides) {
      out.push(`  · ${side.source}: ${side.answer}`);
    }
    out.push(`  → ${iss.note}`);
    if (iss.channel && iss.channel.base && iss.channel.base.actual) {
      out.push(`     (앵커 채널 4파 실측: ${iss.channel.base.actual.hit})`);
    }
    out.push('');
  }
  return out;
}

module.exports = { arbitrate, describeArbitration, backtestBounce, backtestChannel, backtestNeelyPhase, MIN_SAMPLE };
