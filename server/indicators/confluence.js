'use strict';

// WAVE FLOOR — 근거 중첩 (confluence)
//
// 명세: docs/파동분석-통합본.md 7장
//
// 자료 전체가 반복해서 강조하는 실전 원칙:
//   "서로 다른 방법이 같은 가격대를 가리킬 때만 그 자리를 신뢰한다. 3중첩이면 신뢰 타점이다."
//
// 그래서 이 모듈은 모든 레이어가 낸 가격 레벨을 한 배열에 모아 ATR 기준으로
// 뭉치는 클러스터를 찾는다. 클러스터에 속한 **서로 다른 출처**의 수가 곧 점수다.
// 같은 출처에서 나온 레벨 3개가 겹치는 건 중첩이 아니다 — 그건 한 근거다.

const { atrSeries } = require('./pivot');

const CLUSTER_ATR = 0.5;          // 인접 레벨이 이 거리 안이면 이어붙인다
const CLUSTER_MAX_WIDTH_ATR = 1.0; // 클러스터 전체 폭 상한 — 넘으면 한 자리가 아니다

// 출처별 가중치. 무효화 레벨과 하모닉 PRZ가 무거운 이유는
// 둘 다 "틀리면 계획이 죽는" 지점이라 실행에 직결되기 때문이다.
const SOURCE_WEIGHT = {
  // 닐리가 이 체계의 베이스다 — 국면 종료 레벨과 패턴 경계가 가장 무겁다.
  // 국면이 바뀌면 그 아래 모든 판단이 갈아엎히기 때문이다.
  neowave_phase: 1.8,
  neowave_pattern: 1.4,
  wave_invalidation: 1.5,
  harmonic_prz: 1.4,
  wave_target: 1.2,
  pattern_target: 1.0,
  pattern_confirm: 1.0,
  channel: 1.0,
  trendline: 1.1,
  ma: 0.8,
  bollinger: 0.7,
  pivot: 1.1,
  fib: 1.0,
};

const SOURCE_LABEL = {
  neowave_phase: '닐리 국면종료',
  neowave_pattern: '닐리 패턴경계',
  wave_invalidation: '파동 무효화',
  harmonic_prz: '하모닉 PRZ',
  wave_target: '파동 목표',
  pattern_target: '차트패턴 목표',
  pattern_confirm: '차트패턴 성립선',
  channel: '회귀채널',
  trendline: '추세선',
  ma: '이동평균',
  bollinger: '볼린저',
  pivot: '스윙 지지/저항',
  fib: '피보나치',
};

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

// 한 시간축 분석 결과에서 가격 레벨을 전부 긁어모은다
function collectLevels(analysis) {
  const out = [];
  const push = (price, source, label) => {
    if (!Number.isFinite(price) || price <= 0) return;
    out.push({ price, source, label });
  };

  // 닐리 NEoWave — 이 체계의 베이스. 가장 먼저, 가장 무겁게 넣는다.
  const neo = analysis.neo;
  if (neo) {
    for (const l of neo.phaseLevels || []) {
      push(l.price, 'neowave_phase', l.label);
    }
    for (const m of (neo.patternMarks || []).slice(-3)) {
      push(m.price, 'neowave_pattern', '패턴 종료 후보(:L5/:L3)');
    }
  }

  // 파동 — 무효화와 투영 목표
  const wave = analysis.wave;
  if (wave && Array.isArray(wave.candidates)) {
    wave.candidates.slice(0, 2).forEach((c, ci) => {
      const tag = String.fromCharCode(65 + ci);
      if (c.invalidation != null) {
        push(c.invalidation, 'wave_invalidation', `파동후보${tag} 무효화`);
      }
      (c.targets || []).forEach((t) => push(t.price, 'wave_target', `파동후보${tag} ${t.label}`));
    });
  }

  // 하모닉 — PRZ 상·하단과 손절
  const harm = analysis.harmonic;
  if (harm && Array.isArray(harm.patterns)) {
    for (const p of harm.patterns) {
      push(p.prz.low, 'harmonic_prz', `${p.name} PRZ 하단`);
      push(p.prz.high, 'harmonic_prz', `${p.name} PRZ 상단`);
      push(p.stop, 'wave_invalidation', `${p.name} 손절`);
      (p.targets || []).forEach((t) => push(t.price, 'wave_target', `${p.name} ${t.label}`));
    }
  }

  // 차트 패턴
  const pat = analysis.patterns;
  if (pat && Array.isArray(pat.patterns)) {
    for (const p of pat.patterns) {
      push(p.confirm, 'pattern_confirm', `${p.name} 성립선`);
      push(p.target, 'pattern_target', `${p.name} 목표`);
      push(p.invalidation, 'wave_invalidation', `${p.name} 무효화`);
    }
  }

  // 채널 · 추세선 · 볼린저
  const ch = analysis.channel;
  if (ch) {
    if (ch.regression) {
      push(ch.regression.upper, 'channel', '회귀채널 상단');
      push(ch.regression.mid, 'channel', '회귀채널 중심');
      push(ch.regression.lower, 'channel', '회귀채널 하단');
    }
    if (ch.trendlines) {
      push(ch.trendlines.resistance, 'trendline', '저항 추세선');
      push(ch.trendlines.support, 'trendline', '지지 추세선');
    }
    if (ch.bollinger) {
      push(ch.bollinger.upper, 'bollinger', '볼린저 상단');
      push(ch.bollinger.lower, 'bollinger', '볼린저 하단');
    }
  }

  // 이동평균
  const ma = analysis.ma;
  if (ma && ma.values) {
    for (const p of Object.keys(ma.values)) {
      if (ma.values[p] != null) push(ma.values[p], 'ma', `SMA${p}`);
    }
  }

  // 최근 스윙 고저 — 가장 원초적인 지지/저항
  if (Array.isArray(analysis.pivots)) {
    for (const pv of analysis.pivots.slice(-6)) {
      push(pv.price, 'pivot', `스윙 ${pv.kind === 'H' ? '고점' : '저점'}`);
    }
  }

  return out;
}

