'use strict';

// WAVE FLOOR — 실전 기법 레이어 (텔레그램 강의 자료)
//
// 이 프로젝트의 기반은 닐리다. 그런데 **닐리가 100%는 아니다.**
// 닐리는 구조를 판정하는 데는 압도적이지만, 다음 것들을 말해주지 않는다:
//
//   · 지금 이 반등이 조정의 끝인가, 더 큰 조정의 첫 조각인가
//   · 4파가 어디서 끝날 것인가 (가격 좌표로)
//   · 5파의 종료 지점은 어디인가
//   · 거래량이 이 카운트를 지지하는가
//
// 이 모듈은 `docs/source/` 의 텔레그램 강의 4종에서 **좌표로 계산 가능한 것만**
// 뽑아 구현한 것이다. 출처가 닐리 원서가 아니므로 이름을 분리했고,
// 닐리와 충돌하는 대목은 `arbitrate.js` 가 양쪽을 나란히 놓고 비교한다.
//
// 수록 출처:
//   [T1] ChatExport …(원본)   — MA99 임펄스 매매법 · 베이스/확장 채널 · 보조지표
//   [T2] ChatExport …(1)      — 역피보 38.2/61.8 반등 판정 · 복합조정 예고
//   [T3] ChatExport …(3)      — 엘리엇 앵커 채널 (0-1-2 / 2-3-4) · 5파 절단 좌표
//   [T4] ChatExport …(2)      — 헤숄 품질 검정 · 대칭이론 TP
//   [T5] ChatExport …(4)      — 거래량 사이클 · 가짜 돌파 판정
//   [S]  총정리.pdf (49p)     — 피보 확장 꿀통 · 피보나치 수열 매물대 · EMA 대작전 ·
//                              지그재그/임펄스 감별 · 피보 타임존 · 조정의 끝
//
// **VIP 방 실시간 대화(ChatExport …(5), 1.6MB)는 의도적으로 넣지 않았다.**
// 그쪽은 "어느 자리에 피보를 찍어 타점을 뽑는가"에 대한 사례 모음이라
// 규칙이 아니라 판단의 기록이다. 규칙으로 굳히기 전에 따로 분석해야 한다.

const MA = require('./ma');

function money(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 6 : 2 });
}

function pct(n, dp = 1) {
  return `${(n * 100).toFixed(dp)}%`;
}

// ===========================================================================
// [T2] 역피보 38.2 / 61.8 반등 판정
//
// 강의 원문의 논지:
//   "고점에서 첫 하락 구간을 A(또는 W)로 잡고 되돌림을 건다.
//    처음 반등이 -38.2% 자리에서 끝나면 그건 종결이 아니라 A(또는 W) 하나일 뿐이다.
//    즉 반등 후 추가 하락이 있다. 거기서부터 복합조정을 의심할 수 있다.
//    -61.8% 까지 되돌리면 그 조정은 종결된 것으로 본다."
//
// 부호(-38.2 / -61.8)는 강의자의 표기 관습이다. 재는 값 자체는
// **직전 추세 구간 대비 반등의 되돌림 비율**이므로 계산은 부호와 무관하다.
//
// 닐리와의 관계:
//   닐리 되돌림 법칙도 같은 값(m2/m1)을 재지만 결론이 다르다 —
//   닐리는 "m1이 충격파인가"를 묻고, 이쪽은 "조정이 끝났는가"를 묻는다.
//   질문이 다르므로 둘은 배타적이지 않다. arbitrate.js 가 둘을 나란히 낸다.
// ===========================================================================
const BOUNCE_TOL = 4.0; // %p — 강의가 "걸린다"고 말하는 폭

