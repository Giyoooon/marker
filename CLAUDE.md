# 마커 (marker)

친구들과 여행 갈 곳을 지도에 꽂아 두고, 순서를 정해 경로를 보는 웹 서비스.
설치·실행·API 형식은 README.md 참고. 이 문서는 작업할 때 알아야 할 맥락과 제약.

- 서비스: https://giyoooon.github.io/marker/
- API: https://marker-api.gygy97.workers.dev
- 저장소: https://github.com/Giyoooon/marker (main 에 바로 push)

## 지금 하는 것 (2026-10-26 기준)

한 화면, 마커 중심. 흐름은 **검색 → 마킹 → 고르기·분류 → 순서 정하기 → 경로**.

- 마킹: 카카오 장소 검색 결과의 "마킹" 버튼, 또는 지도 클릭(이름·분류 입력)
- 마커마다 분류(🏨숙소 🍽️맛집 ☕카페 📸명소 📌기타)와 경로 포함 체크박스. 검색으로 마킹하면 카카오 그룹 코드로 분류 자동 지정
- 체크를 끈 마커는 목록 아래 "경로에서 뺀 곳"에 따로 모임(번호·순서 없음). 다시 체크하면 경로 맨 끝에 붙음. 새로 마킹한 곳도 경로 맨 끝
  - `state.markers` 는 항상 [경로에 든 마커..., 뺀 마커...] 순서 (`partition`, `setOn`). 순서 바꾸기·끌어서 놓기는 경로 안에서만
- 목록 순서 = 방문 순서. 끌어서 놓기(PC) / ▲▼ 버튼(모바일)
- 숙소 출발·복귀(왕복): 경로에 숙소가 있으면 맨 위 출발지로 고정, 마지막에 숙소로 복귀
- 최단 순서로 정렬: 출발지(첫 마커 또는 숙소) 고정, 나머지 순서 최적화. 왕복이면 돌아오는 길 포함
- 경로선: 빨강(`#E8283C`) + 흰 테두리, 구간마다 도로를 따라 그림. 도로를 못 찾은 구간만 직선 점선
- 경로 위 흰 방향 화살표(화면 90px 간격, 지도 idle 때 다시 배치). 구간에 마우스를 올리거나(목록·지도) 누르면 그 구간만 강조, 누르면 고정+확대
- 구간마다 카카오맵 "길찾기" 버튼, 마커 팝업에 "여기로 길찾기"(내 위치 출발)
- 공유 링크(`#t=` 에 상태를 base64 로), 브라우저 localStorage(`marker-trip`) 저장

### 의도적으로 뺀 것 (사용자가 제거 요청)
자동 일정 짜기(며칠·활동 시간·고정 일정·가볼 곳), 지역 선택·추천 명소, 첫날 출발지·마지막날 도착지 설정, 탭 UI.
`/api/plan`, `/api/regions` 도 삭제함 (git 기록에 있음). 다시 넣자고 하기 전엔 되살리지 말 것.

### 아이디어만 나온 것 (미착수)
- API 호출 횟수 제한 (지금은 주소만 알면 누구나 호출 → 카카오 사용량 소모)
- 친구들끼리 가볼 곳 투표, 여럿이 같은 계획 동시 편집
- 명소 운영 시간 반영
- 맛집 핀(빨강)과 경로선(빨강) 색이 겹침 — 바꿀지 사용자에게 물어본 상태

## 구조

```
frontend/   정적 페이지, 빌드 없음 (index.html, style.css, map.js, app.js)
  map.js    카카오맵 SDK 래퍼(KMap). app.js 는 지도 API 를 직접 부르지 않고 이것만 씀
  app.js    상태·화면·이벤트. 경로 계산·검색은 전부 백엔드 호출
  config.js git 제외. 배포 때 GitHub Actions 가 저장소 Variables 로 생성
backend/    Cloudflare Worker (TypeScript)
  index.ts  라우터·CORS: /api/health, /api/search, /api/route
  route.ts  경로 계산 (순서 최적화, 왕복, 구간별 도로 경로·폴백)
  order.ts  방문 순서 최적화 (최근접 이웃 + 2-opt + or-opt, 순수 함수)
  matrix.ts 이동시간 행렬 (카카오 다중 목적지 / 직선거리 추정)
  kakao.ts  카카오 로컬·모빌리티 REST 래퍼
  geo.ts    거리·직선 추정 / validate.ts 입력 검증
```

## 명령

```bash
cd backend && npm test          # vitest
cd backend && npm run typecheck
cd backend && npm run dev       # http://localhost:8787 (키 없으면 추정값으로 동작)
npx http-server frontend -p 8080 -s -c-1
```

- 이 PC 는 Windows. Node 는 `C:\Program Files\nodejs` (Bash 에서는 `export PATH="/c/Program Files/nodejs:$PATH"` 필요할 수 있음)
- PowerShell 실행 정책 때문에 사용자 터미널에선 `npx`/`npm` 대신 `npx.cmd`/`npm.cmd`
- 프론트 수정 후엔 `node --check frontend/app.js` 로 문법 확인

## 배포 (자동)

`main` 에 push 하면 GitHub Actions 가 배포. **직접 `wrangler deploy` 하지 말 것** (권한 설정상 Claude 는 실제 서비스 배포 명령이 막혀 있음 — push 로 배포).

