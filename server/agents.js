'use strict';

// WAVE FLOOR — 에이전트 모듈
//
// 분업 축은 "시간"이다. 단기·중기·장기 분석가가 각자 자기 시간축의 지표 묶음만
// 받아 같은 기법(이평·오실레이터·채널·패턴·엘리어트)을 적용한다. 그 뒤 정렬
// 판정관이 세 축이 같은 방향인지 판단하고, 실행 설계관이 그걸 진입·손절·목표로 옮긴다.
//
// 프롬프트 원칙 — 이 프로젝트의 전부다:
//   지표 계산과 파동 카운트는 전부 코드가 끝내놓고 문장으로 넘긴다.
//   LLM은 "세는" 일을 하지 않는다. 오직 "해석"만 한다.
//   그래서 프롬프트에 없는 숫자를 쓰는 것은 명시적으로 금지된다.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const AGENTS = [
  { id: 'short', name: 'DASH', nameKo: '대시', role: '단기 분석', roomKo: '단기 데스크', horizon: 'short' },
  { id: 'mid', name: 'SWING', nameKo: '스윙', role: '중기 분석', roomKo: '중기 데스크', horizon: 'mid' },
  { id: 'long', name: 'TIDE', nameKo: '타이드', role: '장기 분석', roomKo: '장기 데스크', horizon: 'long' },
  { id: 'align', name: 'PRISM', nameKo: '프리즘', role: '시간축 정렬 판정', roomKo: '정렬 판정실' },
  { id: 'pilot', name: 'PILOT', nameKo: '파일럿', role: '실행 설계', roomKo: '실행 데스크' },
];

const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

const SPAWN_TIMEOUT_MS = 180000;
const FLOOR_MODEL = (process.env.WAVE_MODEL || 'opus').replace(/[^a-z0-9.-]/gi, '');