function bounceJudgement(pivots) {
  if (!Array.isArray(pivots) || pivots.length < 3) return null;

  // 마지막 3점: 추세구간(A) 시작 → A 끝 → 반등 끝
  const [s, e, b] = pivots.slice(-3);
  const legLen = Math.abs(e.price - s.price);
  if (!(legLen > 0)) return null;
  const bounce = Math.abs(b.price - e.price);
  const retracePct = (bounce / legLen) * 100;
  const down = e.price < s.price; // A가 하락이면 반등은 상승

  let verdict;
  let meaning;
  let expect;
  if (Math.abs(retracePct - 38.2) <= BOUNCE_TOL) {
    verdict = '38.2 걸림';
    meaning = '조정 종결이 아니다 — 이 구간 전체가 더 큰 조정의 A(또는 W) 하나일 뿐이다';
    expect = down
      ? '반등 후 추가 하락. 복합조정(WXY)을 의심하라'
      : '되밀림 후 추가 상승. 복합조정(WXY)을 의심하라';
  } else if (Math.abs(retracePct - 61.8) <= BOUNCE_TOL) {
    verdict = '61.8 걸림';
    meaning = '조정이 종결된 것으로 본다 — ABC가 여기서 완성됐을 가능성';
    expect = down ? '추세 재개(상승) 쪽에 무게' : '추세 재개(하락) 쪽에 무게';
  } else if (retracePct < 38.2 - BOUNCE_TOL) {
    verdict = '38.2 미달';
    meaning = '반등이 38.2%에도 못 미쳤다 — 추세가 매우 강하다';
    expect = '조정 종결 근거 없음. 추세 방향 지속 우세';
  } else if (retracePct > 61.8 + BOUNCE_TOL) {
    verdict = '61.8 초과';
    meaning = '61.8%를 넘겼다 — 단순 조정이 아니라 추세 자체가 바뀌었을 수 있다';
    expect = '직전 추세 구간을 A로 본 전제 자체를 다시 확인하라';
  } else {
    verdict = '중간대';
    meaning = '38.2%와 61.8% 사이 — 강의가 판정을 주지 않는 구간이다';
    expect = '이 기법만으로 결론내지 마라';
  }

  return {
    source: '[T2] 역피보 반등 판정',
    retracePct,
    verdict,
    meaning,
    expect,
    down,
    // 다음 반응을 볼 좌표
    levels: [
      { label: '38.2% (복합조정 분기)', price: e.price + (down ? 1 : -1) * legLen * 0.382 },
      { label: '61.8% (조정 종결선)', price: e.price + (down ? 1 : -1) * legLen * 0.618 },
    ],
    anchors: [s, e, b],
    // 마지막 C로 봐야 할 구간이 3파동으로 끊기면 복합조정의 시작이라고 강의는 말한다
    complexHint: verdict === '38.2 걸림',
  };
}

// ===========================================================================
// [T3] 엘리엇 앵커 채널 — 4파 위치 / 5파 종료 / 절단 좌표
//
// 우리 channel.js 는 선형회귀 채널이라 "가격이 통계적으로 어디쯤인가"만 답한다.
// 이 강의의 채널은 **파동 점에 직접 거는 채널**이라 목표가가 좌표로 나온다.
//
//   베이스 채널 (0-1-2) : 1파 저점(0) · 1파 고점(1) · 2파 종점(2)
//     → 4파는 하단 / 중앙 / (3파가 길면) 미접촉 중 하나
//   2-3-4 채널        : 2파 시작점 · 3파 · 4파
//     → 5파는 채널 상단 또는 채널 중앙에서 마감
//     → **3파가 과도하게 길어 5파가 절단되면 (중앙 + 하단) / 2 에서 종료**
// ===========================================================================

// 두 점을 잇는 직선을 x=at 에서 평가
function lineAt(p1, p2, x) {
  if (p2.i === p1.i) return p1.price;
  const slope = (p2.price - p1.price) / (p2.i - p1.i);
  return p1.price + slope * (x - p1.i);
}

// 세 점으로 평행채널을 만든다: p1→p2 가 기준선, p3 를 지나는 평행선이 반대편
function parallelChannel(p1, p2, p3) {
  const base = (x) => lineAt(p1, p2, x);
  const offset = p3.price - base(p3.i);
  return {
    at: (x) => {
      const b = base(x);
      const o = b + offset;
      return {
        base: b,
        opposite: o,
        upper: Math.max(b, o),
        lower: Math.min(b, o),
        mid: (b + o) / 2,
      };
    },
    offset,
    anchors: [p1, p2, p3],
  };
}

