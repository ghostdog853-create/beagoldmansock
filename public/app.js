/* ==========================================================================
   PIXEL TRADING FLOOR — app.js
   SSE 구독 → 픽셀 오피스 UI 실시간 중계. 바닐라 JS, 외부 라이브러리 없음.
   ========================================================================== */
'use strict';

/* --------------------------------------------------------------------------
   1. 캐릭터 스프라이트 데이터 (16×16 매트릭스 → 48×48 fillRect, 픽셀=3)
   문자→색 팔레트 방식. '.' 은 투명.
   -------------------------------------------------------------------------- */
const SPRITE_ROWS = [
  "................", // 0
  ".....HHHHHH.....", // 1  머리 위
  "...HHHHHHHHHH...", // 2
  "..HHHHHHHHHHHH..", // 3
  "..HHssssssssHH..", // 4  이마
  "..HssEEssEEssH..", // 5  눈 2px ×2
  "..HssssssssssH..", // 6
  "...ssssMMssss...", // 7  입 2px
  "....ssssssss....", // 8  턱
  "...BBBBBBBBBB...", // 9  어깨
  "..BBBBBBBBBBBB..", // 10 몸통(블롭)
  "..BBBBDDDDBBBB..", // 11 옷 디테일
  "..BBBBBBBBBBBB..", // 12
  "..BBBBBBBBBBBB..", // 13
  "...BBBBBBBBBB...", // 14
  "....BBBBBBBB...."  // 15 둥근 바닥
];

// 캐릭터별 팔레트 + 액세서리(특정 행 오버라이드)
const CHARACTERS = {
  short: { // 청록 — 단기, 빠른 사람. 헤드셋
    palette: { H:'#2fb5a8', s:'#f0c8a0', E:'#241a2e', M:'#b85c56', B:'#1f7d74', D:'#155a53', X:'#22222e' },
    overrides: {
      5: ".XHssEEssEEssHX.",
      6: ".XHssssssssssHX."
    }
  },
  mid: { // 앰버 — 중기, 스윙
    palette: { H:'#d9a13b', s:'#f2cda4', E:'#241a2e', M:'#b85c56', B:'#a8762a', D:'#7d561c' },
    overrides: { 7: "..HssssMMssssH.." }
  },
  long: { // 남색 — 장기, 큰 흐름. 챙 넓은 모자
    palette: { H:'#4059a8', s:'#e8c0a0', E:'#241a2e', M:'#7a3b1e', B:'#2c3f7d', D:'#1d2b57', X:'#5a74c9' },
    overrides: {
      1: "...XXXXXXXXXX...",
      2: "..XXXXXXXXXXXX.."
    }
  },
  align: { // 보라 — 프리즘. 머리 위 삼각 표식
    palette: { H:'#8b5cd6', s:'#f0c8a0', E:'#241a2e', M:'#b85c56', B:'#6a3fae', D:'#4c2b80', X:'#d9c6f5' },
    overrides: {
      0: ".......XX.......",
      1: "....XXHHHHXX...."
    }
  },
  pilot: { // 초록 — 실행. 어깨에 견장
    palette: { H:'#3f9d5c', s:'#f0c8a0', E:'#241a2e', M:'#b85c56', B:'#2c7343', D:'#1d5230', X:'#e8d99a' },
    overrides: {
      9: "..XBBBBBBBBBBX..",
      11: "..BBBBXXXXBBBB.."
    }
  }
};

const AGENT_IDS = ['short','mid','long','align','pilot'];
const NAMES = { short:'DASH', mid:'SWING', long:'TIDE', align:'PRISM', pilot:'PILOT' };
const AGENT_TINT = {
  short:'#2fb5a8', mid:'#d9a13b', long:'#4059a8', align:'#8b5cd6', pilot:'#3f9d5c'
};
const ROLES = {
  short:'단기 분석', mid:'중기 분석', long:'장기 분석',
  align:'시간축 정렬', pilot:'실행 설계'
};
const HORIZON_IDS = ['short','mid','long'];
const BIAS_COLORS = { UP:'#3fb950', DOWN:'#f85149', NEUTRAL:'#d29922' };
const DECISION_COLORS = { BUY:'#3fb950', SELL:'#f85149', WAIT:'#d29922' };
const DEMO = new URLSearchParams(location.search).get('demo') === '1';
// ?still=1 — 타자기 효과를 끄고 즉시 전체 텍스트를 표시한다(스크린샷·문서 캡처용)
const STILL = new URLSearchParams(location.search).get('still') === '1';

/* --------------------------------------------------------------------------
   2. 유틸
   -------------------------------------------------------------------------- */
const qs = (sel) => document.querySelector(sel);
const deskEl = (id) => document.getElementById('desk-' + id);

function drawSprite(canvas, id) {
  const ch = CHARACTERS[id];
  if (!ch || !canvas) return;
  const ctx = canvas.getContext('2d');
  const px = canvas.width / 16; // 48 / 16 = 3
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let r = 0; r < 16; r++) {
    const row = (ch.overrides && ch.overrides[r]) || SPRITE_ROWS[r];
    for (let c = 0; c < 16; c++) {
      const color = ch.palette[row[c]];
      if (color) {
        ctx.fillStyle = color;
        ctx.fillRect(c * px, r * px, px, px);
      }
    }
  }
}

function fmtNumber(n) {
  const num = typeof n === 'number' ? n : parseFloat(String(n).replace(/,/g, ''));
  if (!isFinite(num)) return String(n);
  const abs = Math.abs(num);
  const maxFrac = abs >= 1 ? 2 : 6;
  return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: maxFrac });
}

// priceLine 문자열 + candles 에서 가격/등락% 추출 (형식 유연 대응)
function parsePriceLine(line, candles) {
  let price = '', change = '', pct = null;
  if (line) {
    const pctM = String(line).match(/([+-]?\d+(?:\.\d+)?)\s*%/);
    if (pctM) { pct = parseFloat(pctM[1]); change = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'; }
    const priceM = String(line).match(/\$?\s*([\d,]+(?:\.\d+)?)/);
    if (priceM) price = priceM[1];
  }
  if (!price && candles && candles.length) price = fmtNumber(candles[candles.length - 1].c);
  return { price, change, pct };
}

function shortPath(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1];
}

/* --------------------------------------------------------------------------
   3. 말풍선 (타이핑/타자기)
   -------------------------------------------------------------------------- */
const typers = {}; // id -> interval id

function resetBubble(id) {
  const desk = deskEl(id);
  if (!desk) return;
  desk.classList.remove('bounce');
  const b = desk.querySelector('.bubble');
  clearInterval(typers[id]);
  b.classList.remove('show');
  b.textContent = '';
  delete b.dataset.report;
}

