'use strict';

// WAVE FLOOR — 시간대별 분석 조립
//
// 한 시간대(예: 1일봉)의 캔들을 받아 피벗 → 이평/오실레이터/채널/패턴/파동을
// 전부 돌린 뒤, 에이전트 프롬프트에 그대로 꽂을 수 있는 문장 블록으로 만든다.
//
// 순서가 중요하다. 피벗이 먼저 나와야 채널·패턴·파동·다이버전스가 전부 돈다.

const { findPivots, describePivots, swingStructure } = require('./pivot');
const { computeMA } = require('./ma');
const { computeOscillators } = require('./oscillator');
const { computeChannel } = require('./channel');
const { computePatterns } = require('./pattern');
const { countWaves, describeWaves } = require('./elliott');
const { analyzeNeoWave, describeNeoWave } = require('./neowave');
const { computeHarmonics } = require('./harmonic');
const { computeDiagonal } = require('./diagonal');
const { computeCorrective } = require('./corrective');
const { computeVolume } = require('./volume');
const { computeConfluence } = require('./confluence');
const { computeConstruction } = require('./construction');
const { makeScale } = require('./scale');
const METHODS = require('./methods');
const { arbitrate, describeArbitration } = require('./arbitrate');
const { classifyPhase } = require('./neowave');

// 시간대별 ZigZag 임계값 — 짧은 봉일수록 노이즈가 많아 크게 잡아야 한다.
// (그냥 두면 15분봉에서 피벗이 수백 개 잡혀 파동 카운트가 무의미해진다)
const PIVOT_K = {
  '15m': 3.5,
  '30m': 3.2,
  '1h': 3.0,
  '4h': 2.8,
  '1d': 2.5,
  '1w': 2.2,
};

// 한 시간대에 대한 전체 분석
function analyzeInterval(interval, candles, symbol) {
  const pivots = findPivots(candles, { k: PIVOT_K[interval] || 3.0 });
  const price = candles[candles.length - 1].c;

  // 비례의 법칙(닐리 1장) — 등락폭이 큰 구간에서는 산술 척도의 비율이 왜곡된다.
  // 척도를 갈아끼우는 게 아니라, 두 척도가 다른 답을 내는 지점을 찾아내는 용도다.
  const scale = makeScale(candles);

  const structure = swingStructure(pivots);
  const ma = computeMA(candles);
  const osc = computeOscillators(candles, pivots);
  const ch = computeChannel(candles, pivots);
  const pat = computePatterns(candles, pivots);
  // 닐리가 먼저 돌아 각 모노파동의 구조기호를 판정하고(생성기),
  // 고전 엘리어트가 뒤에서 규칙 위반 카운트를 거른다(검증기). 순서가 중요하다.
  const neo = analyzeNeoWave(pivots, { scale });
  const wave = countWaves(pivots, price);
  const harmonic = computeHarmonics(candles, pivots);
  const diagonal = computeDiagonal(candles, pivots);
  const corrective = computeCorrective(candles, pivots);
  const volume = computeVolume(candles, pivots);

  // 실전 기법 레이어 — 텔레그램 강의 4종에서 좌표로 계산 가능한 것만.
  // 닐리가 답하지 않는 것(조정이 끝났는가 · 4·5파가 어디서 끝나는가)을 채운다.
  const bestWave = (wave && wave.candidates && wave.candidates[0]) || null;
  const methods = {
    bounce: METHODS.bounceJudgement(pivots),
    channels: bestWave ? METHODS.elliottChannels(bestWave) : null,
    ma99: METHODS.ma99Check(candles, bestWave || { pivots }, ma),
    ma99Overlap: METHODS.ma99Confluence(candles),
    volumeCycle: METHODS.volumeCycle(candles, pivots),
    td: METHODS.tdSequential(candles),
    // ── 총정리.pdf [S] ──
    honeypot: METHODS.honeypot(pivots),
    fibSeq: METHODS.fibSequenceLevels(price, symbol),
    ema: METHODS.emaOperation(candles, interval),
    zzVsImp: METHODS.zigzagVsImpulse(pivots),
    timeZone: METHODS.fibTimeZone(pivots, candles),
    corrEnd: METHODS.correctionEnd(pivots, ch),
  };
  // 중재 — 닐리와 실전 기법이 다른 답을 낼 때 이 차트에서 누가 더 맞았는지 센다
  const arbitration = arbitrate(candles, pivots, { neo, wave, corrective, classifyPhase });

  // 근거 중첩은 맨 마지막 — 위 전부의 레벨을 모아야 하므로 순서가 고정이다
  const partial = { pivots, ma, osc, channel: ch, patterns: pat, neo, wave, harmonic, diagonal, corrective, methods };
  const confluence = computeConfluence(candles, partial);
  // 작도 — "이 결론이 어떻게 나왔는가"를 좌표로 뽑는다. 위 전부가 재료다.
  const construction = computeConstruction(candles, partial);

  return {
    interval,
    price,
    scale,
    methods,
    arbitration,
    barCount: candles.length,
    pivots,
    structure,
    ma,
    osc,
    channel: ch,
    patterns: pat,
    neo,
    wave,
    harmonic,
    diagonal,
    corrective,
    volume,
    confluence,
    construction,
    // 프롬프트용 문장 블록
    blocks: {
      structure: [`스윙 구조: ${structure.label} — ${structure.detail}`],
      pivots: describePivots(pivots, candles, 7),
      ma: ma.lines,
      osc: osc.lines,
      channel: ch.lines,
      patterns: pat.lines,
      neo: describeNeoWave(neo),
      wave: describeWaves(wave),
      diagonal: diagonal.lines,
      corrective: corrective.lines,
      harmonic: harmonic.lines,
      volume: volume.lines,
      confluence: confluence.lines,
      construction: construction.lines,
      methods: describeMethods(methods),
      arbitration: describeArbitration(arbitration),
    },
  };
}