function elliottChannels(cand) {
  const P = cand && cand.pivots;
  if (!Array.isArray(P) || P.length < 4) return null;
  const up = P[1].price > P[0].price;

  const out = { source: '[T3] 엘리엇 앵커 채널', up, base: null, wave5: null, notes: [] };

  // ── 베이스 채널 0-1-2 → 4파 위치 예측 ──────────────────────────────────
  // 기준선 = 0→2 (같은 방향 두 저점/두 고점), 반대선 = 1 을 지나는 평행선
  const ch012 = parallelChannel(P[0], P[2], P[1]);
  const at4 = P[4] ? ch012.at(P[4].i) : null;
  out.base = {
    name: '베이스 채널 (0-1-2)',
    anchors: [P[0], P[1], P[2]],
    zones: at4
      ? [
          { label: '① 채널 하단', price: up ? at4.lower : at4.upper },
          { label: '② 채널 중앙', price: at4.mid },
          { label: '③ 미접촉 (3파가 길 때 · 빈도 낮음)', price: null },
        ]
      : null,
  };

  // 실제 4파가 어디에 떨어졌는가
  if (P[4] && at4) {
    const lo = Math.min(at4.base, at4.opposite);
    const hi = Math.max(at4.base, at4.opposite);
    const width = hi - lo;
    const rel = width > 0 ? (P[4].price - lo) / width : null;
    let hit = '③ 채널 미접촉';
    if (rel != null) {
      if (rel < 0 || rel > 1) hit = '③ 채널 밖 — 3파가 길어 4파가 채널에 닿지 않은 경우';
      else if (Math.abs(rel - 0.5) <= 0.18) hit = '② 채널 중앙';
      else if (up ? rel <= 0.32 : rel >= 0.68) hit = '① 채널 하단';
      else hit = '채널 안이지만 세 구간 어디에도 딱 맞지 않음';
    }
    out.base.actual = { price: P[4].price, rel, hit };
  }

  // ── 2-3-4 채널 → 5파 종료 좌표 ─────────────────────────────────────────
  // 기준선 = 2→4 (같은 방향), 반대선 = 3 을 지나는 평행선
  if (P[4]) {
    const ch234 = parallelChannel(P[2], P[4], P[3]);
    // 5파가 이미 찍혔으면 그 봉에서, 아니면 4파 이후 한 구간 뒤를 본다
    const x5 = P[5] ? P[5].i : P[4].i + (P[4].i - P[2].i);
    const a = ch234.at(x5);
    const upperEnd = up ? a.upper : a.lower;
    const lowerEnd = up ? a.lower : a.upper;
    out.wave5 = {
      name: '2-3-4 채널 (5파 종료 좌표)',
      anchors: [P[2], P[3], P[4]],
      targets: [
        { label: '5파 종료 · 채널 상단', price: upperEnd, kind: 'normal' },
        { label: '5파 종료 · 채널 중앙', price: a.mid, kind: 'normal' },
        // 3파가 과도하게 길어 5파가 절단되는 경우의 좌표
        { label: '5파 절단 종료 · (중앙+하단)/2', price: (a.mid + lowerEnd) / 2, kind: 'truncated' },
      ],
    };
    if (P[5]) {
      const cands = out.wave5.targets.filter((t) => Number.isFinite(t.price));
      let best = null;
      for (const t of cands) {
        const d = Math.abs(P[5].price - t.price);
        if (!best || d < best.d) best = { ...t, d };
      }
      const span = Math.abs(upperEnd - lowerEnd) || 1;
      out.wave5.actual = {
        price: P[5].price,
        nearest: best ? best.label : null,
        devPct: best ? (best.d / span) * 100 : null,
        hit: !!best && best.d / span <= 0.15,
      };
    }
    // 3파가 과도하게 긴가 — 절단 좌표를 쓸 근거
    const len1 = Math.abs(P[1].price - P[0].price);
    const len3 = Math.abs(P[3].price - P[2].price);
    if (len1 > 0 && len3 / len1 >= 2.618) {
      out.notes.push(
        `3파가 1파의 ${pct(len3 / len1)} — 과도하게 길다. 5파 절단 좌표를 우선 후보로 봐라`
      );
    }
  }
  return out;
}

// ===========================================================================
// [T1] 확장 채널 — 베이스 채널 하단이 뚫렸을 때
//
//   "베이스채널 하단이 뚫리는 게 보인다면 바로 확장채널(베이스채널 복붙)을 그려라.
//    찐반은 확장채널의 중앙부, 또는 확장채널의 3/4 부근에서 나온다.
//    3/4 부근이란 확장채널의 중앙과 하단부의 중앙값이다."
// ===========================================================================
function expansionChannel(baseChannelAt, x, up) {
  if (!baseChannelAt) return null;
  const a = baseChannelAt(x);
  const upper = up ? a.upper : a.lower;
  const lower = up ? a.lower : a.upper;
  const width = upper - lower; // 방향 포함
  // 베이스 채널을 하단 방향으로 그대로 복사한다
  const exUpper = lower;
  const exLower = lower - width;
  const exMid = (exUpper + exLower) / 2;
  return {
    source: '[T1] 확장 채널',
    upper: exUpper,
    lower: exLower,
    targets: [
      { label: '찐반 후보 ① 확장채널 중앙', price: exMid },
      { label: '찐반 후보 ② 3/4 지점 (중앙과 하단의 중앙)', price: (exMid + exLower) / 2 },
    ],
    note: '베이스채널 하단 이탈이 확인된 뒤에만 쓴다. 이탈 전에 미리 그리지 마라',
  };
}