// ---------------------------------------------------------------------------
// JSON 추출 — 모델이 앞뒤에 설명을 붙여도 살아남게 첫 '{'부터 마지막 '}'까지
// ---------------------------------------------------------------------------
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 공통 프롬프트 규칙
// ---------------------------------------------------------------------------
const GROUNDING_RULE =
  '[절대 규칙] 아래 제공된 데이터에 나온 숫자만 사용하라. 도구·검색을 쓰지 마라. ' +
  '제공되지 않은 가격·지표·파동 번호를 새로 만들어내는 것은 금지다. 근거가 없으면 ' +
  '"데이터 없음"이라고 밝혀라. 특히 파동 분석은 이미 코드가 계산을 끝낸 상태로 주어진다 — ' +
  '네가 새로 세지 말고, 주어진 것 중에서 고르고 그 이유를 대라.\n' +
  '  · [닐리 NEoWave] 각 모노파동의 구조기호를 되돌림 법칙으로 판정한 결과다. ' +
  '괄호 표기가 신뢰도이고(맨몸>소괄호>대괄호), "추정"·"일부"로 표시된 항목은 ' +
  '원문 복원이 불완전한 구간이니 그것만으로 결론내지 마라. ' +
  '"가장자리 필터"는 패턴의 시작·끝에 올 수 없는 기호를 뺐다는 뜻이며 신뢰도 하락이 아니다.\n' +
  '  · [국면 판정] 방향성/비방향성은 닐리의 핵심 구분이다. 비방향성 국면에서 ' +
  '방향 베팅을 설계하는 것이 손실의 주된 원인이므로, 이 판정을 최우선으로 반영하라.\n' +
  '  · [고전 엘리어트] 절대 규칙 3개를 통과한 카운트 후보다. 정합도 점수는 ' +
  '피보나치 정합도일 뿐이니 점수만 보고 고르지 마라.\n' +
  '  · [근거 중첩] 서로 다른 방법이 같은 가격대를 가리킨 구간이다. ' +
  '3중첩 이상만 실행 타점 후보로 쓰고, 진입·손절·목표는 여기서 가져와라.\n' +
  '  · [하모닉] X-A-B-C-D는 확정 전환점만 앵커로 쓴 것이다. PRZ는 존이지 한 점이 아니며, ' +
  'PRZ 폭이 넓다고 표시되면 신뢰도가 낮다는 뜻이다.\n' +
  '  · [다이아고날 3대 조건] 3개 모두 충족해야 "4파 끝 매수, 5파 장기 보유" 셋업이다. ' +
  '2개면 관심 단계일 뿐 진입 근거가 아니다.\n' +
  '  · [세력 순위] 조정패턴에 붙는 -3~+3 등급이다. 이 값이 다음 파동의 되돌림 한계를 정한다 ' +
  '(±1은 90% 이하, ±2는 80% 이하, ±3은 60~70%). 후속 충격파 최소 배수가 붙어 있으면 목표 산정에 그대로 써라.\n' +
  '  · [실전 기법 / 중재] 닐리는 이 프로젝트의 기반이지만 100%가 아니다. ' +
  '텔레그램 강의에서 뽑은 기법들(역피보 반등 판정 · 엘리엇 앵커 채널 · MA99 · 거래량 사이클)은 ' +
  '닐리가 답하지 않는 것을 채운다. 중재 블록에는 각 기법이 **이 차트에서** 몇 건 중 몇 건을 맞혔는지 ' +
  '기저율과 함께 나온다. **적중률이 아니라 "초과"(적중률-기저율)를 봐라** — ' +
  '초과가 0 근처면 그 기법은 이 차트에서 아무 정보도 더하지 못한 것이고, 음수면 오히려 해로웠다. ' +
  '"표본 부족"이 붙은 항목은 근거로 쓰지 마라. 그리고 어떤 경우에도 ' +
  '"이 기법이 옳다"가 아니라 "이 구간에서 더 맞았다"로만 말하라.\\n' +
  '  · [척도 / 비례의 법칙] 등락폭이 큰 구간에서는 로그 기준으로 되돌림 비율을 잰다. ' +
  '"(로그 기준 · 산술 N%)"가 붙어 있으면 앞의 값이 법칙 번호를 정한 값이다. ' +
  '"산술 A% / 로그 B% 로 갈린다"는 경고가 있으면 척도에 따라 구조 판정이 달라진다는 뜻이니 ' +
  '그 모노파동에 기대어 방향을 확정하지 마라.\\n' +
  '  · [사전 구성법칙] "▶ 사전 구성법칙 확정"이 붙은 구조기호는 닐리 3장의 조건 문단이 ' +
  '실제로 통과해서 확정된 것이다. 근거 문단 번호와 쪽수가 같이 나오므로 그것을 인용하라. ' +
  '"확정(유일)"은 원문이 다른 가능성이 없다고 못박은 경우다. ' +
  '반대로 "아직 표에 수록되지 않았다"고 적힌 조건은 우리가 옮기지 않은 구간이니, ' +
  '확정된 것처럼 말하지 말고 등급별 후보 그대로 다뤄라.\\n' +
  '  · [복합조정 WXY] 표준 조정 두세 개를 x파동이 이은 것이다. 판정은 x파동 크기 하나로 갈린다 — ' +
  '61.8% 이하면 범주1(집약형·세력 +2), 161.8% 이상이면 범주2(확산형·세력 -3, 러닝이면 +3)다. ' +
  '"범주 미확정"이 붙었으면 세력이 +2와 -3 사이에서 갈리는 것이니 어느 한쪽으로 결론내지 마라. ' +
  '복합조정은 상위 등급에서 :3 하나로 접히므로, 더 큰 파동의 2파나 b파 자리로 읽는 것이 자연스럽다.\n' +
  '  · [유사성·시간론 경고] 닐리의 관문이다. "같은 등급이 아닐 수 있다"거나 ' +
  '"인접 3파동 기간이 모두 비슷하다"는 경고가 붙은 카운트는 등급이 어긋났을 수 있으니 ' +
  '그 카운트에 기대 방향을 정하지 마라.';

const BRIEFING_RULE =
  '[브리핑 분량] report는 8~14문장이다. 소제목 없이 단락 2~3개로 쓰고 ' +
  '① 어떤 지표가 서로 일치하고 어떤 지표가 엇갈리는지 ② 그 엇갈림을 어떻게 해석하는지 ' +
  '③ 반대 시나리오 ④ 판단이 바뀌는 구체적 가격 레벨을 반드시 담아라. ' +
  'bubble은 말풍선용으로 2~3문장(60~120자)이다.';

const BUBBLE = '"bubble":"말풍선 2~3문장(한국어, 60~120자)"';
const REPORT = '"report":"상세 브리핑(한국어, 8~14문장)"';

const OUT_HORIZON =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명을 붙이지 마라:\n' +
  `{${BUBBLE},${REPORT},` +
  '"bias":"UP|DOWN|NEUTRAL 중 하나","confidence":0-100 정수,' +
  '"waveChoice":"고른 파동 후보와 닐리 구조기호를 함께 한 줄로, 없으면 \\"없음\\"",' +
  '"support":"1차 지지 — 중첩 구간을 중첩수와 함께 인용","resistance":"1차 저항 — 동일",' +
  '"invalidation":"이 방향 판단이 죽는 가격",' +
  '"phase":"닐리 국면 판정(방향성/비방향성/혼재)과 그 함의 한 줄","agreement":"지표들이 일치하는지 엇갈리는지 한 줄 요약"}';

