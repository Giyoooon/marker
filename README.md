# 📍 마커 — 찍고, 순서 정하고, 경로 보기

장소를 검색하거나 지도를 클릭해서 마킹하고(숙소·맛집·카페·명소·기타로 분류, 체크로 경로 포함 여부 선택), 끌어서 놓기나 ▲▼ 버튼으로 순서를 정하면
그 순서대로 지도에 경로를 그려 줌. **✨ 최단 순서로 정렬**은 첫 마커를 출발지로 두고 나머지를 이동시간이 가장 짧은 순서로 바꿈.

```
frontend/  정적 웹 (카카오맵 JS SDK) → GitHub Pages
backend/   API (Cloudflare Workers, TypeScript) → 카카오 장소 검색, 카카오모빌리티 경로·이동시간
```

## API (backend)

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| GET | `/api/health` | 상태, 카카오 키 설정 여부 |
| GET | `/api/search?q=&lat=&lng=` | 카카오 키워드 장소 검색 (lat/lng 근처 우선) |
| POST | `/api/route` | 마커 순서대로 구간별 시간·거리와 도로 경로 좌표. `optimize: true` 면 최단 순서로 정렬, `roundTrip: true` 면 첫 마커(숙소)로 돌아오는 구간 포함 (형식: `backend/src/route.ts`) |

```bash
curl -X POST $API/api/route -H 'Content-Type: application/json' -d '{
  "mode": "car",
  "optimize": true,
  "points": [
    { "name": "동대구역", "lat": 35.8794, "lng": 128.6286 },
    { "name": "수성못",   "lat": 35.8280, "lng": 128.6170 },
    { "name": "동성로",   "lat": 35.8690, "lng": 128.5960 }
  ]
}'
# → { order: [0, 2, 1], legs: [{ min, km, walk }...], paths: [[[lat, lng]...] | null ...], totalMin, totalKm, source, warnings }
# paths[i] 는 legs[i] 의 도로 좌표. 도로 경로를 못 찾은 구간만 null (화면에서 직선 점선)
```

마커는 최대 32개 (카카오모빌리티 다중 경유지 한도). 대중교통·도보는 카카오 API가 없어 직선거리 기반 추정.

## 카카오 키

| 키 | 쓰는 곳 | 설정 위치 |
| --- | --- | --- |
| JavaScript 키 | 지도 표시 (프론트) | 로컬 `frontend/config.js`, 배포 시 GitHub 저장소 변수 `KAKAO_JS_KEY` |
| REST API 키 | 장소 검색·길찾기 (백엔드) | 로컬 `backend/.dev.vars`, 배포 시 `npx wrangler secret put KAKAO_REST_KEY` |

카카오 개발자 콘솔: 앱 > 플랫폼 > Web 에 `http://localhost:8080`, `https://giyoooon.github.io` 등록, 카카오맵 사용 설정 ON,
카카오모빌리티 길찾기 API 사용 신청.

## 로컬 실행

```bash
cd backend && npm install
echo KAKAO_REST_KEY=발급받은키 > .dev.vars
npm run dev                        # http://localhost:8787

cp frontend/config.example.js frontend/config.js   # KAKAO_JS_KEY 입력
npx http-server frontend -p 8080   # http://localhost:8080
```

테스트: `cd backend && npm test`

## 배포 (자동)

`main` 에 push 하면 GitHub Actions 가 배포함.

- `frontend/` 변경 → GitHub Pages (저장소 Variables: `KAKAO_JS_KEY`, `API_BASE`)
- `backend/` 변경 → 테스트 통과 시 Cloudflare Workers (저장소 Secrets: `CLOUDFLARE_API_TOKEN`)