// ===========================================================================
// [T1] MA99 임펄스 매매법 (비둘기매매법)
//
//   1파: MA99에 닿거나 닿지 못하고 튕김
//   2파: 1파 저점을 깨지 않음
//   3파: MA99 위를 세게 찢음
//   4파: MA99 위치까지 내림
//   5파: MA99에서 반등
//   A파: MA99를 하단으로 찢음
//   B파: MA99 위를 찢지만 5파 꼭지 밑 전고 정도까지
//
//   · 앞에 1-2파로 보이는 임펄스가 있으면 3파, 없으면 B파로 본다
//   · 여러 시간대의 MA99가 중첩된 지점을 뚫으면 의미 있는 임펄스가 나온다
//   · 이평선 기울기와 캔들 방향이 반대인 상태가 돌파 직전 모습이다
// ===========================================================================
function ma99Check(candles, cand, maResult) {
  const series = maResult && maResult.series && maResult.series[99];
  if (!series || !cand || !Array.isArray(cand.pivots)) return null;
  const P = cand.pivots;
  const at = (i) => (i >= 0 && i < series.length ? series[i] : null);

  const up = P.length > 1 && P[1].price > P[0].price;
  const labels = cand.type === 'impulse' ? ['0', '1', '2', '3', '4', '5'] : ['0', 'A', 'B', 'C'];
  const expect = {
    1: 'MA99에 닿거나 닿지 못하고 튕긴다',
    2: '1파 저점을 깨지 않는다',
    3: 'MA99 위를 세게 찢는다',
    4: 'MA99 위치까지 내린다',
    5: 'MA99에서 반등한다',
    A: 'MA99를 하단으로 찢는다',
    B: 'MA99 위를 찢되 5파 꼭지 밑 전고까지',
  };

  const checks = [];
  for (let k = 1; k < P.length; k++) {
    const lbl = labels[k];
    if (!expect[lbl]) continue;
    const m = at(P[k].i);
    if (m == null) continue;
    const gapPct = ((P[k].price - m) / m) * 100;
    const above = P[k].price > m;
    let ok = null;
    if (lbl === '3') ok = up ? above && gapPct > 1.5 : !above && gapPct < -1.5;
    else if (lbl === '4' || lbl === '5') ok = Math.abs(gapPct) <= 2.5; // MA99 근처
    else if (lbl === 'A') ok = up ? !above : above;
    else if (lbl === 'B') ok = up ? above : !above;
    checks.push({ label: lbl, expect: expect[lbl], ma99: m, price: P[k].price, gapPct, ok });
  }
  const graded = checks.filter((c) => c.ok !== null);
  const passed = graded.filter((c) => c.ok).length;
  return {
    source: '[T1] MA99 임펄스 매매법',
    ma99: at(candles.length - 1),
    checks,
    passed,
    graded: graded.length,
    verdict: graded.length
      ? `${graded.length}개 검사 중 ${passed}개 부합`
      : 'MA99 대조 가능한 파동 없음',
  };
}

// 여러 시간대 MA99 중첩 — "뚫으면 의미 있는 임펄스"
// 같은 캔들 배열에서 배수 기간(99 · 99×4 …)으로 근사한다.
function ma99Confluence(candles, atrHint) {
  const closes = candles.map((c) => c.c);
  const vals = [];
  for (const [name, p] of [['현재봉 MA99', 99], ['4배 상위봉 MA99≈', 396]]) {
    const v = MA.sma(closes, p);
    if (v != null) vals.push({ name, period: p, value: v });
  }
  if (vals.length < 2) return null;
  const spread = Math.abs(vals[0].value - vals[1].value);
  const tol = atrHint || Math.abs(vals[0].value) * 0.01;
  return {
    source: '[T1] MA99 다중 시간대 중첩',
    values: vals,
    spread,
    overlapped: spread <= tol,
    note: spread <= tol
      ? '두 시간대의 MA99가 겹쳐 있다 — 이 구간을 뚫으면 의미 있는 임펄스가 나온다고 본다'
      : '중첩 아님 — MA99 돌파의 의미가 상대적으로 약하다',
  };
}