function showThinking(id) {
  const desk = deskEl(id);
  if (!desk) return;
  desk.classList.add('bounce');
  const b = desk.querySelector('.bubble');
  clearInterval(typers[id]);
  b.classList.add('show');
  b.innerHTML = '<span class="dots"><i>.</i><i>.</i><i>.</i></span>';
}

function typeBubble(id, text, report) {
  const desk = deskEl(id);
  if (!desk) return;
  desk.classList.remove('bounce');
  const b = desk.querySelector('.bubble');
  clearInterval(typers[id]);
  b.classList.add('show');
  b.dataset.name = NAMES[id] || id.toUpperCase();
  if (report != null && report !== '') b.dataset.report = report;
  const full = String(text || '');
  if (STILL) { b.textContent = full; return; }
  b.textContent = '';
  let i = 0;
  typers[id] = setInterval(() => {
    i += 1;
    b.textContent = full.slice(0, i);
    if (i >= full.length) clearInterval(typers[id]);
  }, 20);
}

/* --------------------------------------------------------------------------
   4. 전광판 + 차트
   -------------------------------------------------------------------------- */
let lastCandles = null; // 리사이즈 재렌더용

function updateBoard(ev) {
  qs('#board-symbol').textContent = ev.display || ev.symbol || '—';
  const px = Number(ev.price);
  qs('#board-price').textContent = isFinite(px) ? '$' + fmtNumber(px) : '—';
  const chEl = qs('#board-change');
  const pc = ev.ticker && Number(ev.ticker.changePct24h);
  if (isFinite(pc)) {
    chEl.textContent = (pc >= 0 ? '+' : '') + pc.toFixed(2) + '% 24h';
    chEl.className = pc >= 0 ? 'up' : 'down';
  } else {
    chEl.textContent = '';
    chEl.className = '';
  }

  views = ev.views || {};
  currentTf = ev.defaultView && views[ev.defaultView] ? ev.defaultView : Object.keys(views)[0];
  selectedScenario = 0;
  renderTfButtons();
  applyView();
  renderAlignBoard(ev.alignRows);
  if (!serverLogs) pushLog('sys', `> ${ev.display || ev.symbol} 멀티 타임프레임 수신 완료`);
}

/* --------------------------------------------------------------------------
   4-a. 시간축(봉) 전환 + 작도 패널
   -------------------------------------------------------------------------- */
let views = {};            // interval -> {candles, overlay, construction, ...}
let currentTf = null;      // 지금 보고 있는 봉
let selectedScenario = 0;  // 선택된 시나리오 인덱스

// 봉은 짧은 것부터 긴 것 순으로 고정 정렬한다 (객체 키 순서에 의존하면 흔들린다)
const TF_ORDER = ['15m', '30m', '1h', '4h', '1d', '1w'];

function renderTfButtons() {
  const wrap = qs('#tf-btns');
  if (!wrap) return;
  const list = TF_ORDER.filter((iv) => views[iv]);
  wrap.innerHTML = list.map((iv) => {
    const v = views[iv];
    const cls = 'ov-btn tf' + (iv === currentTf ? ' active' : '');
    const star = v.isPrimary ? '·' : '';
    return `<button class="${cls}" data-tf="${iv}" type="button" title="${esc(v.horizonLabel)}${v.isPrimary ? ' 기준봉' : ''}">${iv}${star}</button>`;
  }).join('');
  wrap.querySelectorAll('.tf').forEach((b) => {
    b.addEventListener('click', () => {
      currentTf = b.dataset.tf;
      selectedScenario = 0;
      renderTfButtons();
      applyView();
    });
  });
}

// 현재 봉의 캔들·오버레이·작도를 화면에 반영
function applyView() {
  const v = views[currentTf];
  if (!v) return;
  lastCandles = v.candles;
  lastOverlay = v.overlay || null;
  drawChart(v.candles);
  renderOverlayLegend(lastOverlay);
  renderConstruction(v);
}

