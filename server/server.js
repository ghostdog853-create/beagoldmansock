'use strict';

// WAVE FLOOR — HTTP 서버 (Node 내장 http, 외부 의존성 0)
// 라우트:
//   GET  /                정적 index.html
//   GET  /<static>        public/ 정적 파일 (html/css/js/png)
//   GET  /api/stream      SSE — 접속 시 engine.history replay 후 실시간 구독
//   POST /api/analyze     {symbol, demo} → engine.run 비동기 시작(202) / 진행 중이면 409 / 심볼 없으면 400
//   GET  /api/tape        fetchTape 결과 (서버 60초 캐시)

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { Engine } = require('./engine');
const { fetchTape } = require('./tape');

// 기본 8100. 원본 trading-floor(8000)와 겹치지 않게. PORT=8123 처럼 덮어쓸 수 있다.
const PORT = Number(process.env.PORT) || 8100;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TAPE_TTL_MS = 60 * 1000;
const BOARD_TTL_MS = 15 * 1000;
const PING_INTERVAL_MS = 25 * 1000;

const engine = new Engine();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
};

// ---- /api/tape 60초 캐시 ----
let tapeCache = null; // { ts, data }
async function getTape() {
  const now = Date.now();
  if (tapeCache && now - tapeCache.ts < TAPE_TTL_MS) return tapeCache.data;
  const data = await fetchTape();
  tapeCache = { ts: now, data };
  return data;
}

// ---- 유틸 ----
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---- SSE ----
function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const write = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // 1) 현재 히스토리 전부 replay
  for (const evt of engine.history) write(evt);

  // 2) 실시간 구독
  const onEvent = (evt) => write(evt);
  engine.on('event', onEvent);

  // 3) keep-alive 핑 (SSE 주석)
  const ping = setInterval(() => {
    res.write(':ping\n\n');
  }, PING_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(ping);
    engine.removeListener('event', onEvent);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

// ---- POST /api/analyze ----
async function handleAnalyze(req, res) {
  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return sendJson(res, 400, { error: '잘못된 요청 본문(JSON 파싱 실패).' });
  }

  const symbol = body && typeof body.symbol === 'string' ? body.symbol.trim() : '';
  if (!symbol) {
    return sendJson(res, 400, { error: '심볼(symbol)이 필요합니다.' });
  }
  if (engine.running) {
    return sendJson(res, 409, { error: '이미 분석이 진행 중입니다.' });
  }

  const mock = !!body.demo;
  const mode = ['full', 'swing', 'scalp'].includes(body.mode) ? body.mode : 'full';
  // 비동기로 실행 시작 후 즉시 202. 내부 오류는 run:error 이벤트로 방송된다.
  engine.run(symbol, { mock, mode }).catch((err) => {
    console.error('[engine] run 오류:', err && err.message ? err.message : err);
  });
  return sendJson(res, 202, { ok: true, symbol, mock, mode });
}

// ---- GET /api/tape ----
async function handleTape(res) {
  try {
    const data = await getTape();
    return sendJson(res, 200, data);
  } catch (err) {
    // 실패해도 캐시가 있으면 캐시를, 없으면 빈 배열을 반환한다.
    if (tapeCache) return sendJson(res, 200, tapeCache.data);
    console.error('[tape] 조회 실패:', err && err.message ? err.message : err);
    return sendJson(res, 200, []);
  }
}

// ---- GET /reports (목록) · /reports/<파일> (열람/다운로드) ----
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// --- 최소 ZIP 생성기 (무압축 store 방식, 외부 의존성 없음) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0xf) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

// entries: [{name, data(Buffer), mtime(Date)}] → 단일 ZIP Buffer
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime || new Date());
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 이름 플래그
    local.writeUInt16LE(0, 8);           // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // made by
    central.writeUInt16LE(20, 6);        // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs 전부 0
    central.writeUInt32LE(offset, 42);   // local header offset
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + e.data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, end]);
}

