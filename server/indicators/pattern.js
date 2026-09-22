'use strict';

// WAVE FLOOR — 차트 패턴 검출
//
// 패턴은 "그림"이 아니라 **피벗 수열의 비율 관계**다. 헤드앤숄더는
// "고점 3개 중 가운데가 가장 높고, 양옆 어깨의 높이가 서로 비슷하고,
// 두 저점(넥라인)이 대략 수평인 상태"로 정의된다. 전부 숫자로 판정 가능하다.
//
// 각 패턴은 반드시 세 가지를 함께 돌려준다:
//   confirm      — 패턴이 성립했다고 인정되는 돌파 레벨
//   invalidation — 이 가격이 깨지면 패턴이 죽는 레벨
//   target       — 성립 시 통상적인 목표 (패턴 높이를 돌파점에 더한 값)
// 이 셋이 없으면 패턴 이름은 아무 쓸모가 없다.

const TOL = 0.03; // "비슷하다"의 허용 오차 3%

function near(a, b, tol = TOL) {
  if (!a || !b) return false;
  return Math.abs(a - b) / ((a + b) / 2) <= tol;
}

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

// ---- 헤드앤숄더 / 역헤드앤숄더 ----
// 필요한 피벗: H L H L H  (정방향) 또는 L H L H L (역방향)
function headShoulders(pv, inverse) {
  if (pv.length < 5) return null;
  const w = pv.slice(-5);
  const want = inverse ? ['L', 'H', 'L', 'H', 'L'] : ['H', 'L', 'H', 'L', 'H'];
  if (!w.every((p, i) => p.kind === want[i])) return null;

  const [s1, n1, head, n2, s2] = w.map((p) => p.price);
  // 머리가 양 어깨보다 극단이어야 한다
  const headIsExtreme = inverse ? head < s1 && head < s2 : head > s1 && head > s2;
  if (!headIsExtreme) return null;
  // 두 어깨 높이가 서로 비슷해야 한다
  if (!near(s1, s2, 0.06)) return null;
  // 넥라인 두 점도 대략 수평
  if (!near(n1, n2, 0.06)) return null;

  const neckline = (n1 + n2) / 2;
  const height = Math.abs(head - neckline);
  const target = inverse ? neckline + height : neckline - height;

  return {
    name: inverse ? '역헤드앤숄더 (강세 반전)' : '헤드앤숄더 (약세 반전)',
    bias: inverse ? 'bullish' : 'bearish',
    confirm: neckline,
    confirmLabel: `넥라인 ${money(neckline)} ${inverse ? '상향' : '하향'} 돌파 시 성립`,
    invalidation: head,
    invalidLabel: `머리 ${money(head)} ${inverse ? '이탈' : '돌파'} 시 패턴 무효`,
    target,
    detail: `왼어깨 ${money(s1)} · 머리 ${money(head)} · 오른어깨 ${money(s2)} · 넥라인 ${money(neckline)}`,
    pivots: w,
  };
}

// ---- 이중천정 / 이중바닥 ----
function doubleTopBottom(pv, isBottom) {
  if (pv.length < 3) return null;
  const w = pv.slice(-3);
  const want = isBottom ? ['L', 'H', 'L'] : ['H', 'L', 'H'];
  if (!w.every((p, i) => p.kind === want[i])) return null;

  const [a, mid, b] = w.map((p) => p.price);
  if (!near(a, b, 0.035)) return null; // 두 봉우리(바닥)가 거의 같은 높이
  const height = Math.abs(a - mid);
  if (height / a < 0.03) return null; // 너무 얕으면 패턴이 아니다

  const target = isBottom ? mid + height : mid - height;
  return {
    name: isBottom ? '이중바닥 (강세 반전)' : '이중천정 (약세 반전)',
    bias: isBottom ? 'bullish' : 'bearish',
    confirm: mid,
    confirmLabel: `중간 ${isBottom ? '고점' : '저점'} ${money(mid)} ${isBottom ? '상향' : '하향'} 돌파 시 성립`,
    invalidation: isBottom ? Math.min(a, b) : Math.max(a, b),
    invalidLabel: `${isBottom ? '바닥' : '천정'} ${money(isBottom ? Math.min(a, b) : Math.max(a, b))} ${isBottom ? '이탈' : '돌파'} 시 무효`,
    target,
    detail: `1차 ${money(a)} · 중간 ${money(mid)} · 2차 ${money(b)} (높이 ${money(height)})`,
    pivots: w,
  };
}