// 코드가 계산한 시간축 정렬표를 상단 패널에 렌더 (LLM 판정 전에 이미 보인다)
let lastOverlay = null;
function renderAlignBoard(rows) {
  const wrap = qs('#ab-rows');
  if (!wrap) return;
  if (!rows || !rows.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = rows.map((r) => {
    const structCls = r.structure.includes('상승') ? 'up' : r.structure.includes('하락') ? 'down' : '';
    const pos = r.channelPos != null ? Math.round(r.channelPos * 100) : null;
    return (
      '<div class="ab-row">' +
      '<span class="ab-label">' + esc(r.label) + ' <i>' + esc(r.interval) + '</i></span>' +
      '<span class="ab-struct ' + structCls + '">' + esc(r.structure) + '</span>' +
      '<span class="ab-ma">이평 ' + esc(r.maAlign) + '</span>' +
      '<span class="ab-rsi">RSI ' + (r.rsi != null ? r.rsi.toFixed(1) : '-') + '</span>' +
      '<span class="ab-pos">채널 ' + (pos != null ? pos + '%' : '-') + '</span>' +
      '<span class="ab-wave" title="' + esc(r.wave) + '">' + esc(r.wave) + '</span>' +
      '</div>'
    );
  }).join('');
}

// 단순이동평균 — 서버를 건드리지 않고 프론트에서 계산한다(구간 부족 구간은 null)
function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

function drawChart(candles) {
  const cv = qs('#chart');
  const rect = cv.getBoundingClientRect();
  cv.width = Math.max(1, Math.round(rect.width));
  cv.height = Math.max(1, Math.round(rect.height));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!candles || candles.length < 2) return;

  const closes = candles.map((c) => c.c);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  // 최근 20봉 고·저 — 점선 수평 레벨로 그린다
  const recent = closes.slice(-20);
  const hi20 = Math.max(...recent);
  const lo20 = Math.min(...recent);

  const pool = closes.concat(
    ma20.filter((v) => v != null),
    ma50.filter((v) => v != null),
    [hi20, lo20]
  );
  const min = Math.min(...pool);
  const max = Math.max(...pool);
  const pad = 6;
  const w = cv.width - pad * 2;
  const h = cv.height - pad * 2;
  const up = closes[closes.length - 1] >= closes[0];
  const color = up ? '#3fb950' : '#f85149';
  const X = (i) => pad + (i / (closes.length - 1)) * w;
  const Y = (v) => pad + (1 - (v - min) / ((max - min) || 1)) * h;

  // 배경 픽셀 그리드 점
  ctx.fillStyle = '#161622';
  for (let gx = pad; gx < cv.width - pad; gx += 16) {
    for (let gy = pad; gy < cv.height - pad; gy += 12) ctx.fillRect(gx, gy, 1, 1);
  }

  // 20봉 고·저 점선 레벨
  ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  [[hi20, '#4d4d5e'], [lo20, '#4d4d5e']].forEach(([v, c]) => {
    ctx.strokeStyle = c;
    ctx.beginPath();
    ctx.moveTo(pad, Y(v));
    ctx.lineTo(cv.width - pad, Y(v));
    ctx.stroke();
  });
  ctx.setLineDash([]);

  // 이동평균선 (MA20 금색 / MA50 파랑)
  const line = (series, c, lw) => {
    ctx.strokeStyle = c;
    ctx.lineWidth = lw;
    ctx.beginPath();
    let started = false;
    series.forEach((v, i) => {
      if (v == null) return;
      const px = X(i), py = Y(v);
      started ? ctx.lineTo(px, py) : (ctx.moveTo(px, py), (started = true));
    });
    ctx.stroke();
  };
  line(ma50, '#4a9de8', 1);
  line(ma20, '#e8c84a', 1);

  // 종가 라인
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  closes.forEach((v, i) => { const px = X(i), py = Y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();

  // 마지막 값 점
  const lx = X(closes.length - 1), ly = Y(closes[closes.length - 1]);
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(lx) - 3, Math.round(ly) - 3, 6, 6);

  // 하단 날짜 라벨 (처음·중간·끝)
  ctx.fillStyle = '#5a5a72';
  ctx.font = '9px monospace';
  const label = (i, align) => {
    const t = candles[i] && candles[i].t;
    if (!t) return;
    const d = new Date(t);
    if (Number.isNaN(d.getTime())) return;
    const s = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    ctx.textAlign = align;
    ctx.fillText(s, X(i), cv.height - 2);
  };
  label(0, 'left');
  label(Math.floor((closes.length - 1) / 2), 'center');
  label(closes.length - 1, 'right');
  ctx.textAlign = 'left';

  // 분석 오버레이 — 지그재그·파동 라벨·하모닉 XABCD·중첩 구간
  if (lastOverlay) drawOverlay(ctx, cv, candles, lastOverlay, { pad, X, Y, min, max });
}

/* --------------------------------------------------------------------------
   4-b. 분석 오버레이
   서버가 t(시각)로 좌표를 보내므로, t → 캔들 인덱스 → x 로 환산한다.
   인덱스를 직접 받으면 서버·클라이언트의 캔들 슬라이스가 어긋날 때 전부 밀린다.
   -------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------
   5. AGENT CONSOLE (복구됨)
   -------------------------------------------------------------------------- */
let serverLogs = false;      // 서버가 log 이벤트를 보내면 true (합성 로그를 끈다)
let consoleFilter = 'all';
let agentLogCount = 0;
let autoScroll = true;
const ctypers = {};          // 콘솔 타이핑 타이머 (key → interval)

function consoleBody() { return qs('#console-body'); }

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function applyFilter(el) {
  const cat = el.dataset.cat || 'sys';
  let show = true;
  if (consoleFilter === 'agent') show = cat === 'agent' || cat === 'verdict';
  else if (consoleFilter === 'wave') show = cat === 'wave';
  el.style.display = show ? '' : 'none';
}

function appendLog(el, cat) {
  const body = consoleBody();
  if (!body) return null;
  el.dataset.cat = cat;
  applyFilter(el);
  body.appendChild(el);
  if (autoScroll) body.scrollTop = body.scrollHeight;
  else qs('#console-jump').classList.remove('hidden');
  return el;
}

// sys / news / stage / verdict 한 줄
function pushLog(kind, line) {
  const div = document.createElement('div');
  div.className = 'clog ' + kind;
  div.textContent = kind === 'news' ? '▪ ' + line : line;
  appendLog(div, kind === 'stage' ? 'sys' : kind === 'verdict' ? 'verdict' : kind);
  if (kind === 'stage') {
    const st = qs('#cs-stage');
    if (st) st.textContent = line.replace(/─/g, '').trim() || '진행 중';
  }
}

// 에이전트 브리핑 — 이름 배지 + 역할 + 전문(타이핑)
function pushAgentLog(id, report) {
  const tint = AGENT_TINT[id] || '#666';
  const div = document.createElement('div');
  div.className = 'clog agent';
  div.style.setProperty('--tint', tint);
  const head = document.createElement('span');
  head.className = 'who';
  head.textContent = NAMES[id] || id.toUpperCase();
  const role = document.createElement('span');
  role.className = 'role';
  role.textContent = ROLES[id] || '';
  const body = document.createElement('span');
  body.className = 'body';
  div.appendChild(head);
  div.appendChild(role);
  div.appendChild(body);
  appendLog(div, HORIZON_IDS.includes(id) ? 'agent' : 'wave');

  agentLogCount += 1;
  const cnt = qs('#cs-count');
  if (cnt) cnt.textContent = `브리핑 ${agentLogCount}건`;

  // 타이핑 — 길어도 4초 안에 끝나도록 스텝을 키운다
  const text = String(report || '');
  if (STILL) {
    body.textContent = text;
    const bd0 = consoleBody();
    if (bd0) bd0.scrollTop = bd0.scrollHeight;
    return;
  }
  const budget = 4000;
  const step = Math.max(1, Math.ceil(text.length / (budget / 14)));
  let i = 0;
  const key = 'c-' + id + '-' + agentLogCount;
  clearInterval(ctypers[key]);
  ctypers[key] = setInterval(() => {
    i = Math.min(text.length, i + step);
    body.textContent = text.slice(0, i);
    if (i < text.length) {
      const cur = document.createElement('span');
      cur.className = 'cur';
      cur.textContent = '█';
      body.appendChild(cur);
    } else {
      clearInterval(ctypers[key]);
      delete ctypers[key];
    }
    const bd = consoleBody();
    if (autoScroll && bd) bd.scrollTop = bd.scrollHeight;
  }, 14);
}

function resetConsole() {
  const body = consoleBody();
  if (body) body.innerHTML = '';
  Object.keys(ctypers).forEach((k) => { clearInterval(ctypers[k]); delete ctypers[k]; });
  agentLogCount = 0;
  autoScroll = true;
  const jump = qs('#console-jump');
  if (jump) jump.classList.add('hidden');
  const cnt = qs('#cs-count');
  if (cnt) cnt.textContent = '';
}

function initConsole() {
  const body = consoleBody();
  if (body) {
    body.addEventListener('scroll', () => {
      autoScroll = nearBottom(body);
      const jump = qs('#console-jump');
      if (jump) jump.classList.toggle('hidden', autoScroll);
    });
  }
  const jump = qs('#console-jump');
  if (jump) {
    jump.addEventListener('click', () => {
      const b = consoleBody();
      if (b) b.scrollTop = b.scrollHeight;
      autoScroll = true;
      jump.classList.add('hidden');
    });
  }
  document.querySelectorAll('.ctab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.ctab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      consoleFilter = tab.dataset.filter || 'all';
      document.querySelectorAll('#console-body .clog').forEach(applyFilter);
    });
  });
}