async function handleReportsZip(res) {
  let names = [];
  try {
    names = (await fsp.readdir(REPORTS_DIR)).filter(
      (n) => n.endsWith('.md') || n === 'decisions.json'
    );
  } catch (_) {}
  const entries = [];
  for (const n of names) {
    try {
      const full = path.join(REPORTS_DIR, n);
      const [data, stat] = await Promise.all([fsp.readFile(full), fsp.stat(full)]);
      entries.push({ name: n, data, mtime: stat.mtime });
    } catch (_) {}
  }
  const zip = buildZip(entries);
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2z(d.getMonth() + 1)}${pad2z(d.getDate())}`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': `attachment; filename=trading-floor-reports-${stamp}.zip`,
  });
  res.end(zip);
}

function pad2z(n) {
  return String(n).padStart(2, '0');
}

// ---- GET /project.zip — 새 PC 이식용 / 공유용 소스 번들 ----
// 포함: 소스·커맨드·문서. 제외: vendor 대용량(venv·클론), .git, node_modules,
//       그리고 남에게 넘어가면 안 되는 개인 데이터 — 분석 리포트(매매 판정 이력)와
//       .claude/settings.local.json(로컬 절대경로·권한 허용 목록).
const PROJECT_ROOT = path.join(__dirname, '..');
const BUNDLE_EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  path.join('vendor', 'ta-venv'),
  path.join('vendor', 'TradingAgents'),
]);

// 개인 데이터 — 번들에서 뺀다.
function isPrivateBundleFile(rel) {
  if (rel === '.claude/settings.local.json') return true;
  if (rel === '.env') return true;
  if (rel.startsWith('reports/') && (rel.endsWith('.md') || rel.endsWith('decisions.json'))) {
    return true;
  }
  return false;
}

async function collectBundleFiles(dir, relBase, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const relNorm = rel.split('/').join(path.sep);
    if (e.isDirectory()) {
      if (BUNDLE_EXCLUDE_DIRS.has(relNorm) || BUNDLE_EXCLUDE_DIRS.has(e.name)) continue;
      await collectBundleFiles(path.join(dir, e.name), rel, out);
    } else if (e.isFile()) {
      if (isPrivateBundleFile(rel)) continue;
      out.push(rel);
    }
  }
}

async function handleProjectZip(res) {
  const rels = [];
  await collectBundleFiles(PROJECT_ROOT, '', rels);
  const entries = [];
  for (const rel of rels) {
    try {
      const full = path.join(PROJECT_ROOT, rel);
      const [data, stat] = await Promise.all([fsp.readFile(full), fsp.stat(full)]);
      entries.push({ name: `trading-floor/${rel}`, data, mtime: stat.mtime });
    } catch (_) {}
  }
  const zip = buildZip(entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': 'attachment; filename=trading-floor-portable.zip',
  });
  res.end(zip);
}

async function handleReports(req, res, pathname, searchParams) {
  const rel = decodeURIComponent(pathname.replace(/^\/reports\/?/, ''));

  // 목록 페이지
  if (!rel) {
    let names = [];
    try {
      names = (await fsp.readdir(REPORTS_DIR))
        .filter((n) => n.endsWith('.md') || n === 'decisions.json')
        .sort()
        .reverse();
    } catch (_) {}
    const rows = names
      .map(
        (n) =>
          `<li><a href="/reports/${encodeURIComponent(n)}">${n}</a>` +
          ` <a class="dl" href="/reports/${encodeURIComponent(n)}?dl=1">[다운로드]</a></li>`
      )
      .join('\n');
    const html =
      '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
      '<title>리포트 — PIXEL TRADING FLOOR</title>' +
      '<style>body{background:#1a1a24;color:#eee;font-family:monospace;padding:24px}' +
      'a{color:#e8c84a}a.dl{color:#3fb950;text-decoration:none;margin-left:8px}' +
      'li{margin:6px 0}h1{font-size:18px;color:#e8c84a}' +
      '.zip{display:inline-block;background:#3fb950;color:#08160b;font-weight:bold;' +
      'padding:8px 14px;margin:8px 0 16px;text-decoration:none;border:2px solid #000;' +
      'box-shadow:3px 3px 0 #000}</style></head><body>' +
      `<h1>◆ 분석 리포트 (${names.length}건) ◆</h1>` +
      '<a class="zip" href="/reports/all.zip">⬇ 전체 다운로드 (.zip)</a>' +
      `<ul>${rows}</ul>` +
      '<p><a href="/">← 플로어로 돌아가기</a></p></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // 전체 ZIP
  if (rel === 'all.zip') {
    return handleReportsZip(res);
  }

  // 개별 파일 — 경로 탈출 방지 + 확장자 화이트리스트
  const target = path.normalize(path.join(REPORTS_DIR, rel));
  if (
    !target.startsWith(REPORTS_DIR) ||
    !(target.endsWith('.md') || target.endsWith('decisions.json'))
  ) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fsp.readFile(target);
    const isMd = target.endsWith('.md');
    const headers = {
      'Content-Type': isMd
        ? 'text/plain; charset=utf-8'
        : 'application/json; charset=utf-8',
      'Content-Length': data.length,
    };
    // ?dl=1 이면 저장 대화상자를 띄운다
    if (searchParams && searchParams.get('dl') === '1') {
      headers['Content-Disposition'] =
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
    }
    res.writeHead(200, headers);
    return res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
}

// ---- 정적 파일 ----
async function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 경로 탈출 방지
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ---- 라우터 ----
const server = http.createServer(async (req, res) => {
  let pathname = '/';
  let searchParams = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch (_) {
    pathname = req.url || '/';
  }

  try {
    if (req.method === 'GET' && pathname === '/api/stream') {
      return handleStream(req, res);
    }
    if (req.method === 'GET' && (pathname === '/reports' || pathname.startsWith('/reports/'))) {
      return await handleReports(req, res, pathname, searchParams);
    }
    if (req.method === 'GET' && pathname === '/project.zip') {
      return await handleProjectZip(res);
    }
    if (req.method === 'POST' && pathname === '/api/analyze') {
      return await handleAnalyze(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/tape') {
      return await handleTape(res);
    }
    if (req.method === 'GET') {
      return await handleStatic(req, res, pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
  } catch (err) {
    console.error('[server] 처리 오류:', err && err.message ? err.message : err);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 내부 오류.' });
    else res.end();
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('====================================');
  console.log('  ◆ PIXEL TRADING FLOOR ◆');
  console.log(`  서버 실행 중: ${url}`);
  console.log(`  데모 모드: ${url}/?demo=1`);
  console.log('  종료: Ctrl+C');
  console.log('====================================');
});

module.exports = { server, engine };