// 실전 기법 블록 렌더 — 계산된 것만 낸다. 없으면 조용히 넘어간다.
function describeMethods(m) {
  const out = [];
  const money = (n) => (Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 }) : '-');

  if (m.bounce) {
    out.push(`${m.bounce.source}: 반등 ${m.bounce.retracePct.toFixed(1)}% → ${m.bounce.verdict}`);
    out.push(`   ${m.bounce.meaning}`);
    out.push(`   기대: ${m.bounce.expect}`);
    out.push(`   분기선: ${m.bounce.levels.map((l) => `${l.label} ${money(l.price)}`).join(' · ')}`);
  }
  if (m.channels && m.channels.base) {
    out.push(`${m.channels.source} — ${m.channels.base.name}`);
    if (m.channels.base.zones) {
      out.push(
        '   4파 예상 구간: ' +
          m.channels.base.zones.map((z) => `${z.label}${z.price != null ? ' ' + money(z.price) : ''}`).join(' / ')
      );
    }
    if (m.channels.base.actual) {
      out.push(`   실제 4파 ${money(m.channels.base.actual.price)} → ${m.channels.base.actual.hit}`);
    }
    if (m.channels.wave5) {
      out.push(`   ${m.channels.wave5.name}`);
      for (const t of m.channels.wave5.targets) {
        out.push(`      ${t.label}: ${money(t.price)}${t.kind === 'truncated' ? ' (3파가 과도하게 길 때)' : ''}`);
      }
      if (m.channels.wave5.actual) {
        const a = m.channels.wave5.actual;
        out.push(`      실제 5파 ${money(a.price)} → 근접 "${a.nearest}" · 편차 ${a.devPct.toFixed(1)}% ${a.hit ? '부합 ✔' : '어긋남'}`);
      }
    }
    for (const n of m.channels.notes) out.push(`   ⚠ ${n}`);
  }
  if (m.ma99) {
    out.push(`${m.ma99.source}: MA99 ${money(m.ma99.ma99)} · ${m.ma99.verdict}`);
    for (const c of m.ma99.checks) {
      out.push(`   ${c.label}파: ${c.expect} → 실제 이격 ${c.gapPct.toFixed(1)}% ${c.ok === null ? '' : c.ok ? '✔' : '✘'}`);
    }
  }
  if (m.ma99Overlap) {
    out.push(`${m.ma99Overlap.source}: ${m.ma99Overlap.note}`);
  }
  if (m.volumeCycle) {
    out.push(`${m.volumeCycle.source}:`);
    for (const e of m.volumeCycle.events) {
      out.push(`   ${e.dir} — 거래량비 ${e.volRatio != null ? e.volRatio.toFixed(2) + '배' : '-'} · ${e.verdict}`);
    }
    if (m.volumeCycle.signal) out.push(`   ★ ${m.volumeCycle.signal}`);
  }
  if (m.td) out.push(`${m.td.source}: ${m.td.note}`);

  // ── 총정리.pdf [S] ──
  if (m.honeypot) out.push(`${m.honeypot.source}: ${m.honeypot.note} → ${money(m.honeypot.price)}`);
  if (m.fibSeq) {
    out.push(`${m.fibSeq.source}: ${m.fibSeq.note}`);
    out.push('   ' + m.fibSeq.levels.map((l) => `${(l.r * 100).toFixed(1)}%${l.strong ? '★' : ''} ${money(l.price)}`).join(' · '));
  }
  if (m.ema) {
    out.push(`${m.ema.source}: ${m.ema.note}`);
    if (m.ema.setup) out.push(`   ★ 셋업 성립 — 무효화 ${money(m.ema.invalidation)} (EMA60 이탈)` + (m.ema.daily ? '' : ' · 원문은 일봉 기준을 권한다'));
  }
  if (m.zzVsImp) {
    out.push(`${m.zzVsImp.source}: ${m.zzVsImp.verdict} (${m.zzVsImp.score})`);
    for (const v of m.zzVsImp.votes) out.push(`   ${v.test}: ${v.value} → ${v.lean}`);
  }
  if (m.timeZone) out.push(`${m.timeZone.source}: ${m.timeZone.note}`);
  if (m.corrEnd) out.push(`${m.corrEnd.source}: ${m.corrEnd.note}`);

  return out.length ? out : ['실전 기법 산출 없음'];
}

