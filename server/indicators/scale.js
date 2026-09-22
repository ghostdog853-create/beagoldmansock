'use strict';

// WAVE FLOOR — 척도(scale) 모듈 · 닐리 1장 「비례의 법칙」의 코드판
//
// 원문의 비례의 법칙은 차트의 가로세로 비율 이야기다. 세로를 짓눌러 그리면
// 급등이 완만해 보이고, 늘여 그리면 횡보가 급등처럼 보인다. 그 상태로 파동을
// 세면 모양 판단이 통째로 틀어진다는 것이 요지다.
//
// 우리는 숫자로 재므로 "보기 왜곡"은 없다. 그런데 같은 문제가 다른 얼굴로 남는다:
//
//   **산술 척도로 잰 되돌림 비율은 등락폭이 큰 구간에서 실제 체감과 어긋난다.**
//
//   100 → 200 → 135 를 되돌림으로 재면
//     산술: 상승 100, 하락 65    → 65.0%  → 법칙 4 (61.8~100)
//     로그: 상승 .693, 하락 .393 → 56.7%  → 법칙 2 (38.2~61.8)
//
//   같은 세 점인데 **법칙 번호가 갈린다.** 법칙이 갈리면 구조기호가 갈리고,
//   구조기호가 갈리면 그 위의 카운트가 전부 갈린다. 등락폭이 클수록 이 차이가 커진다.
//
// 그래서 이 모듈은 척도를 "고르는" 도구가 아니라 **두 척도가 갈리는 지점을
// 찾아내는** 도구다. 갈리지 않으면 조용하고, 갈리면 양쪽을 다 후보로 남긴다.
// 경계에서 하나만 고르지 않는다는 이 프로젝트의 원칙이 여기에도 그대로 적용된다.

// 로그 척도를 켤지 자동 판정하는 기준.
// 구간 최고/최저가 이 배수를 넘으면 산술 척도의 왜곡이 실질적이 된다.
// 2배(= +100%)를 넘어가면 같은 폭의 등락도 위·아래 비율이 눈에 띄게 달라진다.
const AUTO_LOG_RANGE = 2.0;

// 두 척도의 비율 차이가 이 %p 를 넘으면 "척도가 갈린다"고 본다.
const DIVERGENCE_PP = 5;

// ---------------------------------------------------------------------------
// 파동 길이 — 척도에 따라 재는 방식이 다르다
//   산술: |b - a|          (가격 차이)
//   로그: |ln(b / a)|      (비율 차이)
// 로그 길이는 단위가 없다. 비율(m2/m1)을 낼 때만 쓰고 가격으로 되돌리지 않는다.
// ---------------------------------------------------------------------------
function linLen(a, b) {
  return Math.abs(b - a);
}

function logLen(a, b) {
  if (!(a > 0) || !(b > 0)) return null; // 0 이하 가격에는 로그를 쓸 수 없다
  return Math.abs(Math.log(b / a));
}

function lenBy(useLog, a, b) {
  return useLog ? logLen(a, b) : linLen(a, b);
}

// ---------------------------------------------------------------------------
// 자동 판정 — 이 캔들 묶음에서 로그 척도가 의미를 갖는가
// ---------------------------------------------------------------------------
function autoUseLog(candles) {
  if (!Array.isArray(candles) || candles.length < 2) {
    return { useLog: false, range: null, why: '캔들 부족' };
  }
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles) {
    if (c.h > hi) hi = c.h;
    if (c.l < lo && c.l > 0) lo = c.l;
  }
  if (!(lo > 0) || !Number.isFinite(hi)) {
    return { useLog: false, range: null, why: '가격 범위 산출 불가' };
  }
  const range = hi / lo;
  const useLog = range >= AUTO_LOG_RANGE;
  return {
    useLog,
    range,
    why: useLog
      ? `구간 최고/최저가 ${range.toFixed(2)}배 — 산술 척도의 비율 왜곡이 실질적이라 로그 기준을 함께 잰다`
      : `구간 최고/최저가 ${range.toFixed(2)}배 — 두 척도의 차이가 미미해 산술 기준만으로 충분하다`,
  };
}

// ---------------------------------------------------------------------------
// 척도 객체 — 길이 재는 함수를 들고 다닌다
// ---------------------------------------------------------------------------
function makeScale(candles, opts = {}) {
  const auto = autoUseLog(candles);
  const useLog = opts.useLog != null ? !!opts.useLog : auto.useLog;
  return {
    useLog,
    auto,
    name: useLog ? '로그' : '산술',
    len: (a, b) => lenBy(useLog, a, b),
    linLen,
    logLen,
  };
}

// ---------------------------------------------------------------------------
// 비율을 두 척도로 각각 재고, 갈리는지 본다.
//   a → b → c 세 점에서 (b→c) / (a→b) 비율
// ---------------------------------------------------------------------------
function dualRatio(a, b, c) {
  const lin = linLen(a, b) > 0 ? (linLen(b, c) / linLen(a, b)) * 100 : null;
  const l1 = logLen(a, b);
  const l2 = logLen(b, c);
  const log = l1 != null && l2 != null && l1 > 0 ? (l2 / l1) * 100 : null;
  if (lin == null || log == null) return { lin, log, deltaPP: null, diverges: false };
  const deltaPP = Math.abs(lin - log);
  return { lin, log, deltaPP, diverges: deltaPP >= DIVERGENCE_PP };
}

// ---------------------------------------------------------------------------
// 두 비율이 같은 구간(밴드)에 떨어지는가.
// bands 는 [[이름, min, max], ...] 형태. 되돌림 법칙 경계든 조건 경계든 통한다.
// 구간이 갈리면 그것이 곧 "척도가 결론을 바꾼다"는 뜻이다.
// ---------------------------------------------------------------------------
function bandOf(bands, pct) {
  if (pct == null) return null;
  for (const [name, min, max] of bands) {
    if (pct >= min && pct < max) return name;
  }
  const last = bands[bands.length - 1];
  return pct >= last[2] ? last[0] : null;
}

function bandSplit(bands, dual) {
  if (!dual || dual.lin == null || dual.log == null) {
    return { split: false, linBand: null, logBand: null };
  }
  const linBand = bandOf(bands, dual.lin);
  const logBand = bandOf(bands, dual.log);
  return { split: linBand !== logBand, linBand, logBand };
}

module.exports = {
  AUTO_LOG_RANGE,
  DIVERGENCE_PP,
  linLen,
  logLen,
  lenBy,
  autoUseLog,
  makeScale,
  dualRatio,
  bandOf,
  bandSplit,
};