// ===========================================================================
// [T5] 거래량 사이클 — "거래량은 가격을 움직이는 힘이고 방향을 선행한다"
//
//   핵심 패턴: 추세 + 거래량 증가 → 거래량 감소 + 횡보 → 고저점 전환 → 거래량 증가 + 큰 추세
//
//   판정 규칙
//     · 신고점(신저점) 갱신인데 거래량이 줄었다 → **가짜 돌파 / 리스크 관리 구간**
//     · 갱신 + 거래량 증가 → 추세 지속
//     · 거래량 줄어든 가짜 갱신이 2회 연속 → 반대 포지션 진입 근거
//     · 추세 지속인데 거래량 감소 → 그 추세의 힘이 빠지는 중 (다이버전스와 같은 원리)
// ===========================================================================
function volumeCycle(candles, pivots) {
  if (!Array.isArray(candles) || candles.length < 30) return null;
  if (!Array.isArray(pivots) || pivots.length < 4) return null;

  // 피벗 구간별 평균 거래량
  const segVol = [];
  for (let k = 1; k < pivots.length; k++) {
    const a = pivots[k - 1].i;
    const b = pivots[k].i;
    if (b <= a) continue;
    let sum = 0;
    for (let j = a; j <= b && j < candles.length; j++) sum += candles[j].v || 0;
    segVol.push({
      from: pivots[k - 1],
      to: pivots[k],
      avg: sum / (b - a + 1),
      up: pivots[k].price > pivots[k - 1].price,
    });
  }
  if (segVol.length < 3) return null;

  // 같은 방향으로 극점을 갱신한 구간들만 비교한다
  const events = [];
  for (let k = 2; k < segVol.length; k++) {
    const cur = segVol[k];
    const prevSame = segVol[k - 2]; // 두 구간 전이 같은 방향
    if (!prevSame || prevSame.up !== cur.up) continue;
    const extended = cur.up
      ? cur.to.price > prevSame.to.price
      : cur.to.price < prevSame.to.price;
    if (!extended) continue;
    const volUp = cur.avg > prevSame.avg;
    events.push({
      at: cur.to,
      dir: cur.up ? '고점 갱신' : '저점 갱신',
      volRatio: prevSame.avg > 0 ? cur.avg / prevSame.avg : null,
      volUp,
      verdict: volUp
        ? '거래량 동반 — 추세 지속 근거'
        : '거래량 감소 — 가짜 갱신. 리스크 관리 구간',
    });
  }

  // 가짜 갱신 2연속 = 반대 포지션 근거
  let fakeStreak = 0;
  let maxFakeStreak = 0;
  for (const e of events) {
    fakeStreak = e.volUp ? 0 : fakeStreak + 1;
    maxFakeStreak = Math.max(maxFakeStreak, fakeStreak);
  }

  // 최근 횡보 여부 — 거래량이 평균 아래로 죽었는가
  const recent = candles.slice(-20);
  const older = candles.slice(-60, -20);
  const avgR = recent.reduce((s, c) => s + (c.v || 0), 0) / (recent.length || 1);
  const avgO = older.length ? older.reduce((s, c) => s + (c.v || 0), 0) / older.length : null;
  const drying = avgO ? avgR < avgO * 0.7 : false;

  return {
    source: '[T5] 거래량 사이클',
    events: events.slice(-4),
    fakeStreak,
    maxFakeStreak,
    drying,
    signal:
      fakeStreak >= 2
        ? '거래량 없는 갱신이 2회 연속 — 강의는 이 지점을 반대 포지션 진입 근거로 본다'
        : drying
        ? '거래량이 말라붙은 횡보 구간 — 다음 방향은 이 구간의 상·하단 돌파로 정해진다'
        : null,
  };
}

// ===========================================================================
// [T1] TD Sequential — 추세 전환 후 8~9번째 봉에서 역방향 반전
//   강의: "무적 지표가 아니고 근거 한스푼 추가 용도"
// ===========================================================================
function tdSequential(candles) {
  if (!Array.isArray(candles) || candles.length < 12) return null;
  // 클래식 TD setup: 종가가 4봉 전 종가보다 높으면(낮으면) 카운트 누적
  let buy = 0;
  let sell = 0;
  const n = candles.length;
  for (let i = n - 1; i >= 4; i--) {
    const c = candles[i].c;
    const p = candles[i - 4].c;
    if (c < p) { if (sell) break; buy++; } else if (c > p) { if (buy) break; sell++; } else break;
    if (buy >= 13 || sell >= 13) break;
  }
  const count = Math.max(buy, sell);
  const side = buy >= sell ? 'buy' : 'sell';
  return {
    source: '[T1] TD Sequential',
    count,
    side,
    ripe: count === 8 || count === 9,
    note:
      count === 8 || count === 9
        ? `${side === 'buy' ? '매수' : '매도'} 셋업 ${count} — 강의는 8~9에서 역방향 반전이 흔하다고 본다 (근거 한 스푼)`
        : `셋업 카운트 ${count} — 8~9 구간이 아니다`,
  };
}

// ===========================================================================
// [T1] RSI 역산 — "이 가격이면 RSI가 얼마인가"를 뒤집어 "RSI N이 되려면 얼마인가"
//   강의: "20.3k 오면 롱 타려는데 저 지표 보니 20.3k면 RSI 25다 → 근거가 추가된다"
// ===========================================================================
function rsiPriceFor(candles, targetRsi, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 2) return null;
  // 마지막 봉을 뺀 상태의 평균 상승/하락폭 (Wilder)
  let gain = 0;
  let loss = 0;
  const n = candles.length;
  for (let i = n - period - 1; i < n - 1; i++) {
    const d = candles[i + 1].c - candles[i].c;
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const prev = candles[n - 2].c;

  // RSI = 100 - 100/(1+RS) → RS = target/(100-target)
  if (targetRsi <= 0 || targetRsi >= 100) return null;
  const rs = targetRsi / (100 - targetRsi);

  // 다음 봉 변화 d 에 대해:  avgG' = (avgG*(p-1) + max(d,0))/p , avgL' = (avgL*(p-1) + max(-d,0))/p
  // 상승 가정 (d>0): avgL' = avgL*(p-1)/p 이므로 d 를 직접 풀 수 있다
  const gBase = (avgG * (period - 1)) / period;
  const lBase = (avgL * (period - 1)) / period;
  let d;
  const dUp = rs * lBase * period - gBase * period; // d>0 가정
  if (dUp >= 0) d = dUp;
  else {
    // 하락 가정 (d<0): avgG' = gBase, avgL' = lBase + (-d)/p
    const dDown = gBase / rs - lBase;
    d = -(dDown * period);
  }
  const price = prev + d;
  return Number.isFinite(price) && price > 0
    ? { source: '[T1] RSI 역산', targetRsi, price, note: `다음 봉이 ${money(price)} 로 마감하면 RSI(${period}) ≈ ${targetRsi}` }
    : null;
}