// 한 시간축(단기/중기/장기)에 속한 여러 인터벌을 묶어 분석한다.
function analyzeHorizon(horizon, byInterval, symbol) {
  const per = {};
  for (const iv of horizon.intervals) {
    const candles = byInterval[iv];
    if (!candles) continue;
    per[iv] = analyzeInterval(iv, candles, symbol);
  }
  const primary = per[horizon.primary] || per[horizon.intervals[0]];
  return { id: horizon.id, label: horizon.label, desc: horizon.desc, primary: horizon.primary, per, main: primary };
}

// 시간축 하나를 프롬프트용 텍스트로 렌더링.
// 기준봉을 먼저 상세히, 보조봉은 요약만 — 프롬프트가 너무 길면 모델이 앞부분을 흘린다.
function renderHorizon(analysis) {
  const out = [];
  const main = analysis.main;
  out.push(`━━━ ${analysis.label} 시간축 (${analysis.desc}) · 기준봉 ${main.interval} ━━━`);
  out.push('');
  out.push(`[스윙 구조]`);
  out.push(...main.blocks.structure);
  out.push('');
  out.push(`[최근 스윙 포인트]`);
  out.push(...main.blocks.pivots);
  out.push('');
  out.push(`[이동평균]`);
  out.push(...main.blocks.ma);
  out.push('');
  out.push(`[오실레이터]`);
  out.push(...main.blocks.osc);
  out.push('');
  out.push(`[채널 · 추세선]`);
  out.push(...main.blocks.channel);
  out.push('');
  out.push(`[차트 패턴]`);
  out.push(...main.blocks.patterns);
  out.push('');
  out.push(`[닐리 NEoWave — 모노파동 구조 판정]`);
  if (main.scale) out.push(`척도: ${main.scale.name} 기준 · ${main.scale.auto.why}`);
  out.push(...main.blocks.neo);
  out.push('');
  out.push(`[고전 엘리어트 파동 후보 (규칙 검증 통과분)]`);
  out.push(...main.blocks.wave);
  out.push('');
  out.push(`[다이아고날 3대 조건 스크리너]`);
  out.push(...main.blocks.diagonal);
  out.push('');
  out.push(`[조정 패턴 — 지그재그 · 플랫 · 삼각형 · 복합조정(WXY)]`);
  out.push(...main.blocks.corrective);
  out.push('');
  out.push(`[하모닉 XABCD]`);
  out.push(...main.blocks.harmonic);
  out.push('');
  out.push(`[거래량 확인]`);
  out.push(...main.blocks.volume);
  out.push('');
  out.push(`[★ 근거 중첩 — 실행 타점 후보]`);
  out.push(...main.blocks.confluence);
  out.push('');
  out.push(`[★ 작도 — 시나리오 갈래와 계산 과정]`);
  out.push(...main.blocks.construction);
  out.push('');
  out.push(`[실전 기법 — 텔레그램 강의 (닐리가 답하지 않는 것)]`);
  out.push(...main.blocks.methods);
  out.push('');
  out.push(`[★ 중재 — 닐리 vs 실전 기법, 이 차트에서 누가 맞았나]`);
  out.push(...main.blocks.arbitration);

  // 보조봉 — 기준봉과 다른 인터벌이 있으면 핵심만
  for (const iv of Object.keys(analysis.per)) {
    if (iv === main.interval) continue;
    const sub = analysis.per[iv];
    out.push('');
    out.push(`[보조봉 ${iv} 요약]`);
    out.push(`스윙 구조: ${sub.structure.label} · 이평 배열: ${sub.ma.alignment}`);
    out.push(sub.osc.lines[0]);
    if (sub.osc.divergences.length) out.push(sub.osc.lines[sub.osc.lines.length - 1]);
    const topWave = sub.wave.candidates && sub.wave.candidates[0];
    if (topWave) {
      out.push(
        `파동 유력 후보: ${topWave.dirLabel} · ${topWave.stageName}` +
          (topWave.inProgress ? ` · ${typeof topWave.inProgress === 'number' ? topWave.inProgress + '파' : topWave.inProgress} 진행 중` : '') +
          ` (정합도 ${topWave.score}점)`
      );
    }
  }
  return out.join('\n');
}