// 벽면 이퀄라이저 바 생성 (방마다 14개, 서로 다른 주기·색)
function initEqualizers() {
  document.querySelectorAll('.eq').forEach((eq, ri) => {
    eq.innerHTML = '';
    for (let i = 0; i < 14; i++) {
      const bar = document.createElement('i');
      if ((i + ri) % 3 === 0) bar.className = 'r';
      bar.style.height = 20 + ((i * 37 + ri * 11) % 70) + '%';
      bar.style.animationDelay = (((i * 7 + ri * 3) % 10) / 10).toFixed(1) + 's';
      bar.style.animationDuration = (0.8 + ((i + ri) % 4) * 0.25).toFixed(2) + 's';
      eq.appendChild(bar);
    }
  });
}

/* --------------------------------------------------------------------------
   5. 판정 패널
   -------------------------------------------------------------------------- */


/* --------------------------------------------------------------------------
   5-b. 판정 패널 / 정렬 패널 / 방향 칩
   -------------------------------------------------------------------------- */
function resetDecision() {
  const panel = qs('#decision-panel');
  if (panel) panel.classList.remove('active');
  const a = qs('#dp-action');
  if (a) { a.textContent = '판정 대기 중'; a.style.color = ''; }
  const fill = qs('#dp-gauge-fill');
  if (fill) fill.style.width = '0';
  const conf = qs('#dp-conf');
  if (conf) conf.textContent = '';
  ['#dp-entry','#dp-stop','#dp-target','#dp-target2','#dp-rr','#dp-sizing2'].forEach((sel) => {
    const el = qs(sel); if (el) el.textContent = '—';
  });
  const rat = qs('#dp-rationale'); if (rat) rat.textContent = '';
  const ht = qs('#dp-horizon-tag'); if (ht) ht.classList.add('hidden');
  const tg = qs('#dp-triggers'); if (tg) tg.classList.add('hidden');
  resetAlignPanel();
}

function resetAlignPanel() {
  const st = qs('#ap-state');
  if (st) { st.textContent = '판정 대기 중'; st.className = ''; }
  const set = (sel, v) => { const el = qs(sel); if (el) el.textContent = v; };
  set('#ap-primary', '—');
  set('#ap-tactical', '—');
  const sc = qs('#ap-scenario'); if (sc) sc.innerHTML = '';
  const v = qs('#ab-verdict');
  if (v) { v.textContent = '—'; v.className = ''; }
}

// 시간축 데스크의 방향 칩 — 세 축을 한눈에 비교하게 만드는 장치
function setBiasChip(id, bias, conf) {
  const el = document.getElementById('bias-' + id);
  if (!el) return;
  const b = String(bias || '').toUpperCase();
  const LABEL = { UP: '▲ 상방', DOWN: '▼ 하방', NEUTRAL: '● 중립' };
  el.textContent = (LABEL[b] || b) + (conf != null ? ' ' + conf + '%' : '');
  el.style.color = BIAS_COLORS[b] || '';
  el.style.borderColor = BIAS_COLORS[b] || '';
}

// alignment 이벤트 — 이 프로젝트의 핵심 산출물
const ALIGN_LABEL = {
  ALIGNED_UP: '전축 상방 정렬',
  ALIGNED_DOWN: '전축 하방 정렬',
  MIXED: '혼재 — 큰 축 대비 단기 되돌림',
  CONFLICT: '상충 — 장기·중기가 반대',
};
const ALIGN_CLASS = { ALIGNED_UP: 'up', ALIGNED_DOWN: 'down', MIXED: 'mixed', CONFLICT: 'conflict' };

function onAlignment(ev) {
  const a = String(ev.alignment || '').toUpperCase();
  const label = ALIGN_LABEL[a] || a || '—';
  const cls = ALIGN_CLASS[a] || '';
  const st = qs('#ap-state');
  if (st) { st.textContent = label; st.className = cls; }
  const set = (sel, v) => { const el = qs(sel); if (el) el.textContent = v || '—'; };
  set('#ap-primary', ev.primaryTrend);
  set('#ap-tactical', ev.tacticalBias);
  const sc = qs('#ap-scenario');
  if (sc) {
    sc.innerHTML =
      (ev.scenario ? '<b>유력</b> ' + esc(ev.scenario) : '') +
      (ev.altScenario ? '<br><b>대안</b> ' + esc(ev.altScenario) : '');
  }
  const v = qs('#ab-verdict');
  if (v) { v.textContent = label; v.className = cls; }
}

function onDecision(ev) {
  const act = String(ev.action || 'WAIT').toUpperCase();
  const col = DECISION_COLORS[act] || DECISION_COLORS.WAIT;
  const panel = qs('#decision-panel');
  if (panel) panel.classList.add('active');

  const a = qs('#dp-action');
  if (a) { a.textContent = act; a.style.color = col; }

  const conf = Math.max(0, Math.min(100, Number(ev.confidence) || 0));
  const fill = qs('#dp-gauge-fill');
  if (fill) { fill.style.width = conf + '%'; fill.style.background = col; }
  const cf = qs('#dp-conf'); if (cf) cf.textContent = conf + '%';

  // 어느 시간축을 거래하는지 — 손절폭이 여기서 갈리므로 크게 표시한다
  const ht = qs('#dp-horizon-tag');
  if (ht && ev.tradeHorizon && ev.tradeHorizon !== '-') {
    ht.textContent = ev.tradeHorizon + ' 시간축 거래';
    ht.classList.remove('hidden');
  }

  const set = (sel, v) => { const el = qs(sel); if (el) el.textContent = v || '—'; };
  set('#dp-entry', ev.entry);
  set('#dp-stop', ev.stop);
  set('#dp-target', ev.target1);
  set('#dp-target2', ev.target2);
  set('#dp-rr', ev.riskReward);
  set('#dp-sizing2', ev.sizing);
  const rat = qs('#dp-rationale'); if (rat) rat.textContent = ev.rationale || '';

  const tg = qs('#dp-triggers');
  if (tg && ev.triggers && ev.triggers !== '-') {
    tg.textContent = '⚑ ' + ev.triggers;
    tg.classList.remove('hidden');
  }

  if (!serverLogs) pushLog('verdict', `>>> 실행 판정 ${act} ${conf}%`);
  typeBubble('pilot', '실행 판정: ' + act, ev.report || ev.rationale || '');
}

