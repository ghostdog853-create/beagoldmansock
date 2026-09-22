'use strict';

// WAVE FLOOR — 하단 티커 테이프 (바이낸스 24시간 티커, 키 불필요)

const SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','BNBUSDT','DOGEUSDT','ADAUSDT','LINKUSDT'];

async function fetchTape() {
  try {
    const url = 'https://api.binance.com/api/v3/ticker/24hr?symbols=' +
      encodeURIComponent(JSON.stringify(SYMBOLS));
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const rows = await res.json();
    return rows.map((r) => ({
      sym: String(r.symbol).replace(/USDT$/, ''),
      price: Number(r.lastPrice),
      changePct: Number(r.priceChangePercent),
    }));
  } catch {
    return [];
  }
}

module.exports = { fetchTape };
