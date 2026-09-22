'use strict';

// WAVE FLOOR — 멀티 타임프레임 캔들 수집 (바이낸스, 키 불필요)
//
// 이 프로젝트의 분업 축은 "시간"이다. 단기·중기·장기 에이전트가 각자
// 자기 시간대의 캔들만 받아서 같은 기법(이평·RSI·채널·패턴·엘리어트)을 적용한다.
// 그래서 수집기가 하는 일은 하나뿐이다 — 시간대별로 충분히 긴 캔들을 가져오는 것.
//
// limit을 크게 잡는 이유: 엘리어트 파동 카운트는 피벗 6개(0~5파)가 필요하고,
// 피벗 하나가 잡히려면 캔들 수십 개가 든다. 200개로는 5파 구조가 안 나온다.

const TIMEOUT_MS = 12000;
const BASE = 'https://api.binance.com/api/v3';

// 시간축 3분할 — 각 축이 어떤 봉을 보는지가 이 프로젝트의 핵심 설계다.
//  단기: 수시간~하루 안에 끝나는 움직임
//  중기: 며칠~몇 주짜리 스윙
//  장기: 몇 달짜리 추세와 대순환
const HORIZONS = {
  short: {
    id: 'short',
    label: '단기',
    desc: '수시간 ~ 1일',
    intervals: ['15m', '30m', '1h'],
    primary: '1h', // 지표·파동의 기준봉
  },
  mid: {
    id: 'mid',
    label: '중기',
    desc: '수일 ~ 수주',
    intervals: ['4h', '1d'],
    primary: '1d',
  },
  long: {
    id: 'long',
    label: '장기',
    desc: '수개월 ~',
    intervals: ['1d', '1w'],
    primary: '1w',
  },
};

const HORIZON_IDS = ['short', 'mid', 'long'];

// 봉 하나가 몇 밀리초인지 — 피벗 임계값과 경과시간 표기에 쓴다
const INTERVAL_MS = {
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

// 시간대별로 필요한 캔들 수. 짧은 봉일수록 노이즈가 많아 더 많이 받는다.
const LIMITS = {
  '15m': 500,
  '30m': 500,
  '1h': 500,
  '4h': 500,
  '1d': 400,
  '1w': 300,
};

function timeoutSignal() {
  return AbortSignal.timeout(TIMEOUT_MS);
}

// 바이낸스 klines 배열 → {t,o,h,l,c,v}
function parseKlines(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((k) => ({
      t: Number(k[0]),
      o: Number(k[1]),
      h: Number(k[2]),
      l: Number(k[3]),
      c: Number(k[4]),
      v: Number(k[5]),
    }))
    .filter((c) => Number.isFinite(c.c) && Number.isFinite(c.h) && Number.isFinite(c.l));
}

async function fetchKlines(symbol, interval, limit) {
  const n = limit || LIMITS[interval] || 300;
  const url = `${BASE}/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${n}`;
  const res = await fetch(url, { signal: timeoutSignal() });
  if (!res.ok) throw new Error(`바이낸스 ${interval} 응답 ${res.status}`);
  const candles = parseKlines(await res.json());
  if (candles.length < 60) {
    throw new Error(`${interval} 캔들이 ${candles.length}개뿐 — 분석 불가`);
  }
  return candles;
}

async function fetchTicker(symbol) {
  try {
    const res = await fetch(`${BASE}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
      signal: timeoutSignal(),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return {
      price: Number(j.lastPrice),
      changePct24h: Number(j.priceChangePercent),
      high24h: Number(j.highPrice),
      low24h: Number(j.lowPrice),
      quoteVolume: Number(j.quoteVolume),
    };
  } catch {
    return null;
  }
}

// 심볼 해석 — 'btc' / 'BTC' / 'BTCUSDT' 전부 BTCUSDT 로
function resolveSymbol(input) {
  const raw = String(input || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) throw new Error('심볼이 비어 있습니다.');
  const symbol = raw.endsWith('USDT') ? raw : `${raw}USDT`;
  const display = symbol.replace(/USDT$/, '');
  return { symbol, display };
}

// 실제로 받아와야 하는 인터벌 집합 (중복 제거 — 1d는 중기·장기가 공유한다)
function requiredIntervals() {
  const set = new Set();
  for (const id of HORIZON_IDS) {
    for (const iv of HORIZONS[id].intervals) set.add(iv);
  }
  return [...set];
}

// 전 시간대를 병렬로 받아 { '15m': [...], '1h': [...] } 형태로 반환.
// 캔들 실패는 치명적이다 — 위에 얹는 지표·파동이 전부 여기서 나온다.
async function fetchAllTimeframes(symbol) {
  const ivs = requiredIntervals();
  const results = await Promise.allSettled(ivs.map((iv) => fetchKlines(symbol, iv)));
  const out = {};
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[ivs[i]] = r.value;
    else failed.push(`${ivs[i]}(${r.reason && r.reason.message})`);
  });
  if (failed.length) {
    throw new Error(`캔들 수집 실패: ${failed.join(', ')}`);
  }
  return out;
}

module.exports = {
  HORIZONS,
  HORIZON_IDS,
  INTERVAL_MS,
  resolveSymbol,
  fetchKlines,
  fetchAllTimeframes,
  fetchTicker,
};