// ===========================================================================
// [T4] 헤숄 품질 검정 + 대칭이론 TP
//
//   실격 사유 (강의의 "틀린 예시"):
//     · 어깨가 머리보다 크다
//     · 넥라인이 너무 가파르다 → 헤숄이 아니라 삼각수렴으로 봐야 한다
//   TP: 추세기반 피보 확장 (1=머리 꼭지점, 2=오른어깨 시작점, 3=붕괴지점) 의 0.618 과 1.0
// ===========================================================================
const NECKLINE_MAX_SLOPE_ATR = 0.5; // 봉당 ATR 대비 이 이상 기울면 "가파르다"

function headShoulderQuality(hs, atr) {
  if (!hs || !hs.points) return null;
  const p = hs.points;
  const need = ['ls', 'head', 'rs'];
  if (!need.every((k) => p[k])) return null;

  const base = p.neckA && p.neckB ? (p.neckA.price + p.neckB.price) / 2 : null;
  const headH = base != null ? Math.abs(p.head.price - base) : null;
  const lsH = base != null ? Math.abs(p.ls.price - base) : null;
  const rsH = base != null ? Math.abs(p.rs.price - base) : null;

  const fails = [];
  if (headH != null && lsH != null && lsH > headH) fails.push('왼어깨가 머리보다 크다');
  if (headH != null && rsH != null && rsH > headH) fails.push('오른어깨가 머리보다 크다');

  let neckSlope = null;
  if (p.neckA && p.neckB && p.neckB.i !== p.neckA.i && atr) {
    neckSlope = Math.abs((p.neckB.price - p.neckA.price) / (p.neckB.i - p.neckA.i)) / atr;
    if (neckSlope > NECKLINE_MAX_SLOPE_ATR) {
      fails.push(`넥라인이 가파르다 (봉당 ATR의 ${neckSlope.toFixed(2)}배) — 삼각수렴으로 보는 편이 맞다`);
    }
  }

  // 대칭이론 TP — 붕괴지점은 오른어깨 이후 넥라인 이탈점으로 근사한다
  let targets = null;
  if (p.head && p.rs) {
    const brk = p.brk || p.neckB || null;
    if (brk) {
      const span = brk.price - p.head.price; // 1→2→3 의 1→2 를 머리→오른어깨시작으로 본다
      const legSpan = p.rs.price - p.head.price;
      targets = [0.618, 1.0].map((r) => ({
        label: `대칭 TP ${pct(r)}`,
        price: brk.price + legSpan * r,
      }));
      void span;
    }
  }

  return {
    source: '[T4] 헤숄 품질 검정',
    valid: fails.length === 0,
    fails,
    neckSlopeAtr: neckSlope,
    targets,
    note: fails.length
      ? `실격 ${fails.length}건 — 강의 기준으로는 헤숄로 매매하기 어렵다`
      : '어깨·넥라인 조건 통과. 넥라인 이탈 + 그때의 거래량까지 봐야 완성이다',
    reminder: '넥라인을 뚫지 못하면 아무 의미 없다. 성공률은 70% 정도로 보고 손절을 반드시 둬라',
  };
}


// ===========================================================================
// [S] 총정리 p.26 — 피보 확장 "꿀통" 매매법
//   "A에 대한 B의 되돌림이 85~98% 정도라면, A에 대한 B 피보나치 확장이
//    1.382 자리에서 반등이 무조건 발생한다"
//   원문의 "무조건"은 강조 표현이다. 코드는 좌표만 내고 단정은 하지 않는다.
// ===========================================================================
function honeypot(pivots) {
  if (!Array.isArray(pivots) || pivots.length < 3) return null;
  const [a0, a1, b] = pivots.slice(-3);
  const a = Math.abs(a1.price - a0.price);
  if (!(a > 0)) return null;
  const rB = Math.abs(b.price - a1.price) / a;
  if (rB < 0.85 || rB > 0.98) return null;
  const sgn = Math.sign(a1.price - a0.price);
  return {
    source: '[S] 피보 확장 꿀통 (p.26)',
    retrace: rB,
    price: a1.price + sgn * a * 1.382,
    note: `B가 A를 ${pct(rB)} 되돌렸다 (85~98% 대역) — A 확장 1.382 자리를 반등 후보로 본다`,
  };
}

