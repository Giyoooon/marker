# 마커 — 같이 꽂자

친구들과 여행 갈 곳을 지도에 꽂아 두고, 순서를 정해 경로를 보는 웹 서비스. 혼자 쓰는 **내 지도**와, 4자리 번호로 여럿이 같이 쓰는 **공유 지도**가 있음.
설치·실행·API 형식은 README.md. 이 문서는 작업할 때 알아야 할 맥락과 제약.

- 서비스: https://giyoooon.github.io/marker/
- API: https://marker-api.gygy97.workers.dev
- 저장소: https://github.com/Giyoooon/marker (main 에 바로 push)

## 화면과 흐름 (2026-10-27 기준)

### 첫 화면
`?map=` 없이 들어오고 `#t=` 링크도 아니면, 뒤를 어둡게 가린 창이 바로 뜸 (`Room.openLanding`, 지도 로딩을 기다리지 않음).
- 번호 입력 상자(영문 대문자·숫자만, 소문자는 자동 대문자) + 아래 버튼 [그냥할래요] [새로 만들기] [같이하기]
- **그냥할래요**·Esc → 창 닫고 내 지도
- **새로 만들기** → 같은 창에서 제목·내 닉네임 단계([뒤로] [만들기], "지금 내 마커 n개도 같이 올리기" 체크) → 만들어지면 `?map=번호` 로 이동
- **같이하기** → 번호가 있는지 서버에 먼저 확인 → 없으면 상자 아래에 안내, 있으면 `?map=번호`
- 왼쪽 위 "같이 꽂기" 버튼으로 이 창을 다시 열 수 있음 (공유 지도 안에서는 숨김)

### 대화창 공통 (`room.js` `openDialog`)
- 입력 칸에서 **Enter = 그 창의 주 버튼** (`[data-enter]`, 없으면 `button.primary`). 브라우저 기본 동작이면 맨 앞 버튼(뒤로·그냥할래요)이 눌리므로 막아 둠
- 한글 조합 중 Enter(`isComposing`, keyCode 229)는 무시
- 단계만 바꿀 땐 창을 닫지 않고 내용만 바꿈. 서버 호출은 10초 타임아웃("서버가 응답하지 않아요")

### 지도 화면 (내 지도·공유 지도 공통)
흐름: **검색 → 마킹 → 고르기·분류 → 순서 정하기 → 경로**
- 마킹: 카카오 장소 검색 결과의 "마킹" 버튼, 또는 지도 클릭(이름·분류 입력). 같은 자리(소수 5자리) 중복 불가
- 분류(🏨숙소 🍽️맛집 ☕카페 📸명소 📌기타). 검색으로 마킹하면 카카오 그룹 코드로 자동 지정. 목록에서 아이콘을 눌러 바꿈, 위쪽 칩으로 분류별 보기
- 경로 포함 체크박스: 끄면 목록 아래 "경로에서 뺀 곳"(사이드바 맨 아래)에 모임(번호·순서 없음), 다시 켜면 경로 맨 끝. 새로 마킹한 곳도 경로 맨 끝
  - `state.markers` 는 항상 [경로에 든 마커..., 뺀 마커...] 순서 (`partition`, `setOn`). 순서 바꾸기·끌어서 놓기는 경로 안에서만
- 목록 순서 = 방문 순서. 끌어서 놓기(PC) / ▲▼(모바일)
- 숙소 출발·복귀(왕복): 경로에 숙소가 있으면 맨 위 출발지로 고정, 마지막에 숙소로 복귀
- 최단 순서로 정렬: 출발지(첫 마커 또는 숙소) 고정, 나머지 최적화. 왕복이면 돌아오는 길 포함
- 경로선: 빨강(`#E8283C`) + 흰 테두리, 구간마다 도로를 따라 그림. 도로를 못 찾은 구간만 직선 점선. 계산 중엔 선을 그리지 않음
- 구간에 마우스를 올리거나(목록·지도) 누르면 그 구간만 강조, 누르면 고정+확대
- 방향 화살표는 가시성이 나빠 꺼 둠 (app.js `renderRouteLines` 에서 주석 처리, `KMap.arrows`·`.arrow` 는 남아 있음)
- 구간마다 카카오맵 "길찾기", 마커 팝업에 "여기로 길찾기"(내 위치 출발)
- 페이지 제목 "마커-같이 꽂자", 파비콘 `frontend/favicon.svg` = 로고(남색 물방울 핀)