// 상단 시장 배지 (열림/닫힘) — 암호화폐는 24시간이라 항상 열림
function updateMarketBadge(ev) {
  const badge = qs('#market-badge');
  const txt = qs('#market-badge-text');
  if (!badge || !txt) return;
  badge.classList.remove('closed');
  badge.classList.add('open');
  txt.textContent = 'MARKET 24H';
}

let overlayMode = 'all'; // all | fib | off

/* --------------------------------------------------------------------------
   작도 패널 — 어느 점을 찍었고 피보를 어디에 걸었는지
   -------------------------------------------------------------------------- */
const DIR_MARK = { UP: '▲', DOWN: '▼', NEUTRAL: '●' };
const DIR_COLOR = { UP: '#3fb950', DOWN: '#f85149', NEUTRAL: '#d29922' };

function renderConstruction(view) {
  const list = qs('#ct-list');
  const detail = qs('#ct-detail');
  const sum = qs('#ct-summary');
  if (!list || !detail) return;

  const c = view.construction;
  if (!c || !c.scenarios || !c.scenarios.length) {
    list.innerHTML = '<div class="ct-empty">이 봉에서는 유효한 시나리오가 없습니다</div>';
    detail.innerHTML = '<div class="ct-empty">—</div>';
    if (sum) sum.textContent = '—';
    return;
  }

  if (sum) {
    sum.innerHTML =
      `<b>${c.summary.total}갈래</b> · ` +
      `<span style="color:${DIR_COLOR.UP}">▲${c.summary.up}</span> / ` +
      `<span style="color:${DIR_COLOR.DOWN}">▼${c.summary.down}</span> · ` +
      esc(c.summary.verdict);
  }

  // 시나리오 카드
  list.innerHTML = c.scenarios.map((s, i) => {
    const col = DIR_COLOR[s.direction] || '#8a8aa0';
    return (
      `<div class="ct-card${i === selectedScenario ? ' sel' : ''}" data-i="${i}">` +
      `<div class="ct-card-top">` +
      `<span class="ct-tag">${esc(s.source)} ${esc(s.tag)}</span>` +
      `<span class="ct-dir" style="color:${col}">${DIR_MARK[s.direction] || ''}</span>` +
      `<span class="ct-score">${s.score}</span>` +
      `</div>` +
      `<div class="ct-card-title">${esc(s.title)}</div>` +
      (s.progress ? `<div class="ct-card-sub">${esc(s.progress)}</div>` : '') +
      `</div>`
    );
  }).join('');

  list.querySelectorAll('.ct-card').forEach((el) => {
    el.addEventListener('click', () => {
      selectedScenario = Number(el.dataset.i);
      renderConstruction(view);
      drawChart(lastCandles); // 선택된 시나리오의 피보 그리드로 다시 그린다
    });
  });

  renderScenarioDetail(c.scenarios[selectedScenario] || c.scenarios[0]);
}

function renderScenarioDetail(sc) {
  const detail = qs('#ct-detail');
  if (!detail || !sc) return;
  const col = DIR_COLOR[sc.direction] || '#8a8aa0';
  const rows = [];

  rows.push(
    `<div class="ct-d-head"><span style="color:${col}">${DIR_MARK[sc.direction] || ''} ${esc(sc.title)}</span>` +
    `<span class="ct-d-score">정합도 ${sc.score}</span></div>`
  );
  if (sc.progress) rows.push(`<div class="ct-d-sub">${esc(sc.progress)}</div>`);

  // 앵커점 — 어느 점을 찍었는가
  if (sc.construction && sc.construction.anchors) {
    rows.push('<div class="ct-sec">찍은 점</div>');
    rows.push(
      '<div class="ct-anchors">' +
      sc.construction.anchors.map((a) =>
        `<span class="ct-anch${a.confirmed === false ? ' tent' : ''}">` +
        `<i>${esc(a.label)}</i>${fmtNumber(a.price)}` +
        // 복합조정은 각 점이 하나의 패턴이 끝난 자리다 — 무슨 패턴이었는지 붙인다
        (a.sub ? `<em class="ct-sub">${esc(a.sub)}</em>` : '') +
        '</span>'
      ).join('<span class="ct-arrow">→</span>') +
      '</div>'
    );
  }

  // 피보나치 도구 — 어디에 걸었고 실측이 어디 떨어졌는가
  if (sc.construction && sc.construction.tools && sc.construction.tools.length) {
    rows.push('<div class="ct-sec">피보나치 작도</div>');
    for (const t of sc.construction.tools) {
      rows.push(`<div class="ct-tool">`);
      rows.push(`<div class="ct-tool-name">${t.type === 'retracement' ? '되돌림' : '확장'} · ${esc(t.name)}</div>`);
      if (t.note) rows.push(`<div class="ct-tool-note">${esc(t.note)}</div>`);
      // 눈금 표
      rows.push('<div class="ct-levels">' + t.levels.map((l) => {
        const isHit = t.actual && Math.abs(l.r - t.actual.nearest) < 1e-9 && t.actual.hit;
        return `<span class="ct-lv${isHit ? ' hit' : ''}"><i>${esc(l.label)}</i>${fmtNumber(l.price)}</span>`;
      }).join('') + '</div>');
      if (t.actual) {
        const ok = t.actual.hit;
        rows.push(
          `<div class="ct-actual ${ok ? 'ok' : 'off'}">실측 <b>${esc(t.actual.label)}</b> → ` +
          (ok ? `${esc(t.actual.nearestLabel)} 눈금에 부합 ✔` : `가장 가까운 눈금 ${esc(t.actual.nearestLabel)} — 어긋남`) +
          `</div>`
        );
      }
      rows.push('</div>');
    }
  }

  if (sc.invalidation != null) {
    rows.push(
      `<div class="ct-invalid">무효화 <b>${fmtNumber(sc.invalidation)}</b>` +
      (sc.invalidReason ? ` — ${esc(sc.invalidReason)}` : '') + '</div>'
    );
  }
  if (sc.targets && sc.targets.length) {
    rows.push('<div class="ct-sec">목표</div>');
    rows.push('<div class="ct-levels">' + sc.targets.map((t) =>
      `<span class="ct-lv tgt"><i>${esc(t.label)}</i>${fmtNumber(t.price)}${t.prob ? ` <b>${t.prob}%</b>` : ''}</span>`
    ).join('') + '</div>');
  }
  detail.innerHTML = rows.join('');
}