- `frontend/**` 변경 → `pages.yml` → GitHub Pages (Variables: `KAKAO_JS_KEY`, `API_BASE`)
- `backend/**` 변경 → `backend.yml` → typecheck·test 통과 시 Cloudflare Workers (Secrets: `CLOUDFLARE_API_TOKEN`)
- 루트 파일만 바꾸면 배포 안 됨
- `KAKAO_REST_KEY` 는 Cloudflare 시크릿. 배포해도 유지됨

### 배포 확인 방법
- GitHub API 를 비로그인으로 조회하면 **시간당 60회 한도**. 10초마다 폴링하다 한도를 다 쓴 적 있음 → 폴링은 30초 이상 간격, 또는 결과물을 직접 확인:
  - 프론트: `curl https://giyoooon.github.io/marker/app.js | grep <바뀐 문자열>`
  - 백엔드: `curl -X POST https://marker-api.gygy97.workers.dev/api/route ...`
- 화면 확인: 헤드리스 Edge(`msedge --headless=new --remote-debugging-port=...`) + CDP 스크립트로 조작·스크린샷. 끝나면 `Browser.close` 로 그 창만 닫기 (`taskkill /IM msedge.exe` 금지 — 사용자 브라우저까지 죽음)

## 제약사항

### 카카오
- 키 두 개: JS 키(지도, 도메인 제한이라 프론트에 노출 OK), REST 키(검색·길찾기, 백엔드에만). **키를 채팅·코드·로그에 남기지 말 것**
- 카카오 앱(`whereismyhome`)에서 카카오맵 사용 설정 ON, Web 도메인에 `https://giyoooon.github.io`, `http://localhost:8080` 등록돼 있어야 함
- 다중 경유지 길찾기: 경유지 30개 + 출발·도착 = **최대 32지점**. 왕복이면 출발지가 한 번 더 들어가서 마커는 **최대 31개** (프론트 `MAX_MARKERS`, 백엔드 `validate.ts`)
- 다중 경유지는 한 구간이라도 길이 없으면 **전체 실패** → 구간별 `/v1/directions` 로 폴백
- 다중 목적지(이동시간 행렬)는 출발지 **반경 10km** 안만 가능 → 먼 구간은 직선거리 추정
- **도보·대중교통 길찾기 API 없음**. 도보·대중교통도 자동차 도로 경로로 그리고, 시간은 도로 거리로 추정 (`route.ts` `legFromRoad`). 일방통행 때문에 도보 경로가 돌아가 보일 수 있음
- 너무 가까운(20m 이내) 연속 마커는 카카오가 거부 → "같은 자리"로 처리하고 조회에서 뺌

### Cloudflare Workers (무료 플랜)
- 요청 한 번에 외부 호출(subrequest) **50회 한도**. `route.ts` 의 `KAKAO_CALL_LIMIT`(48) 로 관리: 최단 정렬(마커 수만큼) + 다중 경유지 1 + 구간별 폴백. 한도 넘는 구간은 직선
- 검색 결과는 Cache API 로 하루 캐시 (지도 중심 좌표는 소수 2자리로 반올림해서 캐시 키에 사용)
- CORS 허용 출처는 `wrangler.toml` 의 `ALLOWED_ORIGINS`. 브라우저만 막을 뿐 API 자체는 공개 상태

### 프론트
- 빌드 도구·프레임워크 없음. 순수 HTML/CSS/JS 유지
- 상태 저장 형식(`serialize`/`fromSaved`)을 바꿀 땐 예전 저장값·공유 링크가 열리게 유지 (예전 `route` 필드, `cat`/`on` 없는 마커 → 기타·포함으로)
- 끌어서 놓기는 HTML5 DnD 라 모바일 브라우저에서 안 됨 → ▲▼ 버튼이 대안
- 경로 계산 중엔 선을 그리지 않음 (직선 깜빡임 방지)

## 디자인 규칙

- 주인공은 지도 위 분류 색 물방울 핀. 분류 색은 핀과 목록 왼쪽 띠에만, 나머지는 남색 잉크(`#1E2A44`)와 회청색으로 차분하게
- 분류 색: 숙소 `#3B5BDB`, 맛집 `#E03131`, 카페 `#B7791F`, 명소 `#2B8A3E`, 기타 `#7048E8` (app.js `CATS` 와 style.css 변수 둘 다)
- 글꼴은 Pretendard 하나. 숫자는 tabular-nums
- 피할 것: 크림 배경 + 주황 포인트, 대문자 라벨, 가운뎃점(·)으로 이은 메타 문자열, 모든 곳에 같은 카드·그림자
- 문구는 쉬운 존댓말, 버튼은 하는 일 그대로("마킹", "길찾기", "최단 순서로 정렬"). 오류는 무엇이 잘못됐고 어떻게 하면 되는지

## 작업 방식 (사용자 선호)

- 사용자는 한국어로 짧게 요청함. 답도 한국어로
- 기능 추가 후 직접 배포까지 하고, 실제 사이트에서 확인한 결과를 보고
- 범위가 크게 갈리는 결정(무엇을 지울지 등)은 선택지를 보여 주고 물어봄
- 커밋은 기능 단위로, 메시지는 영어