### 내 지도
- 브라우저 localStorage(`marker-trip`)에 저장. 공유 링크는 `#t=` 에 상태를 base64 로
- 공유 지도에 있는 동안은 내 지도를 저장하지 않음. "내 지도로" 누르면 원래 내 지도

### 공유 지도
- 번호 `[A-Z0-9]{4}`, 링크 `?map=번호`. 위쪽 막대: 번호·제목(눌러서 바꾸기)·활동·내 지도로, 내 닉네임과 다른 사람들(접속 중이면 초록 점, 아니면 흐리게), "구경 n명"
- **번호 공유 창** (`Room.openShare`): 큰 번호 4칸 + 링크 + [번호 복사] [링크 복사] [시작하기/닫기]
  - 방금 만든 지도면 들어가자마자 "공유 지도를 만들었어요"로 뜸 (sessionStorage `marker-created`)
  - 이때만 아래에 **다시할래요** → 공유 지도에서 나와 첫 화면으로 (`leave()`). 만든 지도는 서버에 남음(삭제 기능 없음)
  - 위쪽 번호, 아래 "공유" 버튼으로도 열림 (이땐 다시할래요 없음)
- **닉네임**: 로그인 없음. 그 기기에 기억(localStorage `marker-me-<번호>`). 닉네임 없으면 구경만(마킹 막힘)
  - 닉네임 창: 이 기기에서 쓰던 이름(`marker-nicknames`, 최근 5개)이 그 지도에 있으면 맨 위 "○○로 계속하기", 지도의 다른 이름은 버튼(누르면 그 사람으로), 새 이름 칸엔 이 기기의 안 쓴 최근 이름을 미리 채움
  - 이미 있는 이름을 새로 입력하면 "그 사람으로 들어갈까요?" 확인
- **누가 했는지**: 마커마다 마킹한 사람(첫 글자 동그라미, 사람마다 색). 팝업에 "○○ 님이 마킹", "○○ 님이 마지막으로 바꿈"
- **실시간**: 지도 번호마다 Durable Object `MapRoom` 하나(backend/src/room.ts). `GET /api/maps/:code/ws?memberId=` 로 웹소켓 접속
  - 접속·종료 때 접속자 목록(presence: 접속 중 닉네임, 구경 수)을 모두에게 보냄
  - 바꾸는 API 는 응답과 함께 ChangeEvent 를 방에 보내고(`ctx.waitUntil`), 방이 모두에게 전달
  - 다른 사람 변경 → 토스트(예: "민수 님이 📸 '김광석길'을 마킹했어요", 조사는 `josa()` 로 받침 처리) + 활동 기록(위쪽 "활동", 안 읽은 수) + 바뀐 행 노랗게 반짝임 → 서버 상태로 다시 맞춤. 들어옴/나감도 기록
  - 활동 기록은 이 화면을 연 뒤의 것만(메모리), 새로고침하면 비워짐
  - 웹소켓이 끊기면 1·2·4…30초 간격 재연결, 그동안 8초 폴링. 붙어 있어도 30초마다 한 번 맞춤
- 쓰기: 화면을 먼저 바꾸고 서버에 보낸 뒤 서버 상태로 다시 맞춤(`Room.write` → `refresh(true)`). 동시 수정은 나중 것이 이김. 이동수단·숙소 왕복도 지도 설정으로 공유

## 의도적으로 뺀 것 (사용자가 제거 요청)
자동 일정 짜기(며칠·활동 시간·고정 일정·가볼 곳), 지역 선택·추천 명소, 첫날 출발지·마지막날 도착지 설정, 탭 UI, 방향 화살표(꺼 둠).
`/api/plan`, `/api/regions` 도 삭제함 (git 기록에 있음). 다시 넣자고 하기 전엔 되살리지 말 것.