// 지금 선택된 시나리오의 작도 (차트 그리기용)
function selectedConstruction() {
  const v = views[currentTf];
  if (!v || !v.construction || !v.construction.scenarios.length) return null;
  return v.construction.scenarios[selectedScenario] || v.construction.scenarios[0];
}

// 차트 좌하단 범례 — 지금 무엇이 그려져 있는지 알려준다
function renderOverlayLegend(ov) {
  const el = qs('#overlay-legend');
  if (!el) return;
  const sc = selectedConstruction();
  if (!ov && !sc) { el.innerHTML = ''; return; }
  const rows = [];
  if (ov) rows.push(`봉 <b style="color:#c8c8d8">${esc(ov.interval)}</b> · ${esc(ov.horizonLabel || '')}`);
  if (sc) {
    const col = sc.direction === 'UP' ? '#3fb950' : sc.direction === 'DOWN' ? '#f85149' : '#d29922';
    rows.push(`<b style="color:${col}">작도</b> ${esc(sc.title)} (${sc.score}점)`);
    const toolNames = (sc.construction && sc.construction.tools || []).map((t) => esc(t.name.split(' (')[0]));
    if (toolNames.length) rows.push(`피보 ${toolNames.join(' / ')}`);
  }
  if (ov && ov.entry) {
    const col = ov.entry.side === '지지' ? '#3fb950' : '#f85149';
    rows.push(`<b style="color:${col}">진입 후보</b> ${esc(ov.entry.side)} · ${esc(ov.entry.reason)}`);
  }
  el.innerHTML = rows.join('<br>');
}

