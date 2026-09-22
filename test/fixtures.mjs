'use strict';

// 지그재그 스윙(상승-하락-상승-하락-상승)을 만드는 합성 캔들 — 피벗이 확실히 여러 개 찍히게 짠다.
export function zigzagCandles({ start = 100, swings = [20, -12, 25, -10, 15], barsPerSwing = 30, startT = 1700000000000, stepMs = 3600000 } = {}) {
  const candles = [];
  let price = start;
  let t = startT;
  for (const swing of swings) {
    const step = swing / barsPerSwing;
    for (let i = 0; i < barsPerSwing; i++) {
      const o = price;
      price += step;
      const c = price;
      const h = Math.max(o, c) + Math.abs(step) * 0.3;
      const l = Math.min(o, c) - Math.abs(step) * 0.3;
      candles.push({ t, o, h, l, c, v: 100 + Math.random() * 10 });
      t += stepMs;
    }
  }
  return candles;
}

export function flatCandles(n = 40, price = 100, startT = 1700000000000, stepMs = 3600000) {
  const candles = [];
  let t = startT;
  for (let i = 0; i < n; i++) {
    candles.push({ t, o: price, h: price + 0.1, l: price - 0.1, c: price, v: 100 });
    t += stepMs;
  }
  return candles;
}
