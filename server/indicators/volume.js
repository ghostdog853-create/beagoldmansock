'use strict';

// WAVE FLOOR — 거래량 확인
//
// 명세: docs/파동분석-통합본.md 2.3 / 4.1
//
// 거래량은 파동 카운트를 "확인"하는 용도다. 카운트를 만들지는 못하지만
// 틀린 카운트를 걸러낸다.
//   · 임펄스는 보통 3파에서 거래량이 가장 크다
//   · 5파 거래량이 3파만큼 높으면 확장 5파를 예상한다
//   · 수렴삼각형·엔딩 다이아고날은 진행하며 거래량이 줄어야 한다
//   · 확산형은 거래량이 늘어난다

function avgVolume(candles, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(candles.length - 1, to);
  if (b <= a) return null;
  let s = 0;
  let n = 0;
  for (let i = a; i <= b; i++) {
    if (Number.isFinite(candles[i].v)) { s += candles[i].v; n++; }
  }
  return n ? s / n : null;
}

// 피벗 구간별 평균 거래량 — 파동별 비교의 재료
function segmentVolumes(candles, pivots, maxSeg = 6) {
  const segs = [];
  const pv = pivots.slice(-(maxSeg + 1));
  for (let i = 1; i < pv.length; i++) {
    const v = avgVolume(candles, pv[i - 1].i, pv[i].i);
    segs.push({
      from: pv[i - 1],
      to: pv[i],
      avg: v,
      bars: pv[i].i - pv[i - 1].i,
      up: pv[i].price > pv[i - 1].price,
    });
  }
  return segs;
}

// 거래량이 단조 감소하는가 (수렴삼각형·엔딩 다이아고날의 조건)
function isDeclining(segs) {
  const vals = segs.map((s) => s.avg).filter((v) => Number.isFinite(v));
  if (vals.length < 3) return null;
  let down = 0;
  for (let i = 1; i < vals.length; i++) if (vals[i] < vals[i - 1]) down++;
  return { ratio: down / (vals.length - 1), declining: down / (vals.length - 1) >= 0.6 };
}

function computeVolume(candles, pivots) {
  const lines = [];
  if (!Array.isArray(pivots) || pivots.length < 3) {
    return { segments: [], lines: ['거래량: 피벗 부족'] };
  }
  const segs = segmentVolumes(candles, pivots);
  const trend = isDeclining(segs);

  // 가장 거래량이 큰 구간 찾기
  let maxIdx = -1;
  let maxVal = -Infinity;
  segs.forEach((s, i) => {
    if (Number.isFinite(s.avg) && s.avg > maxVal) { maxVal = s.avg; maxIdx = i; }
  });

  const fmt = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '-');

  lines.push('구간별 평균 거래량 (최근 스윙 순):');
  segs.forEach((s, i) => {
    const mark = i === maxIdx ? ' ★최대' : '';
    lines.push(
      `  ${s.up ? '상승' : '하락'} ${s.bars}봉 · 평균 ${fmt(s.avg)}${mark}`
    );
  });

  if (trend) {
    lines.push(
      trend.declining
        ? `거래량 추세: 감소 (${segs.length}구간 중 ${Math.round(trend.ratio * (segs.length - 1))}구간 하락) ` +
          '— 수렴삼각형·엔딩 다이아고날에 부합하는 모습'
        : '거래량 추세: 감소하지 않음 — 수렴형 종료 패턴 근거로는 약하다'
    );
  }

  // 마지막 구간이 최대면 확장 진행 신호
  if (maxIdx === segs.length - 1 && segs.length >= 3) {
    lines.push('※ 가장 최근 구간이 거래량 최대 — 확장 파동 진행 가능성');
  }

  return { segments: segs, declining: trend, maxIndex: maxIdx, lines };
}

module.exports = { computeVolume, segmentVolumes, isDeclining };
