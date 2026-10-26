# 마커 — 우리끼리 여행 경로 짜기

고정 일정(기차 도착, 식당 예약 등)과 가고 싶은 곳을 넣으면 날짜별 동선을 짜 주는 서비스.

```
frontend/  정적 웹 (카카오맵 JS SDK) → GitHub Pages
backend/   API (Cloudflare Workers, TypeScript) → 일정 최적화, 카카오 장소 검색, 카카오모빌리티 이동시간
```

## API (backend)

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 상태, 카카오 키 설정 여부 |
| GET | `/api/regions` | 지역별 추천 명소 |
| GET | `/api/search?q=&lat=&lng=` | 카카오 키워드 장소 검색 |
| POST | `/api/plan` | 일정 최적화 (요청/응답 형식: `backend/src/types.ts`) |

```bash
curl -X POST $API/api/plan -H 'Content-Type: application/json' -d '{
  "mode": "car",
  "days": [{ "start": "10:00", "end": "21:00", "from": { "name": "강릉역", "lat": 37.7638, "lng": 128.8997 } }],
  "fixed": [{ "id": "1", "name": "점심", "lat": 37.7905, "lng": 128.9135, "day": 1, "time": "12:30", "dur": 60 }],
  "spots": [{ "id": "a", "name": "오죽헌", "lat": 37.7792, "lng": 128.8786, "dur": 60, "must": true }]
}'
```

## 카카오 키

| 키 | 쓰는 곳 | 설정 위치 |
| --- | --- | --- |
| JavaScript 키 | 지도 표시 (프론트) | 로컬 `frontend/config.js`, 배포 시 GitHub 저장소 변수 `KAKAO_JS_KEY` |
| REST API 키 | 장소 검색·길찾기 (백엔드) | 로컬 `backend/.dev.vars`, 배포 시 `npx wrangler secret put KAKAO_REST_KEY` |

카카오 개발자 콘솔에서 할 일:
- 앱 > 플랫폼 > Web 사이트 도메인: `http://localhost:8080`, `https://giyoooon.github.io`
- 카카오맵 사용 설정 ON
- 카카오모빌리티 길찾기 API(다중 목적지, 다중 경유지)는 카카오모빌리티 개발자 사이트에서 같은 앱으로 사용 신청

## 로컬 실행

```bash
cd backend && npm install
echo KAKAO_REST_KEY=발급받은키 > .dev.vars
npm run dev                        # http://localhost:8787

cp frontend/config.example.js frontend/config.js   # KAKAO_JS_KEY 입력
npx http-server frontend -p 8080   # http://localhost:8080
```

테스트: `cd backend && npm test`

## 배포

백엔드 (자동): 저장소 Secrets 에 `CLOUDFLARE_API_TOKEN` 을 등록하면 `backend/` 변경을 push 할 때마다 테스트 후 배포됨.

백엔드 (수동):
```bash
cd backend
npx wrangler login
npx wrangler secret put KAKAO_REST_KEY
npm run deploy                     # https://marker-api.<계정>.workers.dev
```

프론트: 저장소 Settings > Pages > Source 를 **GitHub Actions** 로, Settings > Secrets and variables > Actions > **Variables** 에
`KAKAO_JS_KEY`, `API_BASE`(위 workers.dev 주소)를 등록하면 `main` 에 push 할 때마다 배포됨.