// 세 시간축의 방향을 한눈에 비교하는 표 — 정렬 판정관의 핵심 재료
function alignmentSummary(horizons) {
  const rows = [];
  for (const h of horizons) {
    const m = h.main;
    const topWave = m.wave.candidates && m.wave.candidates[0];
    rows.push({
      id: h.id,
      label: h.label,
      interval: m.interval,
      structure: m.structure.label,
      maAlign: m.ma.alignment,
      rsi: m.osc.rsi,
      rsiZone: m.osc.rsiZone,
      channelPos: m.channel.regression ? m.channel.regression.posInChannel : null,
      slope: m.channel.regression ? m.channel.regression.slopeLabel : '-',
      wave: topWave
        ? `${topWave.dirLabel} ${topWave.stageName}${topWave.inProgress ? ` (${typeof topWave.inProgress === 'number' ? topWave.inProgress + '파' : topWave.inProgress} 진행)` : ''}`
        : '카운트 없음',
      waveScore: topWave ? topWave.score : null,
      phase: m.neo && m.neo.phase ? m.neo.phase.phase : '-',
      harmonic: m.harmonic && m.harmonic.patterns.length
        ? `${m.harmonic.patterns[0].name} ${m.harmonic.patterns[0].bullish ? '강세' : '약세'}(${m.harmonic.patterns[0].score})`
        : '없음',
      diagonal: m.diagonal && m.diagonal.screens.length
        ? `${m.diagonal.screens[0].passed}/3 조건`
        : '해당 없음',
      topCluster: m.confluence && m.confluence.clusters.length
        ? m.confluence.clusters[0]
        : null,
      divergence: m.osc.divergences.length ? m.osc.divergences[0].name : '없음',
      patterns: m.patterns.patterns.map((p) => p.name).join(', ') || '없음',
    });
  }
  return rows;
}

function renderAlignmentTable(rows) {
  const out = ['[시간축 정렬 요약]'];
  for (const r of rows) {
    out.push(
      `${r.label}(${r.interval}): 구조 ${r.structure} · 이평 ${r.maAlign} · ` +
        `RSI ${r.rsi != null ? r.rsi.toFixed(1) : '-'}(${r.rsiZone}) · ` +
        `채널위치 ${r.channelPos != null ? (r.channelPos * 100).toFixed(0) + '%' : '-'} · 기울기 ${r.slope}`
    );
    out.push(`   국면(닐리): ${r.phase} · 파동: ${r.wave}${r.waveScore != null ? ` [정합도 ${r.waveScore}]` : ''}`);
    out.push(`   다이버전스: ${r.divergence} · 패턴: ${r.patterns}`);
    out.push(`   하모닉: ${r.harmonic} · 다이아고날: ${r.diagonal}`);
    if (r.topCluster) {
      const c = r.topCluster;
      out.push(
        `   최상위 중첩: ${c.distinct}중첩 ${c.low.toLocaleString('en-US', { maximumFractionDigits: 2 })}` +
          `~${c.high.toLocaleString('en-US', { maximumFractionDigits: 2 })} (${c.side}, ` +
          `${c.distPct >= 0 ? '+' : ''}${c.distPct.toFixed(2)}%)`
      );
    }
  }
  return out.join('\n');
}

module.exports = {
  analyzeInterval,
  analyzeHorizon,
  renderHorizon,
  alignmentSummary,
  renderAlignmentTable,
  PIVOT_K,
};