// ===========================================================================
// [S] 총정리 p.28~30 — 피보나치 수열 매물대
//   비트코인 가격이 피보나치 수열 값 자체에서 매물대를 만든다는 관찰.
//   "수열과 수열 사이에 피보나치를 그으면 각 구간이 지지·저항으로 작용하며,
//    특히 0.786 자리에 가장 강한 매물대가 생긴다"
//   (원문 예: 69k 고점 = 46368~75025 의 0.786, 그 전 64k = 처음 닿는 0.618)
//
//   비트 가격대에 한정된 관찰이다. 다른 종목에는 적용하지 않는다.
// ===========================================================================
const FIB_SEQ = [610, 987, 1597, 2584, 4181, 6765, 10946, 17711, 28657, 46368, 75025, 121393, 196418];

function fibSequenceLevels(price, symbol) {
  if (!(price > 0)) return null;
  if (symbol && !/^BTC/i.test(symbol)) return null;
  let lo = null;
  let hi = null;
  for (let i = 0; i < FIB_SEQ.length - 1; i++) {
    if (price >= FIB_SEQ[i] && price < FIB_SEQ[i + 1]) { lo = FIB_SEQ[i]; hi = FIB_SEQ[i + 1]; break; }
  }
  if (lo == null) return null;
  const span = hi - lo;
  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((r) => ({
    r,
    price: lo + span * r,
    strong: r === 0.786,
  }));
  const posInBand = (price - lo) / span;
  return {
    source: '[S] 피보나치 수열 매물대 (p.28~30)',
    band: [lo, hi],
    posInBand,
    levels,
    note: `현재가가 수열 ${lo}~${hi} 구간의 ${pct(posInBand)} 지점 · ` +
      `0.786(${money(lo + span * 0.786)})이 이 구간에서 가장 강한 매물대로 관찰됐다`,
  };
}

// ===========================================================================
// [S] 총정리 p.41~46 — EMA 60/120/200 "대작전" 스크리너
//   "이평배열이 역배열인 것 중 EMA60(보라)에 닿는 것을 산다.
//    EMA200(주황)을 아예 뚫어버린 것은 건너뛴다. 일봉 기준으로 본다."
//   60선이 저항에서 지지로 바뀌면 하락조정의 전환이 일어난다.
// ===========================================================================
function emaOperation(candles, interval) {
  const closes = candles.map((c) => c.c);
  const e = {};
  for (const per of [60, 120, 200]) {
    const ser = MA.emaSeries(closes, per);
    e[per] = ser && ser.length ? ser[ser.length - 1] : null;
  }
  if (e[60] == null || e[120] == null || e[200] == null) return null;
  const price = closes[closes.length - 1];
  const inverted = e[60] < e[120] && e[120] < e[200];
  const gap60 = Math.abs(price - e[60]) / e[60];
  const touch60 = gap60 <= 0.02;
  const brokeBelow200 = price < e[200] * 0.98;
  return {
    source: '[S] EMA 대작전 (p.41~46)',
    interval,
    ema: e,
    inverted,
    touch60,
    brokeBelow200,
    setup: inverted && touch60 && !brokeBelow200,
    daily: interval === '1d',
    invalidation: e[60],
    note: !inverted
      ? '역배열이 아니다 — 이 기법의 전제 조건이 아니다'
      : brokeBelow200
      ? 'EMA200을 아예 뚫었다 — 원문은 이런 종목을 건너뛰라고 한다'
      : touch60
      ? '역배열 + EMA60 접촉 — 원문이 말하는 진입 자리다. 60선 이탈이 곧 무효화다'
      : `역배열이지만 EMA60(${money(e[60])})과 ${pct(gap60)} 떨어져 있다`,
  };
}