function drawOverlay(ctx, cv, candles, ov, geo) {
  if (overlayMode === 'off') return;
  const { pad, X, Y } = geo;
  const idxOf = (t) => {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < candles.length; i++) {
      const d = Math.abs(candles[i].t - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };
  const px = (t) => { const i = idxOf(t); return i < 0 ? null : X(i); };
  const right = cv.width - pad;
  const sc = selectedConstruction();

  // ---- 중첩 구간 / PRZ (전체 모드에서만) ----
  if (overlayMode === 'all') {
    for (const z of ov.zones || []) {
      const y1 = Y(z.high), y2 = Y(z.low);
      const top = Math.min(y1, y2), hgt = Math.max(2, Math.abs(y2 - y1));
      let fill, stroke;
      if (z.kind === 'prz') { fill = 'rgba(217,161,59,.14)'; stroke = 'rgba(217,161,59,.5)'; }
      else if (z.kind === 'confluence3') { fill = 'rgba(139,92,214,.18)'; stroke = 'rgba(139,92,214,.6)'; }
      else { fill = 'rgba(90,90,114,.10)'; stroke = 'rgba(90,90,114,.35)'; }
      ctx.fillStyle = fill;
      ctx.fillRect(pad, top, cv.width - pad * 2, hgt);
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.strokeRect(pad + 0.5, top + 0.5, cv.width - pad * 2 - 1, hgt - 1);
      ctx.setLineDash([]);
      ctx.fillStyle = stroke;
      ctx.font = '8px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(z.label, right - 2, top + (hgt > 12 ? 9 : -2));
      ctx.textAlign = 'left';
    }
  }

  // ---- 스윙 지그재그 (전체 모드) ----
  if (overlayMode === 'all') {
    const pts = (ov.pivots || []).map((p) => ({ x: px(p.t), y: Y(p.price), p })).filter((q) => q.x != null);
    if (pts.length > 1) {
      ctx.strokeStyle = 'rgba(200,200,216,.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
      ctx.setLineDash([]);
      for (const q of pts) {
        ctx.fillStyle = q.p.confirmed ? 'rgba(200,200,216,.7)' : 'rgba(106,106,128,.7)';
        ctx.fillRect(Math.round(q.x) - 2, Math.round(q.y) - 2, 4, 4);
      }
    }
  }

  // ---- 회귀채널 (빗각선 3개: 상단·중심·하단) ----
  if (overlayMode === 'all' && ov.channel) {
    const chn = ov.channel;
    const startIdx = candles.length - chn.lookback;
    const valAt = (i, off) => chn.a + chn.b * (i - startIdx) + off;
    const i0 = Math.max(0, startIdx), i1 = candles.length - 1;
    const bands = [[chn.k * chn.sd, 'rgba(139,92,214,.55)', [2, 2]], [0, 'rgba(139,92,214,.3)', [6, 3]], [-chn.k * chn.sd, 'rgba(139,92,214,.55)', [2, 2]]];
    for (const [off, col, dash] of bands) {
      ctx.strokeStyle = col;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(X(i0), Y(valAt(i0, off)));
      ctx.lineTo(X(i1), Y(valAt(i1, off)));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(139,92,214,.8)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`회귀채널 ${chn.lookback}봉`, X(i0) + 2, Y(valAt(i0, chn.k * chn.sd)) - 3);
  }

  // ---- 다이아고날 쐐기선 (1-3파 경계 / 2-4파 경계, 우측으로 연장) ----
  if (overlayMode === 'all' && ov.diagonal && ov.diagonal.pivots && ov.diagonal.pivots.length >= 5) {
    const P = ov.diagonal.pivots;
    const extendLine = (pA, pB) => {
      const iA = idxOf(pA.t), iB = idxOf(pB.t);
      if (iA < 0 || iB < 0 || iA === iB) return;
      const xA = X(iA), yA = Y(pA.price), xB = X(iB), yB = Y(pB.price);
      const slope = (yB - yA) / (xB - xA);
      const xEnd = right;
      const yEnd = yB + slope * (xEnd - xB);
      ctx.beginPath();
      ctx.moveTo(xA, yA);
      ctx.lineTo(xEnd, yEnd);
      ctx.stroke();
    };
    ctx.strokeStyle = 'rgba(232,200,74,.65)';
    ctx.lineWidth = 1.3;
    ctx.setLineDash([]);
    extendLine(P[1], P[3]); // 1파-3파 끝점을 잇는 경계
    extendLine(P[2], P[4]); // 2파-4파 끝점을 잇는 경계
    ctx.fillStyle = 'rgba(232,200,74,.85)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('다이아고날 쐐기', right - 2, Y(P[4].price) - 4);
    ctx.textAlign = 'left';
  }

  // ---- 진입 후보 (근거 중첩 1위, 3중첩 이상만) ----
  if (overlayMode === 'all' && ov.entry) {
    const e = ov.entry;
    const y1 = Y(e.high), y2 = Y(e.low);
    const top = Math.min(y1, y2), hgt = Math.max(2, Math.abs(y2 - y1));
    const col = e.side === '지지' ? '#3fb950' : '#f85149';
    ctx.fillStyle = col + '26';
    ctx.fillRect(pad, top, cv.width - pad * 2, hgt);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);
    ctx.strokeRect(pad + 0.5, top + 0.5, cv.width - pad * 2 - 1, Math.max(1, hgt - 1));
    const flagY = Math.min(Math.max(top + hgt / 2, pad + 16), cv.height - pad - 12);
    ctx.textAlign = 'right';
    ctx.fillStyle = col;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(`◆ 진입 후보 (${e.side}) ${e.distinct}중첩`, right - 2, flagY - 2);
    ctx.font = '8px monospace';
    ctx.fillText(e.reason, right - 2, flagY + 8);
    ctx.textAlign = 'left';
  }

  // ---- 선택된 시나리오의 작도 (주인공) ----
  if (!sc || !sc.construction) return;
  const dirCol = sc.direction === 'UP' ? '#3fb950' : sc.direction === 'DOWN' ? '#f85149' : '#d29922';

  // 피보나치 도구 — 눈금선 + 라벨
  const FIB_COL = {
    0: '#5a5a72', 0.236: '#4a9de8', 0.382: '#3fb950', 0.5: '#d29922',
    0.618: '#e8c84a', 0.786: '#f0883e', 1.0: '#f85149',
    1.382: '#8b5cd6', 1.618: '#8b5cd6', 2.618: '#b9a4e8', 4.236: '#b9a4e8',
  };
  for (const t of sc.construction.tools) {
    const a0 = t.anchors[0], aN = t.anchors[t.anchors.length - 1];
    const x0 = px(a0.t), x1 = px(aN.t);
    const xs = x0 == null ? pad : Math.min(x0, x1 == null ? pad : x1);

    // 도구 앵커를 잇는 얇은 선 (어디에 걸었는지)
    if (x0 != null && x1 != null) {
      ctx.strokeStyle = dirCol + '66';
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 2]);
      ctx.beginPath();
      t.anchors.forEach((a, i) => {
        const ax = px(a.t), ay = Y(a.price);
        if (ax == null) return;
        i ? ctx.lineTo(ax, ay) : ctx.moveTo(ax, ay);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const l of t.levels) {
      const y = Y(l.price);
      if (!isFinite(y) || y < pad - 4 || y > cv.height - pad + 4) continue;
      const isHit = t.actual && t.actual.hit && Math.abs(l.r - t.actual.nearest) < 1e-9;
      ctx.strokeStyle = (FIB_COL[l.r] || '#5a5a72') + (isHit ? 'ff' : '55');
      ctx.lineWidth = isHit ? 1.5 : 1;
      ctx.setLineDash(isHit ? [] : [5, 4]);
      ctx.beginPath();
      ctx.moveTo(xs, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = (FIB_COL[l.r] || '#5a5a72') + (isHit ? 'ff' : 'aa');
      ctx.font = (isHit ? 'bold ' : '') + '8px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(l.label, xs + 2, y - 2);
    }
  }

  // 앵커점 + 파동 라벨 — 맨 위에 그린다
  ctx.textAlign = 'center';
  for (const a of sc.construction.anchors) {
    const x = px(a.t);
    if (x == null) continue;
    const y = Y(a.price);
    const above = a.kind === 'H';
    ctx.strokeStyle = dirCol;
    ctx.fillStyle = a.confirmed === false ? '#0b0b12' : dirCol;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#0b0b12';
    ctx.fillRect(x - 7, above ? y - 17 : y + 5, 14, 12);
    ctx.strokeStyle = dirCol;
    ctx.strokeRect(x - 7.5, (above ? y - 17 : y + 5) + 0.5, 15, 11);
    ctx.fillStyle = dirCol;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(a.label, x, above ? y - 8 : y + 14);
  }
  ctx.textAlign = 'left';
}

/* --------------------------------------------------------------------------
   6. 모달 / 토스트
   -------------------------------------------------------------------------- */
function openModal(title, body) {
  qs('#modal-title').textContent = title;
  qs('#modal-body').textContent = body;
  qs('#modal').classList.remove('hidden');
}
function closeModal() { qs('#modal').classList.add('hidden'); }

function toast(msg, kind, href) {
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  if (href) {
    t.style.cursor = 'pointer';
    t.title = '클릭하면 리포트가 열립니다';
    t.addEventListener('click', () => window.open(href, '_blank'));
  }
  qs('#toasts').appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => {
    t.classList.remove('in');
    setTimeout(() => t.remove(), 300);
  }, href ? 8000 : 3200); // 링크 토스트는 누를 시간을 넉넉히
}

/* --------------------------------------------------------------------------
   7. 실행 상태
   -------------------------------------------------------------------------- */
function setBusy(busy) {
  qs('#analyze-btn').disabled = busy;
}

// 현재 선택된 모드 ('algo' | 'scalp' | 'attack') — 토글 버튼과 동기화
let currentMode = 'full';

function setMode(mode) {
  currentMode = ['full', 'swing', 'scalp'].includes(mode) ? mode : 'full';
  [['#mode-full', 'full'], ['#mode-swing', 'swing'], ['#mode-scalp', 'scalp']].forEach(
    ([sel, m]) => {
      const el = qs(sel);
      if (el) el.classList.toggle('active', currentMode === m);
    }
  );
}

// 모드에 따라 이번 런에서 쉬는 시간축 데스크를 흐리게 표시
const MODE_HORIZONS = {
  full: ['short', 'mid', 'long'],
  swing: ['mid', 'long'],
  scalp: ['short', 'mid'],
};

function applyModeDim(mode) {
  const active = MODE_HORIZONS[mode] || MODE_HORIZONS.full;
  HORIZON_IDS.forEach((id) => {
    const el = deskEl(id);
    if (el) el.classList.toggle('idle', !active.includes(id));
  });
}


function onRunStart(ev) {
  setBusy(true);
  AGENT_IDS.forEach(resetBubble);
  HORIZON_IDS.forEach((id) => {
    const el = document.getElementById('bias-' + id);
    if (el) { el.textContent = '—'; el.style.color = ''; el.style.borderColor = ''; }
  });
  resetDecision();
  resetConsole();
  if (ev && ev.mode) {
    setMode(ev.mode);
    applyModeDim(ev.mode);
  }
}