const OUT_ALIGN =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명을 붙이지 마라:\n' +
  `{${BUBBLE},${REPORT},` +
  '"alignment":"ALIGNED_UP|ALIGNED_DOWN|MIXED|CONFLICT 중 하나",' +
  '"primaryTrend":"장기·중기가 가리키는 큰 방향 한 줄",' +
  '"tacticalBias":"지금 단기적으로 취할 자세 한 줄",' +
  '"scenario":"가장 유력한 시나리오 2-3문장",' +
  '"altScenario":"두 번째 시나리오와 그것이 유력해지는 조건 2문장",' +
  '"confidence":0-100 정수}';

const OUT_PILOT =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명을 붙이지 마라:\n' +
  `{${BUBBLE},${REPORT},` +
  '"action":"BUY|SELL|WAIT 중 하나","tradeHorizon":"단기|중기|장기 중 어느 시간축을 거래하는지",' +
  '"confidence":0-100 정수,' +
  '"entry":"진입 조건 또는 가격","stop":"손절 가격","target1":"1차 목표","target2":"2차 목표",' +
  '"riskReward":"손익비 한 줄(예: 1:2.4)","sizing":"권장 비중 한 줄(리스크 2% 룰 기준)",' +
  '"triggers":"판단이 바뀌는 트리거 2개를 한 줄로",' +
  '"rationale":"근거 2-3문장"}';

function header(meta) {
  return `너는 WAVE FLOOR의 ${meta.name}(${meta.role})이다.`;
}