## 아이디어만 나온 것 (미착수)
- 공유 지도 삭제 (지금은 "다시할래요"로 나가도 만든 지도가 남음), 나가기, 닉네임 바꾸기
- 닉네임 보호 (지금은 번호만 알면 누구 닉네임으로든 들어갈 수 있음)
- API 호출 횟수 제한 (주소만 알면 누구나 호출 → 카카오 사용량 소모)
- 친구들끼리 가볼 곳 투표, 명소 운영 시간 반영
- 맛집 핀(빨강)과 경로선(빨강) 색이 겹침 — 바꿀지 사용자에게 물어본 상태

## 구조

```
frontend/   정적 페이지, 빌드 없음
  index.html  화면 뼈대 (#dlg 대화창 하나를 모든 창이 같이 씀)
  map.js      카카오맵 SDK 래퍼(KMap). app.js·room.js 는 지도 API 를 직접 부르지 않고 이것만 씀
  room.js     공유 지도(Room): 첫 화면·번호 공유·닉네임·웹소켓(접속자, 변경 알림)·서버 동기화
  app.js      상태·목록·경로·이벤트. 데이터가 바뀌는 지점마다 Room.* 를 부름. 경로 계산·검색은 백엔드
  style.css   (디자인 규칙 아래 참고)
  config.js   git 제외. 배포 때 GitHub Actions 가 저장소 Variables 로 생성
backend/    Cloudflare Worker (TypeScript)
  index.ts    라우터·CORS: /api/health, /api/search, /api/route, /api/maps...
  shared.ts   공유 지도 API (D1). 맨 위 주석에 엔드포인트 목록. 바꾸는 함수는 { ..., event } 를 돌려줌
  room.ts     지도 방 Durable Object (웹소켓 Hibernation API). presenceOf 는 순수 함수
  route.ts    경로 계산 (순서 최적화, 왕복, 구간별 도로 경로·폴백)
  order.ts    방문 순서 최적화 (최근접 이웃 + 2-opt + or-opt, 순수 함수)
  matrix.ts   이동시간 행렬 (카카오 다중 목적지 / 직선거리 추정)
  kakao.ts    카카오 로컬·모빌리티 REST 래퍼
  geo.ts / validate.ts  거리·직선 추정 / 경로 요청 검증
  migrations/ D1 스키마 (0001 공유 지도, 0002 markers.updated_by)
  test/       vitest. fake-d1.ts(Node 내장 SQLite 에 실제 마이그레이션 적용), cloudflare-workers-stub.ts
```

## 명령

```bash
cd backend && npm test          # vitest (45개)
cd backend && npm run typecheck
cd backend && npx wrangler d1 migrations apply marker --local   # 로컬 DB 준비
cd backend && npm run dev       # http://localhost:8787 (카카오 키 없으면 추정값으로 동작)
npx http-server frontend -p 8080 -s -c-1
node --check frontend/app.js    # 프론트는 빌드가 없으니 문법 확인은 이걸로
```

- 이 PC 는 Windows. Node 는 `C:\Program Files\nodejs` (Bash 에서는 `export PATH="/c/Program Files/nodejs:$PATH"`)
- PowerShell 실행 정책 때문에 사용자 터미널에선 `npx`/`npm` 대신 `npx.cmd`/`npm.cmd`
- **로컬 포트 문제**: 8787/8080 에 예전 개발 서버 소켓이 남아 응답이 멈추는 일이 잦음 → 안 쓴 포트로 띄우기
  (`npx wrangler dev --port 8796 --var ALLOWED_ORIGINS:http://localhost:8097`, `http-server -p 8097`), config.js 의 API_BASE 를 잠깐 바꿔서 테스트하고 끝나면 되돌리기. 끝나면 그 포트의 프로세스만 종료

## 배포 (자동)

`main` 에 push 하면 GitHub Actions 가 배포. **직접 `wrangler deploy` 하지 말 것** (권한 설정상 Claude 는 실제 서비스 배포 명령이 막혀 있음 — push 로 배포).

- `frontend/**` → `pages.yml` → GitHub Pages (Variables: `KAKAO_JS_KEY`, `API_BASE`)
- `backend/**` → `backend.yml` → typecheck·test → D1 마이그레이션(`--remote`) → Cloudflare Workers (Secrets: `CLOUDFLARE_API_TOKEN`)
  - 토큰에 **Workers 편집 + D1 편집** 권한 필요 (Edit Cloudflare Workers 템플릿엔 D1 이 없어서 추가함)