function onRunEnd() {
  setBusy(false);
  AGENT_IDS.forEach((id) => { const d = deskEl(id); if (d) d.classList.remove('bounce'); });
}

/* --------------------------------------------------------------------------
   8. SSE 이벤트 라우팅
   -------------------------------------------------------------------------- */
function handleEvent(ev) {
  switch (ev.type) {
    case 'run:start':  onRunStart(ev); break;
    case 'market':     updateBoard(ev); break;
    case 'agent:start': showThinking(ev.id); break;
    case 'agent:done':
      typeBubble(ev.id, ev.bubble || '', ev.report || '');
      pushAgentLog(ev.id, ev.report || ev.bubble || '');
      if (ev.bias) setBiasChip(ev.id, ev.bias, ev.confidence);
      break;
    case 'log': {
      serverLogs = true;
      const line = ev.line || '';
      // 서버의 최종 판정 줄은 강조 박스로 렌더한다
      const kind = line.startsWith('>>>')
        ? 'verdict'
        : ev.kind === 'news' ? 'news' : ev.kind === 'stage' ? 'stage' : 'sys';
      pushLog(kind, line);
      break;
    }
    case 'alignment': onAlignment(ev); break;
    case 'decision':   onDecision(ev); break;
    case 'saved':      toast('리포트 저장됨(클릭해서 열기): ' + shortPath(ev.path), 'ok', '/reports/' + encodeURIComponent(shortPath(ev.path))); break;
    case 'run:error':  toast(ev.message || '오류가 발생했습니다', 'err'); break;
    case 'run:end':    onRunEnd(); break;
    default: break;
  }
}

function connectStream() {
  const es = new EventSource('/api/stream');
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    handleEvent(ev);
  };
  es.onerror = () => { /* 브라우저가 자동 재연결 */ };
}

/* --------------------------------------------------------------------------
   9. 분석 요청
   -------------------------------------------------------------------------- */
async function analyze() {
  const sym = qs('#symbol-input').value.trim();
  if (!sym) { toast('심볼을 입력하세요', 'err'); return; }
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym, demo: DEMO, mode: currentMode })
    });
    if (res.status === 409) { toast('이미 분석 중입니다', 'err'); return; }
    if (!res.ok) { toast('요청 실패 (' + res.status + ')', 'err'); return; }
    // 202 성공 — 이후 UI 는 SSE 가 구동
  } catch (_) {
    toast('서버에 연결할 수 없습니다', 'err');
  }
}

/* --------------------------------------------------------------------------
   10. 시계
   -------------------------------------------------------------------------- */
function fmtClock(tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}
function tickClocks() {
  qs('#clock-nyc').textContent = fmtClock('America/New_York');
  qs('#clock-ldn').textContent = fmtClock('Europe/London');
  qs('#clock-sel').textContent = fmtClock('Asia/Seoul');
}

/* --------------------------------------------------------------------------
   11. 티커 테이프
   -------------------------------------------------------------------------- */
function renderTape(items) {
  if (!Array.isArray(items) || !items.length) return;
  const make = () => items.map((it) => {
    const pct = Number(it.changePct);
    const sign = pct >= 0 ? '+' : '';
    const cls = pct >= 0 ? 'up' : 'down';
    const pctTxt = isFinite(pct) ? sign + pct.toFixed(2) + '%' : '';
    return '<span class="tape-item"><b>' + it.sym + '</b> $' + fmtNumber(it.price) +
           ' <span class="' + cls + '">' + pctTxt + '</span></span>';
  }).join('');
  // 콘텐츠 2벌 이어붙여 seamless 스크롤 (-50% 애니메이션과 정합)
  qs('#tape-track').innerHTML = make() + make();
}
/* --------------------------------------------------------------------------
   11-b. 멀티 거래소 전광판
   -------------------------------------------------------------------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadTape() {
  try {
    const res = await fetch('/api/tape');
    if (!res.ok) return;
    renderTape(await res.json());
  } catch (_) { /* 무시 — 다음 폴링에서 재시도 */ }
}

/* --------------------------------------------------------------------------
   12. 초기화
   -------------------------------------------------------------------------- */
function init() {
  // 스프라이트 렌더
  AGENT_IDS.forEach((id) => {
    const desk = deskEl(id);
    if (desk) drawSprite(desk.querySelector('.sprite'), id);
  });

  // 시계
  tickClocks();
  setInterval(tickClocks, 1000);

  // 티커
  loadTape();
  setInterval(loadTape, 60000);

  // 정렬 패널 접기/펼치기
  const abToggle = qs('#ab-toggle');
  if (abToggle) {
    abToggle.addEventListener('click', () => {
      const box = qs('#align-board');
      const hidden = box.classList.toggle('collapsed');
      abToggle.textContent = hidden ? '펼치기' : '접기';
    });
  }

  // 컨트롤
  qs('#analyze-btn').addEventListener('click', analyze);
  qs('#symbol-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') analyze(); });

  // 모드 토글
  [['#mode-full', 'full'], ['#mode-swing', 'swing'], ['#mode-scalp', 'scalp']].forEach(([sel, m]) => {
    const btn = qs(sel);
    if (btn) btn.addEventListener('click', () => { setMode(m); applyModeDim(m); });
  });
  applyModeDim(currentMode);

  // 말풍선 클릭 → 모달
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.bubble');
    if (b && b.dataset.report) openModal(b.dataset.name || '리포트', b.dataset.report);
  });
  qs('#modal-close').addEventListener('click', closeModal);
  qs('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // 작도 패널 접기
  const ctT = qs('#ct-toggle');
  if (ctT) {
    ctT.addEventListener('click', () => {
      const hidden = qs('#construct').classList.toggle('collapsed');
      ctT.textContent = hidden ? '펼치기' : '접기';
    });
  }

  // 오버레이 토글
  document.querySelectorAll('.ov-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      overlayMode = btn.dataset.ov;
      document.querySelectorAll('.ov-btn').forEach((b) => b.classList.toggle('active', b === btn));
      if (lastCandles) { drawChart(lastCandles); renderOverlayLegend(lastOverlay); }
    });
  });

  // 차트 리사이즈 대응 (마지막 candles 재렌더)
  window.addEventListener('resize', () => { if (lastCandles) drawChart(lastCandles); });

  // 에이전트 콘솔 + 벽면 이퀄라이저
  initConsole();
  initEqualizers();

  // SSE 연결 (현재 상태 replay 후 구독)
  connectStream();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