// ---------------------------------------------------------------------------
// buildPrompt — 역할별 데이터 주입
// context: { symbol, display, price, horizonBlock, horizonReports, alignTable,
//            alignResult, levels, mode }
// ---------------------------------------------------------------------------
function buildPrompt(id, context = {}) {
  const meta = AGENT_BY_ID[id];
  const sym = `대상: ${context.display || context.symbol || '심볼'} · 현재가 ${
    context.price != null ? Number(context.price).toLocaleString('en-US', { maximumFractionDigits: 6 }) : '-'
  }`;

  const parts = [header(meta), '', GROUNDING_RULE, '', sym, ''];

  if (id === 'short' || id === 'mid' || id === 'long') {
    const label = meta.role.replace(' 분석', '');
    parts.push(context.horizonBlock || '(데이터 없음)');
    parts.push('');
    parts.push(
      `너는 ${label} 시간축만 담당한다. 다른 시간축은 신경 쓰지 마라 — 그건 정렬 판정관의 일이다. ` +
        '위에 주어진 스윙 구조·이동평균·오실레이터·채널·패턴·파동 후보를 종합해 ' +
        '이 시간축에서의 방향(bias)을 정하라. ' +
        '핵심은 지표들이 서로 확인해주는지(confluence) 아니면 엇갈리는지다 — ' +
        '엇갈릴 때는 어느 쪽에 더 무게를 두는지와 그 이유를 분명히 밝혀라.'
    );
    parts.push('');
    parts.push(
      '파동 판단은 두 층으로 주어진다. 먼저 닐리 NEoWave의 모노파동 구조기호를 보고 ' +
        '지금 이 구간이 충격적 구조인지 조정적 구조인지 읽어라. 그다음 고전 엘리어트 ' +
        '카운트 후보를 보고 그 구조와 맞아떨어지는 것을 골라라. 두 층이 어긋나면 ' +
        '그 사실 자체가 중요한 정보다 — 어느 쪽을 왜 택했는지 밝혀라.\n' +
        '유력 구조기호가 여러 개면 하나로 확정하지 말고 그대로 복수로 보고하라. ' +
        '후보가 없으면 "파동 카운트 불가"로 인정하고 다른 지표로 판단하라.'
    );
    parts.push('');
    parts.push(
      '지지·저항 레벨을 말할 때는 반드시 [근거 중첩] 블록의 구간을 인용하라. ' +
        '중첩되지 않은 단일 레벨을 지지선이라고 부르지 마라 — 그건 근거가 하나뿐이라는 뜻이다.'
    );
    parts.push('');
    parts.push(BRIEFING_RULE);
    parts.push('');
    parts.push(OUT_HORIZON);
    return parts.join('\n');
  }

  if (id === 'align') {
    parts.push('[시간축별 분석가 리포트]');
    parts.push(formatHorizonReports(context.horizonReports));
    parts.push('');
    parts.push('[지표 원본 — 시간축 정렬 요약]');
    parts.push(context.alignTable || '(없음)');
    parts.push('');
    parts.push(
      '너는 시간축 정렬 판정관(PRISM)이다. 세 분석가의 방향이 같은지 다른지를 판정하는 것이 ' +
        '네 유일한 임무다. 실전에서 방향을 결정하는 것은 개별 지표가 아니라 ' +
        '"큰 시간축과 작은 시간축이 같은 쪽을 보는가"이기 때문이다.'
    );
    parts.push('');
    parts.push(
      '판정 기준:\n' +
        '  ALIGNED_UP   — 장기·중기·단기가 모두 상방. 추세 추종이 유리한 국면\n' +
        '  ALIGNED_DOWN — 모두 하방\n' +
        '  MIXED        — 장기·중기는 한 방향인데 단기만 반대. 되돌림 국면일 가능성이 높다\n' +
        '                 (장기 상승 + 단기 눌림 = 매수 기회, 그 반대 = 매도 기회)\n' +
        '  CONFLICT     — 장기와 중기가 서로 반대. 방향을 잡기 가장 나쁜 국면이며 관망이 정답일 때가 많다'
    );
    parts.push('');
    parts.push(
      '세 축의 무효화 레벨을 비교해 어느 레벨이 먼저 시험받는지도 짚어라. ' +
        '큰 시간축의 무효화 레벨이 더 중요하다 — 그게 깨지면 작은 축의 판단은 전부 무의미해진다.'
    );
    parts.push('');
    parts.push(BRIEFING_RULE);
    parts.push('');
    parts.push(OUT_ALIGN);
    return parts.join('\n');
  }

  if (id === 'pilot') {
    parts.push('[시간축별 분석가 리포트]');
    parts.push(formatHorizonReports(context.horizonReports));
    parts.push('');
    parts.push('[정렬 판정관 결론]');
    parts.push(formatAlign(context.alignResult));
    parts.push('');
    parts.push('[각 시간축이 제시한 레벨]');
    parts.push(context.levels || '(없음)');
    parts.push('');
    parts.push(
      '너는 실행 설계관(PILOT)이다. 지금까지의 분석을 실제로 "어떻게 움직일지"로 옮기는 것이 임무다. ' +
        '분석을 반복하지 말고, 실행 가능한 계획만 내라.'
    );
    parts.push('');
    parts.push(
      '설계 원칙:\n' +
        '  · 진입·손절·목표는 반드시 위에 나온 레벨에서 가져와라. 새 숫자를 만들지 마라\n' +
        '  · 손절은 무효화 레벨 바깥에 둔다. 무효화 안쪽에 손절을 두면 정상 노이즈에 털린다\n' +
        '  · 어느 시간축을 거래하는지 명시하라 — 장기 분석으로 단기 진입을 설계하면 손절폭이 어긋난다\n' +
        '  · 정렬이 CONFLICT면 WAIT을 두려워하지 마라. 관망도 실행 계획이다\n' +
        '  · 손익비가 1:1.5 미만이면 진입 근거가 약하다는 뜻이다 — 그 사실을 밝혀라'
    );
    parts.push('');
    parts.push(BRIEFING_RULE);
    parts.push('');
    parts.push(OUT_PILOT);
    return parts.join('\n');
  }

  parts.push(BRIEFING_RULE);
  parts.push('');
  parts.push(`반드시 아래 JSON 하나만 출력하라:\n{${BUBBLE},${REPORT}}`);
  return parts.join('\n');
}

function formatHorizonReports(reports) {
  const r = reports || {};
  const order = [
    ['short', 'DASH(단기)'],
    ['mid', 'SWING(중기)'],
    ['long', 'TIDE(장기)'],
  ];
  const out = order
    .filter(([k]) => r[k])
    .map(([k, label]) => {
      const d = r[k];
      const meta = [
        d.bias ? `방향 ${d.bias}` : null,
        d.confidence != null ? `확신도 ${d.confidence}%` : null,
        d.invalidation ? `무효화 ${d.invalidation}` : null,
        d.waveChoice ? `파동 ${d.waveChoice}` : null,
      ].filter(Boolean).join(' · ');
      return `${label}\n  [${meta}]\n  ${d.report || d.bubble || ''}`;
    });
  return out.length ? out.join('\n\n') : '(없음)';
}