// ===========================================================================
// [S] 총정리 p.9 — 지그재그(ABC) vs 임펄스(123) 감별 3법
//   (1) A-B가 1-2보다 훨씬 더 많이 겹친다
//   (2) A파가 시간·크기 면에서 1파보다 빨리 끝난다
//   (3) 지그재그는 완만한 채널, 1-2-3은 훨씬 가파르다
//   우리 엔진은 같은 피벗 묶음을 충격파로도 조정파로도 읽는다. 이 셋이 그 갈림을 돕는다.
// ===========================================================================
function zigzagVsImpulse(pivots) {
  if (!Array.isArray(pivots) || pivots.length < 4) return null;
  const [p0, p1, p2, p3] = pivots.slice(-4);
  const w1 = Math.abs(p1.price - p0.price);
  const w2 = Math.abs(p2.price - p1.price);
  const w3 = Math.abs(p3.price - p2.price);
  if (!(w1 > 0 && w3 > 0)) return null;

  const votes = [];
  const overlap = w2 / w1;
  votes.push({
    test: '① 겹침 (2파/B파 되돌림 깊이)',
    value: pct(overlap),
    lean: overlap >= 0.618 ? 'ABC' : '123',
  });
  const b1 = p1.i - p0.i;
  const b3 = p3.i - p2.i;
  votes.push({
    test: '② 첫 파동이 셋째보다 빨리 끝났는가',
    value: `${b1}봉 vs ${b3}봉`,
    lean: b1 < b3 * 0.7 ? 'ABC' : '123',
  });
  const s1 = b1 > 0 ? w1 / b1 : 0;
  const s3 = b3 > 0 ? w3 / b3 : 0;
  votes.push({
    test: '③ 셋째 파동의 가파름',
    value: s1 > 0 ? `${(s3 / s1).toFixed(2)}배` : '-',
    lean: s3 > s1 * 1.3 ? '123' : 'ABC',
  });

  const abc = votes.filter((v) => v.lean === 'ABC').length;
  return {
    source: '[S] 지그재그 vs 임펄스 감별 (p.9)',
    votes,
    verdict: abc >= 2 ? 'ABC (조정) 쪽' : '123 (충격) 쪽',
    score: `${abc}:${3 - abc}`,
  };
}

// ===========================================================================
// [S] 총정리 p.10 — 피보나치 타임존 (B파 종료 시점 예측)
//   "A파의 시작점과 끝점을 이었을 때 대략 1.618의 세로축 자리가 B파의 끝이다.
//    A 길이를 1로 보면 B의 길이는 A의 0.618 시간 범위다."
//   이 엔진에는 시간 목표가 하나도 없었다. 이것이 유일한 시간축 예측이다.
// ===========================================================================
function fibTimeZone(pivots, candles) {
  if (!Array.isArray(pivots) || pivots.length < 2 || !candles.length) return null;
  const [a0, a1] = pivots.slice(-2);
  const barsA = a1.i - a0.i;
  if (!(barsA > 0)) return null;
  const endIdx = Math.round(a0.i + barsA * 1.618);
  const last = candles.length - 1;
  const step = candles.length > 1 ? candles[1].t - candles[0].t : 0;
  return {
    source: '[S] 피보 타임존 (p.10)',
    barsA,
    barsB: Math.round(barsA * 0.618),
    endIdx,
    barsAway: endIdx - last,
    endT: endIdx <= last ? candles[endIdx].t : candles[last].t + (endIdx - last) * step,
    note: `A파가 ${barsA}봉 걸렸다 — B파는 약 ${Math.round(barsA * 0.618)}봉, ` +
      `A 시작점에서 1.618배 지점(현재 기준 ${endIdx - last}봉)이 B파 종료 예상 시점이다`,
  };
}

// ===========================================================================
// [S] 총정리 p.37 — 조정의 끝
//   "상승채널·조정채널의 끝은 3번 이상의 굴곡(핑퐁) 이후 채널 중간점에서 이루어진다.
//    3번의 이쁜 형태가 아니더라도 끝은 채널의 중간점에서 끝난다."
// ===========================================================================
function correctionEnd(pivots, channel) {
  const reg = channel && channel.regression;
  if (!reg || !Number.isFinite(reg.upper) || !Number.isFinite(reg.lower)) return null;
  if (!Array.isArray(pivots) || pivots.length < 4) return null;
  const mid = (reg.upper + reg.lower) / 2;
  let pings = 0;
  let prev = null;
  for (const pv of pivots.slice(-7)) {
    const side = pv.price > mid ? 'up' : 'down';
    if (prev && side !== prev) pings++;
    prev = side;
  }
  return {
    source: '[S] 조정의 끝 (p.37)',
    pings,
    mid,
    ready: pings >= 3,
    note: pings >= 3
      ? `채널 중간을 ${pings}번 오갔다 — 원문 기준(3회 이상) 충족. 조정 종료 좌표는 중간점 ${money(mid)}`
      : `굴곡 ${pings}회 — 아직 3회에 못 미친다. 중간점 ${money(mid)}은 참고만`,
  };
}

module.exports = {
  bounceJudgement,
  honeypot,
  fibSequenceLevels,
  emaOperation,
  zigzagVsImpulse,
  fibTimeZone,
  correctionEnd,
  FIB_SEQ,
  elliottChannels,
  parallelChannel,
  expansionChannel,
  ma99Check,
  ma99Confluence,
  volumeCycle,
  tdSequential,
  rsiPriceFor,
  headShoulderQuality,
  BOUNCE_TOL,
};
