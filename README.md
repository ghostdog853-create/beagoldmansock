# WAVE FLOOR

지표와 **글렌 닐리(Glenn Neely)의 NEoWave**를 기반으로 단기·중기·장기 세 시간축을
각각 분석하고, 그 셋이 같은 방향인지 판정한 뒤 실행 계획으로 옮기는 픽셀아트 로컬 웹앱.

AI 에이전트(DASH/SWING/TIDE → PRISM → PILOT)가 시장을 분석·토론해 매매 판정을 내리는
**분석·시뮬레이션 도구**이며, 거래소 주문 연동은 없다.

## 실행

```bash
node server/server.js          # http://localhost:8100
```

- 포트 충돌 시: `PORT=8123 node server/server.js`
- Windows: `start-wave.cmd` 더블클릭
- 의존성 설치 불필요 — `package.json`에 dependencies가 없고 Node 내장 모듈만 사용 (Node 20+)

### 데모 모드 — `claude` CLI 없이 화면만 보고 싶을 때

```
http://localhost:8100/?demo=1
```

고정 목업 응답으로 에이전트 7명·토론·판정·리포트 저장까지 전 과정을 볼 수 있다.
실전 모드는 `claude` CLI가 PATH에 있고 로그인돼 있어야 한다(에이전트마다 `claude -p` 스폰).

## 사용법

1. 상단에 심볼 입력 — `BTC`, `ETH`, `TSLA`, `하이닉스`, `삼성전자`, `005930` …
2. 모드 선택
   - **알고리즘(전체)** — 애널리스트 3인(단기·중기·장기) → PRISM 정렬 판정 → PILOT 실행 설계
   - **스윙** — 중기·장기만
   - **스캘핑(단타)** — 단기·중기만
3. **▶ ANALYZE**

결과는 `reports/`에 마크다운으로 쌓이고 브라우저 `/reports`에서도 볼 수 있다.

### 테스트

```bash
npm test
```

## 구조

```
server/
  server.js          HTTP 라우팅 · SSE · 리포트 열람/ZIP
  engine.js          모드별 파이프라인 오케스트레이션 → 이벤트 방송 → 리포트 저장
  agents.js          역할별 프롬프트 빌더 · claude 스폰 · 데모 목업
  timeframes.js      멀티 타임프레임 캔들 수집(바이낸스) · 시간축 정의
  indicators/         피벗 · 파동(닐리/고전 엘리어트) · 하모닉 · 채널 · 다이아고날 · 근거중첩 등
public/              단일 페이지 프론트 (캔버스 스프라이트 + DOM, 빌드 도구 없음)
docs/파동분석-통합본.md   파동 이론 구현 명세 — 파동 관련 작업 전 필독
reports/             런마다 마크다운 리포트 + decisions.json 누적
```

자세한 설계 원칙과 작업 규칙은 [`CLAUDE.md`](CLAUDE.md)에 있다.

## ⚠ 읽고 쓰세요

- **AI 시뮬레이션이며 투자 조언이 아닙니다.** 판정을 그대로 따라 매매하지 마세요
- **거래소 연동·자동 주문 기능은 없습니다.**
- 20배 레버리지 판정이 나와도 -5% 역행 한 번에 증거금 전액이 청산됩니다