function formatAlign(a) {
  if (!a) return '(없음)';
  return [
    `정렬 상태: ${a.alignment || '-'}`,
    `큰 방향: ${a.primaryTrend || '-'}`,
    `단기 자세: ${a.tacticalBias || '-'}`,
    `유력 시나리오: ${a.scenario || '-'}`,
    `대안 시나리오: ${a.altScenario || '-'}`,
    `확신도: ${a.confidence != null ? a.confidence + '%' : '-'}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// claude 스폰 — 원본 trading-floor에서 검증된 로직을 그대로 가져왔다.
// 프로젝트 폴더에서 실행하면 "이 폴더를 신뢰합니까?" 게이트에 -p로는 답할 수
// 없어 출력이 통째로 비어버린다. 에이전트는 프롬프트를 stdin으로만 받으므로
// 작업 폴더가 필요 없다 → 이미 승인돼 있을 홈 디렉터리에서 실행한다.
// ---------------------------------------------------------------------------
const CLAUDE_CWD = require('node:os').homedir();

const CLAUDE_CANDIDATES = [
  path.join(CLAUDE_CWD, '.local', 'bin', 'claude.exe'),
  path.join(CLAUDE_CWD, '.local', 'bin', 'claude'),
  path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
  path.join(process.env.APPDATA || '', 'npm', 'claude'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
];

let claudeBin = null;

function quoted(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}

function resolveClaudeBin() {
  if (claudeBin) return claudeBin;
  for (const c of CLAUDE_CANDIDATES) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) { claudeBin = quoted(c); return claudeBin; }
    } catch { /* 무시 */ }
  }
  claudeBin = 'claude';
  return claudeBin;
}

function spawnClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn(`${resolveClaudeBin()} -p --model ${FLOOR_MODEL}`, { shell: true, cwd: CLAUDE_CWD });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 무시 */ }
      finish({ stdout, stderr, timedOut: true, code: null });
    }, SPAWN_TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err && err.message}`;
      finish({ stdout, stderr, code: null, error: err });
    });
    child.on('close', (code) => finish({ stdout, stderr, code }));

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      stderr += `\n[stdin error] ${err && err.message}`;
      finish({ stdout, stderr, code: null, error: err });
    }
  });
}

let claudeCheck = null;
const CHECK_TTL_MS = 5 * 60 * 1000;

function checkClaudeAvailable() {
  const now = Date.now();
  if (claudeCheck && now - claudeCheck.ts < CHECK_TTL_MS && claudeCheck.ok) {
    return Promise.resolve(claudeCheck);
  }
  return new Promise((resolve) => {
    const child = spawn(`${resolveClaudeBin()} --version`, { shell: true, cwd: CLAUDE_CWD });
    let out = '';
    let err = '';
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      claudeCheck = { ...res, ts: Date.now() };
      resolve(claudeCheck);
    };
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* 무시 */ }
      finish({ ok: false, message: 'claude 응답이 없습니다(15초 초과).' });
    }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => finish({ ok: false, message: 'claude 명령을 실행할 수 없습니다. PATH를 확인하세요.' }));
    child.on('close', (code) => {
      if (code === 0 && /\d+\.\d+/.test(out)) finish({ ok: true, message: out.trim() });
      else finish({
        ok: false,
        message: `claude 실행 실패(종료코드 ${code}). 시도한 경로: ${resolveClaudeBin()}` +
          (err.trim() ? ` [${err.trim().slice(0, 200)}]` : ''),
      });
    });
  });
}

function diagnose({ stdout, stderr, code, timedOut }) {
  const all = String(stderr || '') + '\n' + String(stdout || '');
  if (timedOut) return 'claude 응답이 180초를 넘겨 중단됐습니다.';
  if (/not recognized|command not found|ENOENT|찾을 수 없습니다/i.test(all)) {
    return 'claude 명령을 찾지 못했습니다. 설치 후 서버를 새 터미널에서 다시 켜세요.';
  }
  if (/login|log in|authenticat|Unauthorized|401|credit balance|api key/i.test(all)) {
    return 'claude 인증 문제입니다. 터미널에서 `claude` 실행 후 /login 하세요.';
  }
  if (/trust|신뢰|permission|권한/i.test(all)) {
    return '폴더 신뢰·권한 승인에서 막혔습니다.';
  }
  if (/rate limit|usage limit|quota|한도/i.test(all)) {
    return '사용량 한도에 걸린 것으로 보입니다.';
  }
  if (!String(stdout || '').trim()) {
    return `claude가 아무 응답도 내지 않았습니다(종료코드 ${code == null ? '없음' : code}).`;
  }
  return 'claude는 응답했지만 JSON 형식이 아니었습니다.';
}