// 레벨들을 ATR 기준으로 클러스터링
function cluster(levels, atrValue, price) {
  if (!levels.length || !(atrValue > 0)) return [];
  const tol = atrValue * CLUSTER_ATR;
  const sorted = [...levels].sort((a, b) => a.price - b.price);

  // 인접 거리만 보고 이어붙이면(단일 연결) 레벨이 촘촘한 구간에서 클러스터가
  // 끝없이 자란다 — 실제로 ATR 0.5배씩 연쇄되며 1.7% 폭짜리 "9중첩"이 나왔다.
  // 그건 한 자리가 아니라 그냥 넓은 구간이다. 그래서 전체 폭에도 상한을 건다.
  const maxWidth = atrValue * CLUSTER_MAX_WIDTH_ATR;
  const groups = [];
  let cur = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const gapOk = sorted[i].price - cur[cur.length - 1].price <= tol;
    const widthOk = sorted[i].price - cur[0].price <= maxWidth;
    if (gapOk && widthOk) {
      cur.push(sorted[i]);
    } else {
      groups.push(cur);
      cur = [sorted[i]];
    }
  }
  groups.push(cur);

  return groups
    .map((g) => {
      // 같은 출처끼리는 하나로 친다 — 한 근거가 여러 레벨을 낸다고 중첩이 아니다
      const bySource = new Map();
      for (const l of g) {
        if (!bySource.has(l.source)) bySource.set(l.source, []);
        bySource.get(l.source).push(l);
      }
      const distinct = bySource.size;
      const weight = [...bySource.keys()].reduce((s, k) => s + (SOURCE_WEIGHT[k] || 1), 0);
      const lo = Math.min(...g.map((l) => l.price));
      const hi = Math.max(...g.map((l) => l.price));
      const mid = g.reduce((s, l) => s + l.price, 0) / g.length;
      return {
        low: lo,
        high: hi,
        mid,
        distinct,
        weight: Math.round(weight * 10) / 10,
        members: g,
        sources: [...bySource.keys()],
        side: mid >= price ? '저항' : '지지',
        distPct: ((mid - price) / price) * 100,
      };
    })
    .filter((c) => c.distinct >= 2) // 2중첩 미만은 중첩이 아니다
    .sort((a, b) => b.weight - a.weight);
}

function computeConfluence(candles, analysis, opts = {}) {
  const price = candles[candles.length - 1].c;
  const atr = atrSeries(candles);
  const atrValue = atr[atr.length - 1] || atr.filter((v) => v != null).pop() || price * 0.01;

  const levels = collectLevels(analysis);
  const clusters = cluster(levels, atrValue, price);

  // 현재가에서 ±15% 밖은 실행에 쓸모없다
  const near = clusters.filter((c) => Math.abs(c.distPct) <= 15).slice(0, opts.max || 6);

  const lines = [];
  if (!near.length) {
    lines.push('근거가 2중첩 이상으로 모이는 가격대 없음 — 레벨들이 흩어져 있다');
  } else {
    lines.push(`중첩 구간 (ATR ${money(atrValue)}의 ${CLUSTER_ATR}배 이내로 모인 레벨):`);
    for (const c of near) {
      const tier = c.distinct >= 3 ? '★신뢰' : '중첩';
      lines.push(
        `  [${tier} ${c.distinct}중첩 · 가중 ${c.weight}] ${money(c.low)}~${money(c.high)} ` +
          `· ${c.side} · 현재가 대비 ${c.distPct >= 0 ? '+' : ''}${c.distPct.toFixed(2)}%`
      );
      // 출처 단위로 묶어 보여준다. 같은 출처 멤버를 전부 나열하면
      // "이동평균 5개"가 근거 5개처럼 보여 실제보다 강해 보인다.
      const grouped = new Map();
      for (const m of c.members) {
        const k = SOURCE_LABEL[m.source] || m.source;
        if (!grouped.has(k)) grouped.set(k, []);
        grouped.get(k).push(m.label);
      }
      const parts = [...grouped.entries()].map(([k, labels]) =>
        labels.length > 1 ? `${k}×${labels.length}` : `${k}(${labels[0]})`
      );
      lines.push(`     근거: ${parts.join(' + ')}`);
    }
    lines.push('※ 3중첩 이상이 실행 타점 후보다. 2중첩은 참고용으로만 쓴다');
  }

  return { clusters: near, all: clusters, atr: atrValue, price, lines };
}

module.exports = { computeConfluence, collectLevels, cluster, SOURCE_WEIGHT, SOURCE_LABEL };