- 루트 파일(CLAUDE.md, README.md 등)만 바꾸면 배포 안 됨
- `KAKAO_REST_KEY` 는 Cloudflare 시크릿. 배포해도 유지됨
- Pages 배포가 GitHub 쪽 오류로 실패하면 **같은 실행 Re-run 은 또 실패**함("Multiple artifacts named github-pages") → 새 커밋으로 새 실행을 만들어야 함

### 배포 확인
- GitHub API 비로그인 조회는 **시간당 60회 한도** (한 번 다 쓴 적 있음) → 30초 이상 간격, 또는 결과물을 직접 확인:
  - 프론트: `curl "https://giyoooon.github.io/marker/room.js?$(date +%s)" | grep <바뀐 문자열>`
  - 백엔드: 새 응답이 나오는지 (예: `curl https://marker-api.gygy97.workers.dev/api/maps/ZZZZ/ws` → 426)
- 화면 확인: 헤드리스 Edge(`msedge --headless=new --remote-debugging-port=...`) + CDP 스크립트. 두 사람은 `Target.createBrowserContext` 로 컨텍스트를 나눠서. 끝나면 `Browser.close` 로 그 창만 닫기 (`taskkill /IM msedge.exe` 금지 — 사용자 브라우저까지 죽음)
- 실제 사이트에서 테스트로 만든 공유 지도는 제목에 `[테스트]` 를 붙이고, 끝나면 지움:
  `npx wrangler d1 execute marker --remote --command "DELETE FROM maps WHERE code = 'XXXX'"` (members·markers 는 CASCADE)

## 제약사항

### 카카오
- 키 두 개: JS 키(지도, 도메인 제한이라 프론트에 노출 OK), REST 키(검색·길찾기, 백엔드에만). **키를 채팅·코드·로그에 남기지 말 것**
- 카카오 앱(`whereismyhome`): 카카오맵 사용 설정 ON, Web 도메인 `https://giyoooon.github.io`, `http://localhost:8080` 등록. 다른 로컬 포트에선 지도가 안 뜸(목록·API 는 확인 가능)
- 다중 경유지 길찾기: 경유지 30 + 출발·도착 = **최대 32지점**. 왕복이면 출발지가 한 번 더 들어가서 마커는 **최대 31개** (프론트 `MAX_MARKERS`, 백엔드 `validate.ts`·`shared.ts`)
- 다중 경유지는 한 구간이라도 길이 없으면 **전체 실패** → 구간별 `/v1/directions` 로 폴백
- 다중 목적지(이동시간 행렬)는 출발지 **반경 10km** 안만 → 먼 구간은 직선거리 추정
- **도보·대중교통 길찾기 API 없음** → 자동차 도로 경로로 그리고 시간은 도로 거리로 추정(`route.ts` `legFromRoad`). 일방통행 때문에 돌아가 보일 수 있음
- 너무 가까운(20m 이내) 연속 마커는 카카오가 거부 → "같은 자리"로 처리하고 조회에서 뺌

### Cloudflare Workers (무료 플랜)
- 요청 한 번에 외부 호출(subrequest) **50회 한도**. `route.ts` 의 `KAKAO_CALL_LIMIT`(48) 로 관리. 한도 넘는 구간은 직선
- 검색 결과는 Cache API 로 하루 캐시 (지도 중심 좌표는 소수 2자리로 반올림해서 캐시 키에)
- CORS 허용 출처는 `wrangler.toml` 의 `ALLOWED_ORIGINS`. 브라우저만 막을 뿐 API 자체는 공개