function normalizeResult(parsed) {
  const out = { ...parsed };
  out.bubble = typeof parsed.bubble === 'string' && parsed.bubble.trim() ? parsed.bubble.trim() : '분석 완료';
  out.report = typeof parsed.report === 'string' ? parsed.report : '';
  return out;
}

async function runAgentReal(id, prompt) {
  let last = { stdout: '', stderr: '', code: null, timedOut: false };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await spawnClaude(prompt);
    last = res;
    if (res.stderr && res.stderr.trim()) console.error(`[agent:${id}] stderr: ${res.stderr.trim()}`);
    const parsed = extractJson(res.stdout || '');
    if (parsed) return normalizeResult(parsed);
    console.error(`[agent:${id}] 파싱 실패 (시도 ${attempt + 1}/2, 종료코드 ${res.code})`);
  }
  const detail = [
    `원인 추정: ${diagnose(last)}`,
    '',
    `종료코드: ${last.code == null ? '(없음)' : last.code}${last.timedOut ? ' · 타임아웃' : ''}`,
    `stderr: ${String(last.stderr || '(없음)').trim().slice(0, 600)}`,
    `stdout: ${String(last.stdout || '(없음)').trim().slice(0, 600)}`,
  ].join('\n');
  return { bubble: '분석 실패 — 말풍선을 클릭해 원인을 확인하세요', report: detail };
}