// ---- 삼각수렴 / 쐐기 ----
// 고점은 낮아지고 저점은 높아지는 상태. 최소 고점 2 + 저점 2 필요.
function triangle(pv, price) {
  const highs = pv.filter((p) => p.kind === 'H').slice(-2);
  const lows = pv.filter((p) => p.kind === 'L').slice(-2);
  if (highs.length < 2 || lows.length < 2) return null;

  const hDrop = (highs[1].price - highs[0].price) / highs[0].price;
  const lRise = (lows[1].price - lows[0].price) / lows[0].price;

  let name = null;
  let bias = 'neutral';
  if (hDrop < -0.01 && lRise > 0.01) {
    name = '대칭 삼각수렴';
  } else if (Math.abs(hDrop) < 0.012 && lRise > 0.015) {
    name = '상승 삼각형';
    bias = 'bullish';
  } else if (hDrop < -0.015 && Math.abs(lRise) < 0.012) {
    name = '하락 삼각형';
    bias = 'bearish';
  } else {
    return null;
  }

  const upper = highs[1].price;
  const lower = lows[1].price;
  const height = upper - lower;
  return {
    name: `${name} (수렴 — 돌파 방향으로 추세)`,
    bias,
    confirm: upper,
    confirmLabel: `상단 ${money(upper)} 돌파 시 상방, 하단 ${money(lower)} 이탈 시 하방`,
    invalidation: lower,
    invalidLabel: `하단 ${money(lower)} 이탈 시 상방 시나리오 무효`,
    target: upper + height,
    detail: `상단 ${money(upper)} · 하단 ${money(lower)} · 폭 ${money(height)} · 현재가 ${money(price)}`,
    pivots: [...highs, ...lows].sort((a, b) => a.i - b.i),
  };
}

// ---- 깃발 / 페넌트 ----
// 급등(급락) 직후 얕고 짧은 되돌림. 추세 지속형 패턴.
function flag(pv, candles) {
  if (pv.length < 3) return null;
  const w = pv.slice(-3);
  const [p0, p1, p2] = w;
  const pole = Math.abs(p1.price - p0.price) / p0.price;
  const pull = Math.abs(p2.price - p1.price) / p1.price;
  const poleBars = p1.i - p0.i;
  const pullBars = p2.i - p1.i;
  if (poleBars < 3 || pullBars < 2) return null;
  // 깃대는 크고 급하게, 되돌림은 얕고 짧게
  if (pole < 0.08) return null;
  if (pull > pole * 0.5) return null;
  if (pullBars > poleBars * 1.5) return null;

  const up = p1.price > p0.price;
  const height = Math.abs(p1.price - p0.price);
  return {
    name: up ? '상승 깃발 (추세 지속)' : '하락 깃발 (추세 지속)',
    bias: up ? 'bullish' : 'bearish',
    confirm: p1.price,
    confirmLabel: `깃대 끝 ${money(p1.price)} ${up ? '상향' : '하향'} 돌파 시 지속`,
    invalidation: p0.price,
    invalidLabel: `깃대 시작 ${money(p0.price)} ${up ? '이탈' : '돌파'} 시 무효`,
    target: up ? p2.price + height : p2.price - height,
    detail: `깃대 ${(pole * 100).toFixed(1)}%/${poleBars}봉 · 되돌림 ${(pull * 100).toFixed(1)}%/${pullBars}봉`,
    pivots: w,
  };
}

function computePatterns(candles, pivots) {
  const price = candles[candles.length - 1].c;
  const pv = pivots || [];
  const found = [];

  for (const fn of [
    () => headShoulders(pv, false),
    () => headShoulders(pv, true),
    () => doubleTopBottom(pv, false),
    () => doubleTopBottom(pv, true),
    () => triangle(pv, price),
    () => flag(pv, candles),
  ]) {
    try {
      const r = fn();
      if (r) found.push(r);
    } catch {
      /* 개별 패턴 실패는 무시 — 나머지로 계속 */
    }
  }

  const lines = [];
  if (!found.length) {
    lines.push('검출된 차트 패턴 없음 — 정형화된 형태가 잡히지 않는다');
  } else {
    for (const p of found) {
      lines.push(`${p.name}`);
      lines.push(`   ${p.detail}`);
      lines.push(`   성립: ${p.confirmLabel}`);
      lines.push(`   목표: ${money(p.target)}`);
      lines.push(`   무효화: ${p.invalidLabel}`);
    }
  }

  return { patterns: found, lines };
}

module.exports = { computePatterns, headShoulders, doubleTopBottom, triangle, flag };
