'use strict';

// WAVE FLOOR — 분석 엔진
//
// 심볼 입력 → 멀티 타임프레임 캔들 수집 → 시간축별 지표·파동 계산
// → 단기·중기·장기 분석가 병렬 → 정렬 판정관 → 실행 설계관 → 리포트 저장.
//
// 모든 단계는 'event' 로 방송되고 history 에 누적돼 새 SSE 구독자에게 replay 된다.
// (분석 도중 새로고침해도 앞부분을 놓치지 않는다)

const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const tf = require('./timeframes');
const ind = require('./indicators');
const { AGENT_BY_ID, runAgent, checkClaudeAvailable } = require('./agents');
const { SOURCE_LABEL } = require('./indicators/confluence');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// 모드 = 어느 시간축을 돌릴지 고르는 선언적 표.
// 엔진 코드는 하나고 이 표만 바꾸면 새 모드가 생긴다.
const MODES = {
  full: { label: '전체', horizons: ['short', 'mid', 'long'], align: true, pilot: true },
  swing: { label: '스윙', horizons: ['mid', 'long'], align: true, pilot: true },
  scalp: { label: '단타', horizons: ['short', 'mid'], align: true, pilot: true },
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

function metaLabel(id) {
  const m = AGENT_BY_ID[id];
  if (!m) return id.toUpperCase();
  return m.role ? `${m.name} (${m.role})` : m.name;
}

class Engine extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.history = [];
    this.running = false;
  }

  _emit(evt) {
    this.history.push(evt);
    this.emit('event', evt);
  }

  _log(line, kind = 'sys') {
    if (!line) return;
    this._emit({ type: 'log', kind, line: String(line) });
  }

  async run(symbolInput, opts = {}) {
    if (this.running) {
      const err = new Error('이미 분석이 진행 중입니다.');
      err.code = 409;
      throw err;
    }
    this.running = true;
    this.history = [];

    const mock = !!opts.mock;
    const mode = MODES[opts.mode] ? opts.mode : 'full';
    const plan = MODES[mode];

    let resolved = null;
    let analyses = {};      // horizonId -> 지표 분석 결과
    const horizonReports = {}; // horizonId -> 에이전트 응답
    let alignResult = null;
    let pilotResult = null;

    try {
      resolved = tf.resolveSymbol(symbolInput);
      this._emit({
        type: 'run:start',
        symbol: resolved.symbol,
        display: resolved.display,
        mock,
        mode,
        modeLabel: plan.label,
        horizons: plan.horizons,
      });

      // 0) 실전 런이면 claude 가용성부터 확인 — 5명을 헛돌리지 않게
      if (!mock) {
        const chk = await checkClaudeAvailable();
        if (!chk.ok) {
          this._log('> claude 점검 실패', 'stage');
          throw new Error(
            'claude CLI를 사용할 수 없습니다. ' + chk.message +
            ' (데모 모드 ?demo=1 는 claude 없이 동작합니다)'
          );
        }
        this._log(`> claude 확인됨 (${chk.message})`);
      }

      // 1) 멀티 타임프레임 캔들 수집
      this._log(`> ${resolved.display} 멀티 타임프레임 수집 중...`);
      const byInterval = await tf.fetchAllTimeframes(resolved.symbol);
      const ticker = await tf.fetchTicker(resolved.symbol);
      const primaryCandles = byInterval['1d'] || byInterval['1h'];
      const price = primaryCandles[primaryCandles.length - 1].c;

      for (const iv of Object.keys(byInterval)) {
        this._log(`> ${iv} 캔들 ${byInterval[iv].length}개 수신`);
      }

      // 2) 시간축별 지표·파동 계산 (전부 코드가 끝낸다 — LLM은 해석만)
      this._log('── 지표 · 파동 계산 ──', 'stage');
      for (const id of plan.horizons) {
        analyses[id] = ind.analyzeHorizon(tf.HORIZONS[id], byInterval, resolved.symbol);
      }
      const alignRows = ind.alignmentSummary(plan.horizons.map((id) => analyses[id]));
      const alignTable = ind.renderAlignmentTable(alignRows);

      // 시간축마다 기준봉 캔들 + 작도를 전부 보낸다.
      // 화면에서 15분/30분/1시간/4시간/일봉/주봉을 눌러 전환할 수 있어야 하므로
      // 하나만 보내면 안 된다.
      const views = {};
      for (const id of plan.horizons) {
        const a = analyses[id];
        if (!a) continue;
        for (const iv of Object.keys(a.per)) {
          if (views[iv]) continue; // 1d는 중기·장기가 공유한다 — 먼저 온 것을 쓴다
          const per = a.per[iv];
          const cs = (byInterval[iv] || []).slice(-180);
          if (!cs.length) continue;
          views[iv] = {
            interval: iv,
            horizonId: id,
            horizonLabel: tf.HORIZONS[id].label,
            isPrimary: iv === a.primary,
            candles: cs.map((c) => ({ t: c.t, c: c.c })),
            overlay: this._buildOverlay(per, id, cs[0].t),
            construction: per.construction || null,
          };
        }
      }

      this._emit({
        type: 'market',
        display: resolved.display,
        symbol: resolved.symbol,
        price,
        ticker,
        alignRows,
        views,
        defaultView: analyses.mid ? '1d' : Object.keys(views)[0],
      });

      for (const line of alignTable.split('\n')) this._log(line);

      // 3) 시간축 분석가 병렬 — 서로의 결과가 필요 없으므로 동시에 돌린다
      this._log('── 시간축 분석 ──', 'stage');
      const tasks = plan.horizons.map(async (id) => {
        this._emit({ type: 'agent:start', id });
        const horizonBlock = ind.renderHorizon(analyses[id]);
        try {
          const res = await runAgent(
            id,
            { symbol: resolved.symbol, display: resolved.display, price, horizonBlock, mode },
            { mock }
          );
          this._emit({
            type: 'agent:done',
            id,
            bubble: res.bubble,
            report: res.report,
            bias: res.bias,
            confidence: res.confidence,
            invalidation: res.invalidation,
            waveChoice: res.waveChoice,
          });
          return { id, res };
        } catch (e) {
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id, bubble: '분석 실패', report });
          return { id, res: { bubble: '분석 실패', report } };
        }
      });

      for (const s of await Promise.allSettled(tasks)) {
        if (s.status === 'fulfilled' && s.value) horizonReports[s.value.id] = s.value.res;
      }

      // 4) 정렬 판정 — 세 축이 같은 방향인지가 이 프로젝트의 핵심 질문이다
      if (plan.align) {
        this._log('── 시간축 정렬 판정 ──', 'stage');
        this._emit({ type: 'agent:start', id: 'align' });
        try {
          const res = await runAgent(
            'align',
            { symbol: resolved.symbol, display: resolved.display, price, horizonReports, alignTable, mode },
            { mock }
          );
          alignResult = res;
          this._emit({
            type: 'agent:done',
            id: 'align',
            bubble: res.bubble,
            report: res.report,
            alignment: res.alignment,
            confidence: res.confidence,
          });
          this._emit({
            type: 'alignment',
            alignment: res.alignment,
            primaryTrend: res.primaryTrend,
            tacticalBias: res.tacticalBias,
            scenario: res.scenario,
            altScenario: res.altScenario,
            confidence: res.confidence,
          });
          this._log(`>>> 정렬 판정: ${res.alignment}`, 'stage');
        } catch (e) {
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id: 'align', bubble: '판정 실패', report });
        }
      }

      // 5) 실행 설계 — 분석을 "어떻게 움직일지"로 옮긴다
      if (plan.pilot) {
        this._log('── 실행 설계 ──', 'stage');
        this._emit({ type: 'agent:start', id: 'pilot' });
        const levels = plan.horizons
          .map((id) => {
            const r = horizonReports[id] || {};
            const h = tf.HORIZONS[id];
            return `${h.label}: 지지 ${r.support || '-'} · 저항 ${r.resistance || '-'} · 무효화 ${r.invalidation || '-'}`;
          })
          .join('\n');
        try {
          const res = await runAgent(
            'pilot',
            { symbol: resolved.symbol, display: resolved.display, price, horizonReports, alignResult, levels, mode },
            { mock }
          );
          pilotResult = res;
          this._emit({ type: 'agent:done', id: 'pilot', bubble: res.bubble, report: res.report });
          this._emit({
            type: 'decision',
            action: String(res.action || 'WAIT').toUpperCase(),
            tradeHorizon: res.tradeHorizon || '-',
            confidence: typeof res.confidence === 'number' ? res.confidence : Number(res.confidence) || 0,
            entry: res.entry || '-',
            stop: res.stop || '-',
            target1: res.target1 || '-',
            target2: res.target2 || '-',
            riskReward: res.riskReward || '-',
            sizing: res.sizing || '-',
            triggers: res.triggers || '-',
            rationale: res.rationale || '',
          });
          this._log(
            `>>> 실행 판정: ${String(res.action || 'WAIT').toUpperCase()} · ${res.tradeHorizon || '-'} 시간축 (${res.confidence || 0}%)`,
            'stage'
          );
        } catch (e) {
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id: 'pilot', bubble: '설계 실패', report });
        }
      }

      // 6) 저장
      const savedPath = await this._save({
        resolved, mode, mock, price, analyses, alignRows, alignTable,
        horizonReports, alignResult, pilotResult, plan,
      });
      this._emit({ type: 'saved', path: savedPath });
    } catch (err) {
      this._emit({ type: 'run:error', message: err && err.message ? err.message : String(err) });
    } finally {
      this._emit({ type: 'run:end' });
      this.running = false;
    }
  }

  // 차트 오버레이용 좌표 묶음.
  // 가격은 그대로 보내고 시간(t)만 넘긴다 — 프론트가 t로 x축 위치를 찾는다.
  // 인덱스를 보내면 서버·클라이언트의 캔들 슬라이스가 어긋날 때 전부 밀린다.
  _buildOverlay(a, horizonId, firstT) {
    const keep = (t) => t >= firstT;
    const out = { horizonId, interval: a.interval, pivots: [], waves: [], harmonics: [], zones: [], levels: [] };

    // 스윙 피벗 (지그재그 선)
    out.pivots = a.pivots
      .filter((p) => keep(p.t))
      .map((p) => ({ t: p.t, price: p.price, kind: p.kind, confirmed: p.confirmed }));

    // 최상위 파동 후보 — 파동 번호 라벨
    const top = a.wave && a.wave.candidates && a.wave.candidates[0];
    if (top) {
      const labels = top.type === 'impulse' ? ['0', '1', '2', '3', '4', '5'] : ['0', 'A', 'B', 'C'];
      out.waves = top.pivots.map((p, i) => ({ t: p.t, price: p.price, label: labels[i] || '' }));
      out.waveMeta = {
        dirLabel: top.dirLabel,
        stageName: top.stageName,
        score: top.score,
        invalidation: top.invalidation,
      };
      if (top.invalidation != null) {
        out.levels.push({ price: top.invalidation, label: '파동 무효화', kind: 'invalid' });
      }
      for (const t of top.targets || []) {
        out.levels.push({ price: t.price, label: t.label, kind: 'target' });
      }
    }

    // 하모닉 XABCD + PRZ
    for (const h of (a.harmonic && a.harmonic.patterns) || []) {
      const pts = ['X', 'A', 'B', 'C', 'D'].map((k) => ({
        t: h.points[k].t, price: h.points[k].price, label: k,
      }));
      out.harmonics.push({
        name: h.name,
        bullish: h.bullish,
        score: h.score,
        points: pts,
        prz: h.prz,
      });
      out.zones.push({
        low: h.prz.low, high: h.prz.high,
        label: `${h.name} PRZ`, kind: 'prz',
      });
    }

    // 근거 중첩 구간
    for (const c of (a.confluence && a.confluence.clusters) || []) {
      out.zones.push({
        low: c.low, high: c.high,
        label: `${c.distinct}중첩`,
        kind: c.distinct >= 3 ? 'confluence3' : 'confluence2',
        distinct: c.distinct,
      });
    }

    // 회귀채널 — 프론트가 봉 인덱스로 직선을 다시 그릴 수 있게 계수만 넘긴다
    const reg = a.channel && a.channel.regression;
    if (reg) {
      out.channel = { lookback: reg.lookback, a: reg.a, b: reg.b, k: reg.k, sd: reg.sd };
    }

    // 다이아고날 쐐기선 — 3대 조건 중 2개 이상 충족한 최상위 후보의 피벗으로
    // 1-3(-5)파 경계선과 2-4파 경계선을 긋는다. 새 계산 없이 이미 나온 피벗을 잇는다.
    const bestDiag = a.diagonal && a.diagonal.screens && a.diagonal.screens[0];
    if (bestDiag) {
      out.diagonal = {
        up: bestDiag.up,
        verdict: bestDiag.verdict,
        pivots: bestDiag.pivots.map((p) => ({ t: p.t, price: p.price, kind: p.kind })),
      };
    }

    // 진입 후보 — LLM 문장이 아니라 근거 중첩 1위 구간(3중첩 이상)을 그대로 쓴다.
    // "코드가 세고 LLM은 해석한다" 원칙: 진입가는 confluence.js가 이미 계산해둔 숫자다.
    const bestEntry = ((a.confluence && a.confluence.clusters) || []).find((c) => c.distinct >= 3);
    if (bestEntry) {
      const reason = bestEntry.sources.map((s) => SOURCE_LABEL[s] || s).join(' + ');
      out.entry = {
        low: bestEntry.low, high: bestEntry.high, mid: bestEntry.mid,
        side: bestEntry.side, distPct: bestEntry.distPct, distinct: bestEntry.distinct,
        reason,
      };
    }
    return out;
  }

  async _save(ctx) {
    const { resolved, mode, mock, price, analyses, alignTable, horizonReports, alignResult, pilotResult, plan } = ctx;
    await fsp.mkdir(REPORTS_DIR, { recursive: true });

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
    const hhmm = `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const file = `${dateStr}_${hhmm}_${resolved.display}_${mode}.md`;

    const L = [];
    L.push(`# ${resolved.display} — WAVE FLOOR 분석 리포트`);
    L.push('');
    L.push(`- 시각: ${now.toISOString()}`);
    L.push(`- 모드: ${plan.label} (${mode})${mock ? ' · 데모' : ''}`);
    L.push(`- 현재가: ${Number(price).toLocaleString('en-US', { maximumFractionDigits: 6 })}`);
    L.push('');
    L.push('## 시간축 정렬 요약 (코드 계산)');
    L.push('```');
    L.push(alignTable);
    L.push('```');
    L.push('');

    for (const id of plan.horizons) {
      const h = tf.HORIZONS[id];
      const r = horizonReports[id] || {};
      L.push(`## ${h.label} 시간축 — ${metaLabel(id)}`);
      L.push('');
      L.push(`**방향** ${r.bias || '-'} · **확신도** ${r.confidence != null ? r.confidence + '%' : '-'}`);
      L.push('');
      L.push(`- 파동 선택: ${r.waveChoice || '-'}`);
      L.push(`- 지지: ${r.support || '-'} / 저항: ${r.resistance || '-'}`);
      L.push(`- 무효화: ${r.invalidation || '-'}`);
      L.push(`- 지표 일치도: ${r.agreement || '-'}`);
      L.push('');
      L.push(r.report || '');
      L.push('');
      L.push('<details><summary>지표 원본</summary>');
      L.push('');
      L.push('```');
      L.push(ind.renderHorizon(analyses[id]));
      L.push('```');
      L.push('');
      L.push('</details>');
      L.push('');
    }

    if (alignResult) {
      L.push(`## 정렬 판정 — ${metaLabel('align')}`);
      L.push('');
      L.push(`**${alignResult.alignment || '-'}** · 확신도 ${alignResult.confidence != null ? alignResult.confidence + '%' : '-'}`);
      L.push('');
      L.push(`- 큰 방향: ${alignResult.primaryTrend || '-'}`);
      L.push(`- 단기 자세: ${alignResult.tacticalBias || '-'}`);
      L.push(`- 유력 시나리오: ${alignResult.scenario || '-'}`);
      L.push(`- 대안 시나리오: ${alignResult.altScenario || '-'}`);
      L.push('');
      L.push(alignResult.report || '');
      L.push('');
    }

    if (pilotResult) {
      L.push(`## 실행 계획 — ${metaLabel('pilot')}`);
      L.push('');
      L.push(`**${String(pilotResult.action || 'WAIT').toUpperCase()}** · ${pilotResult.tradeHorizon || '-'} 시간축 · 확신도 ${pilotResult.confidence || 0}%`);
      L.push('');
      L.push(`| 항목 | 값 |`);
      L.push(`|---|---|`);
      L.push(`| 진입 | ${pilotResult.entry || '-'} |`);
      L.push(`| 손절 | ${pilotResult.stop || '-'} |`);
      L.push(`| 1차 목표 | ${pilotResult.target1 || '-'} |`);
      L.push(`| 2차 목표 | ${pilotResult.target2 || '-'} |`);
      L.push(`| 손익비 | ${pilotResult.riskReward || '-'} |`);
      L.push(`| 비중 | ${pilotResult.sizing || '-'} |`);
      L.push(`| 트리거 | ${pilotResult.triggers || '-'} |`);
      L.push('');
      L.push(pilotResult.report || '');
      L.push('');
    }

    L.push('---');
    L.push('');
    L.push('*AI 시뮬레이션이며 투자 조언이 아닙니다. 거래소 주문 연동은 없습니다.*');

    const full = path.join(REPORTS_DIR, file);
    await fsp.writeFile(full, L.join('\n'), 'utf8');

    // 판정 누적 — 다음 런의 회고 재료
    try {
      const decFile = path.join(REPORTS_DIR, 'decisions.json');
      let arr = [];
      try {
        arr = JSON.parse(await fsp.readFile(decFile, 'utf8'));
        if (!Array.isArray(arr)) arr = [];
      } catch { /* 첫 실행 */ }
      arr.push({
        ts: now.toISOString(),
        symbol: resolved.display,
        mode,
        price,
        alignment: alignResult ? alignResult.alignment : null,
        action: pilotResult ? String(pilotResult.action || '').toUpperCase() : null,
        tradeHorizon: pilotResult ? pilotResult.tradeHorizon : null,
        confidence: pilotResult ? pilotResult.confidence : null,
        report: file,
      });
      await fsp.writeFile(decFile, JSON.stringify(arr.slice(-500), null, 2), 'utf8');
    } catch (e) {
      console.error('[engine] decisions.json 저장 실패:', e && e.message);
    }

    return file;
  }
}

module.exports = { Engine, MODES };