// ---------------------------------------------------------------------------
// 데모(mock) — claude 없이 화면 전체를 돌려보기 위한 고정 응답.
// 실제 지표 값을 일부 끼워 넣어 "데이터가 흐른다"는 감각은 유지한다.
// ---------------------------------------------------------------------------
function mockResult(id, context = {}) {
  const sym = context.display || context.symbol || '심볼';
  const px = context.price != null
    ? Number(context.price).toLocaleString('en-US', { maximumFractionDigits: 2 })
    : '-';

  const table = {
    short: {
      bubble: `${sym} 단기는 회귀채널 상단권입니다. 파동 후보는 하락 3파 진행을 가리키지만 정합도가 낮아 확정은 이릅니다.`,
      report: `${sym} 단기 시간축은 수렴 구조입니다. 스윙 고점은 낮아지는데 저점은 올라와 삼각수렴 형태가 잡히고 있고, 회귀채널 기준 현재 위치는 상단권입니다. RSI는 중립 구간이라 방향을 지지하지 않고, MACD 히스토그램은 축소 국면이라 직전 움직임의 동력이 빠지고 있습니다. 엘리어트 후보 중 정합도가 가장 높은 것은 하락 충격파 3파 진행이지만 확정 파동이 두 개뿐이라 근거가 얇습니다. 이 카운트는 2파 고점을 상향 돌파하는 순간 죽습니다. 반대 시나리오는 수렴 상단을 거래량과 함께 뚫고 올라가 상승 지속 구조로 전환되는 경우입니다. 지표들이 서로 확인해주지 않는 국면이라 단기 방향은 중립으로 둡니다. 판단이 바뀌는 지점은 수렴 상단 돌파와 직전 스윙 저점 이탈 두 개뿐이며, 그 전까지는 레인지 대응이 합리적입니다.`,
      bias: 'NEUTRAL',
      confidence: 45,
      waveChoice: 'A — 하락 3파 진행. 다만 확정 파동 2개뿐이라 신뢰도 낮음',
      support: '직전 스윙 저점',
      resistance: '수렴 상단 / 회귀채널 상단',
      invalidation: '2파 고점 상향 돌파 시 하락 카운트 폐기',
      agreement: '구조는 수렴, 오실레이터는 중립 — 지표가 서로 확인해주지 않음',
    },
    mid: {
      bubble: `${sym} 중기는 상승 구조가 살아 있습니다. 다만 RSI 과매수에 채널 상단이라 4파 조정 가능성이 큽니다.`,
      report: `${sym} 중기 시간축은 고점·저점이 모두 올라가는 명확한 상승 구조입니다. 20/60 골든크로스가 이미 발생했고 가격은 주요 이동평균 대부분의 위에 있습니다. 엘리어트 후보 A는 상승 충격파의 3파가 완성되고 4파 조정이 진행 중이라고 봅니다 — 2파 되돌림이 50% 부근으로 가이드라인에 잘 맞고 3파가 1파의 2배 이상 확장돼 충격파 구조로서 자연스럽습니다. 문제는 위치입니다. RSI가 과매수 구간이고 회귀채널 상단에 거의 닿아 있어 지금 신규 진입은 불리한 자리입니다. 4파 되돌림 목표는 23.6%와 38.2% 두 구간이며, 이 자리가 오히려 매수 기회가 될 수 있습니다. 이 카운트는 1파 고점 영역을 침범하는 순간 규칙 위반으로 죽습니다. 반대 시나리오는 조정 없이 5파로 곧장 연장되는 경우이고, 그때는 채널 상단 돌파가 먼저 나옵니다. 결론적으로 방향은 위지만 진입 타이밍은 지금이 아니라 조정 이후입니다.`,
      bias: 'UP',
      confidence: 68,
      waveChoice: 'A — 상승 충격파 4파 진행. 2파 되돌림 50%가 가이드라인에 부합',
      support: '4파 38.2% 되돌림 구간',
      resistance: '직전 3파 고점',
      invalidation: '1파 고점 영역 침범 시 카운트 무효(R3)',
      agreement: '구조·이평은 상방 일치, 위치(RSI 과매수·채널 94%)만 반대',
    },
    long: {
      bubble: `${sym} 장기는 아직 하락 구조입니다. 고점·저점이 계단식으로 낮아지는 흐름이 안 깨졌습니다.`,
      report: `${sym} 장기 시간축은 고점과 저점이 모두 낮아지는 하락 구조가 유지되고 있습니다. 회귀채널 기울기도 하방이라 큰 그림에서는 아직 하락 추세 안입니다. 다만 최근 반등폭이 상당해 채널 중단까지 올라와 있고, 강세 다이버전스가 관찰됩니다 — 가격은 저점을 낮췄는데 RSI는 저점을 높인 상태로, 하락 동력이 빠지고 있다는 신호입니다. 이것만으로 추세 전환을 확정할 수는 없습니다. 다이버전스는 전조일 뿐 타이밍을 주지 않기 때문입니다. 엘리어트 카운트는 유효한 후보가 잡히지 않았는데, 이는 현재 구조가 정형적인 충격파나 지그재그 어느 쪽에도 맞지 않는다는 뜻이며 대형 조정 국면일 때 흔히 나타납니다. 반대 시나리오는 직전 주요 고점을 종가로 회복해 하락 구조 자체가 깨지는 경우이고, 그러면 장기 판단을 상방으로 전환해야 합니다. 판단이 바뀌는 트리거는 직전 스윙 고점의 종가 회복 하나입니다. 그 전까지 장기는 하락 구조로 두되, 다이버전스 때문에 하방 베팅도 공격적으로 하지 않습니다.`,
      bias: 'DOWN',
      confidence: 52,
      waveChoice: '없음 — 유효 카운트 미검출. 비정형 조정 국면으로 해석',
      support: '직전 주요 저점',
      resistance: '직전 스윙 고점',
      invalidation: '직전 스윙 고점 종가 회복 시 하락 구조 소멸',
      agreement: '구조는 하방인데 다이버전스는 상방 — 동력 소진 국면',
    },
    align: {
      bubble: `장기 하락 · 중기 상승 · 단기 중립 — 상충입니다. 큰 축이 서로 반대라 방향 베팅이 가장 불리한 국면입니다.`,
      report: `세 시간축의 방향이 한쪽으로 모이지 않습니다. 장기는 여전히 하락 구조이고, 중기는 명확한 상승 구조이며, 단기는 수렴으로 방향이 없습니다. 이것은 MIXED가 아니라 CONFLICT입니다 — MIXED는 큰 축들이 같은 방향이고 작은 축만 되돌리는 상태를 말하는데, 여기서는 장기와 중기가 정면으로 반대이기 때문입니다. 이런 국면의 실질적 의미는 명확합니다. 중기 상승은 장기 하락 추세 안에서 벌어지는 반등일 가능성이 있고, 반대로 장기 하락 구조가 이제 막 깨지는 초입일 수도 있습니다. 두 해석 중 어느 쪽인지는 아직 가격이 답을 주지 않았습니다. 무효화 레벨을 비교하면 장기 쪽 레벨이 더 위에 있고 그것이 먼저 시험받습니다 — 장기 스윙 고점을 종가로 회복하면 중기 상승이 옳았던 것으로 정리되고, 반대로 중기 카운트의 무효화 레벨이 먼저 깨지면 장기 하락이 옳았던 것이 됩니다. 큰 시간축의 레벨이 더 무겁다는 원칙에 따라, 지금은 중기의 상승 논거만 보고 포지션을 키우면 안 됩니다. 유력 시나리오는 중기 4파 조정이 진행되며 장기 저항에서 한 번 밀리는 흐름입니다. 확신도를 낮게 두는 이유는 두 축이 반대라는 사실 자체가 불확실성의 크기이기 때문입니다.`,
      alignment: 'CONFLICT',
      primaryTrend: '장기 하락 구조 안에서 중기 반등이 진행 중 — 두 축이 정면으로 반대',
      tacticalBias: '방향 베팅 자제. 중기 조정 목표대까지 기다린 뒤 장기 레벨 반응을 보고 판단',
      scenario: `중기 4파 조정이 진행되며 장기 저항 부근에서 한 번 밀리는 흐름이 가장 유력합니다. 조정 목표대에서 지지가 확인되면 그때 중기 상승 논거가 강화됩니다.`,
      altScenario: `장기 스윙 고점을 종가로 회복하면 장기 하락 구조 자체가 소멸하고 정렬이 ALIGNED_UP으로 바뀝니다. 그 경우 추세 추종으로 전환해야 합니다.`,
      confidence: 41,
    },
    pilot: {
      bubble: `${sym} 현재가 ${px}에서는 관망입니다. 중기 조정 목표대까지 기다렸다가 진입 근거를 다시 봅니다.`,
      report: `정렬 판정이 CONFLICT이므로 지금 진입하는 계획은 만들지 않습니다. 관망도 실행 계획이며, 이 국면에서는 그것이 가장 기대값이 높은 선택입니다. 이유는 셋입니다. 첫째, 장기와 중기가 정면으로 반대라 어느 쪽으로 진입해도 큰 축 하나를 거스르게 됩니다. 둘째, 중기 분석가가 지적한 대로 현재 위치가 회귀채널 상단권이고 RSI가 과매수라 진입 자리로서 최악입니다. 셋째, 여기서 손절을 무효화 레벨 바깥에 두면 손절폭이 지나치게 벌어져 손익비가 1:1도 나오지 않습니다. 대신 조건부 계획을 세워둡니다 — 중기 4파 되돌림 목표대까지 눌린 뒤 그 자리에서 지지가 확인되면, 그때 중기 시간축을 거래 대상으로 삼아 진입합니다. 그 경우 손절은 중기 카운트의 무효화 레벨 바깥에 두고, 1차 목표는 직전 3파 고점으로 잡습니다. 반대로 조정 없이 채널 상단을 거래량과 함께 돌파하면 그것대로 정렬이 바뀐 것이므로 계획을 새로 짭니다. 판단을 바꾸는 트리거는 이 두 개이며, 둘 중 하나가 나오기 전까지는 포지션을 잡지 않습니다.`,
      action: 'WAIT',
      tradeHorizon: '중기',
      confidence: 62,
      entry: '중기 4파 되돌림 목표대에서 지지 확인 후 (현재가 추격 금지)',
      stop: '중기 카운트 무효화 레벨 바깥',
      target1: '직전 3파 고점',
      target2: '5파 연장 목표 (1파의 100%)',
      riskReward: '조건 충족 시 약 1:2.2 — 현재가 진입 시에는 1:0.8로 불리',
      sizing: '리스크 2% 룰 기준 계산 비중의 절반. 정렬이 CONFLICT인 동안은 풀사이징 금지',
      triggers: '① 조정 목표대 지지 확인 시 진입 ② 채널 상단 거래량 동반 돌파 시 계획 재수립',
      rationale: `장기와 중기가 정면으로 반대인 CONFLICT 국면이고, 현재 위치가 채널 상단·RSI 과매수라 진입 자리로서 불리합니다. 손절을 무효화 레벨 바깥에 두면 손익비가 1:1 미만이 되므로 조정을 기다리는 것이 합리적입니다.`,
    },
  };

  return { ...(table[id] || { bubble: '분석 완료', report: '' }) };
}

// ---------------------------------------------------------------------------
async function runAgent(id, context = {}, opts = {}) {
  const { mock = false } = opts || {};
  const meta = AGENT_BY_ID[id];
  if (!meta) throw new Error(`알 수 없는 에이전트 id: ${id}`);

  if (mock) {
    await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 700)));
    return mockResult(id, context);
  }
  return runAgentReal(id, buildPrompt(id, context));
}

module.exports = {
  AGENTS,
  AGENT_BY_ID,
  runAgent,
  buildPrompt,
  extractJson,
  checkClaudeAvailable,
  resolveClaudeBin,
};