### D1 (공유 지도 DB)
- DB `marker`, 바인딩 `DB`. 스키마는 `backend/migrations/` — **이미 적용된 마이그레이션은 고치지 말고 새 번호 파일로 추가**
- **모든 테이블에 `created_at`·`updated_at`** (UTC ISO, 밀리초). `updated_at` 은 트리거가 갱신. 마커·닉네임이 바뀌면 지도 `updated_at` 도 갱신(클라이언트 변경 감지용)
- 테이블: `maps`(번호·제목·이동수단·왕복), `members`(지도별 닉네임, 지도 안에서 중복 불가), `markers`(마킹한 사람 `marked_by`, 마지막으로 바꾼 사람 `updated_by`, 분류, 경로 포함, 순서)
- 지도 번호는 DB CHECK 로도 `[A-Z0-9]{4}` 강제. 생성 시 겹치면 최대 10번 다시 뽑음
- 같은 지도 같은 좌표(소수 5자리) 중복 금지(UNIQUE), 지도당 마커 31개
- 사람(members)이 지워져도 마커는 남고 `marked_by`·`updated_by` 는 NULL
- **바꾸는 요청은 모두 `memberId` 필수** (마킹, PATCH, PUT, DELETE 는 `?memberId=`) — 누가 했는지 알리고 기록

### Durable Objects (지도 방)
- 바인딩 `ROOMS`, 클래스 `MapRoom`. 무료 플랜이라 `new_sqlite_classes` 로 선언(wrangler.toml `[[migrations]]`). 클래스 이름을 바꾸거나 지울 땐 새 태그 필요
- 웹소켓 응답(101)은 index.ts 에서 CORS 헤더로 다시 감싸지 않고 그대로 돌려줌 (감싸면 연결이 끊김)
- 웹소켓 접속은 `ALLOWED_ORIGINS` 출처만. memberId 는 Worker 가 D1 에서 확인한 뒤 닉네임과 함께 방에 넘김 (모르는 id 면 구경)
- 웹소켓 메시지로는 아무것도 바꾸지 않음(ping 만). 변경은 반드시 HTTP API 로
- 테스트는 `cloudflare:workers` 를 stub 으로 바꿔서 Node 에서 (vitest.config.ts alias). 실제 웹소켓은 `wrangler dev` 로 확인

### 프론트
- 빌드 도구·프레임워크 없음. 순수 HTML/CSS/JS 유지 (room.js 가 app.js 보다 먼저 로드, 서로의 전역을 호출 시점에 씀)
- 저장 형식(`serialize`/`fromSaved`)을 바꿀 땐 예전 저장값·공유 링크가 열리게 유지 (예전 `route` 필드, `cat`/`on` 없는 마커 → 기타·포함으로)
- 끌어서 놓기는 HTML5 DnD 라 모바일 브라우저에서 안 됨 → ▲▼ 버튼이 대안

## 디자인 규칙

- 주인공은 지도 위 분류 색 물방울 핀. 분류 색은 핀과 목록 왼쪽 띠에만, 나머지는 남색 잉크(`#1E2A44`)와 회청색으로 차분하게
- 분류 색: 숙소 `#3B5BDB`, 맛집 `#E03131`, 카페 `#B7791F`, 명소 `#2B8A3E`, 기타 `#7048E8` (app.js `CATS` 와 style.css 변수 둘 다)
- 대화창: 뒤 어둡게+살짝 흐리게, 가운데 정렬 첫 화면/번호 창은 남색 핀 + 제목 + 큰 입력/번호, 아래 버튼 같은 폭으로 한 줄(주 버튼 남색, 오른쪽 끝)
- 글꼴은 Pretendard 하나. 숫자는 tabular-nums. 한글 줄바꿈은 `word-break: keep-all`
- 피할 것: 크림 배경 + 주황 포인트, 대문자 라벨, 가운뎃점(·)으로 이은 메타 문자열, 모든 곳에 같은 카드·그림자
- 문구는 쉬운 존댓말, 버튼은 하는 일 그대로("마킹", "길찾기", "같이하기", "다시할래요"). 오류는 무엇이 잘못됐고 어떻게 하면 되는지

## 작업 방식 (사용자 선호)

- 사용자는 한국어로 짧게 요청함. 답도 한국어로
- 기능 추가 후 직접 배포까지 하고, 실제 사이트에서 확인한 결과를 보고 (테스트 데이터는 지우기)
- 범위가 크게 갈리는 결정(무엇을 지울지, 규칙 해석 등)은 선택지를 보여 주고 물어봄
- 커밋은 기능 단위로, 메시지는 영어
