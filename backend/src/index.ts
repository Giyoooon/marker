// marker-api — 마커 경로 API (Cloudflare Worker)
//   GET  /api/health              서버 상태, 카카오 키 설정 여부
//   GET  /api/search?q=&lat=&lng= 카카오 장소 검색
//   POST /api/route               마커 순서대로 경로 계산, optimize 면 최단 순서로 정렬 (형식: src/route.ts)
//   /api/maps...                  공유 지도 (src/shared.ts)
import { KakaoError, searchKeyword } from './kakao';
import { route } from './route';
import * as shared from './shared';
export { MapRoom } from './room';
import type { Env } from './types';
import { BadRequest, validateRoute } from './validate';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

async function readJson(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { throw new BadRequest('JSON 본문이 필요해요'); }
}

async function handle(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/health') return json({ ok: true, kakao: !!env.KAKAO_REST_KEY });

  if (path === '/api/search' && req.method === 'GET') {
    const q = url.searchParams.get('q')?.trim();
    if (!q) throw new BadRequest('q: 검색어가 필요해요');
    if (!env.KAKAO_REST_KEY) return json({ error: '서버에 카카오 REST 키가 설정되지 않았어요' }, 503);
    // 지도 중심 좌표로 검색 결과를 가까운 순으로 보정. 캐시가 잘 맞도록 1km 정도로 반올림
    const round = (v: string | null) => Math.round(Number(v) * 100) / 100;
    const lat = round(url.searchParams.get('lat')), lng = round(url.searchParams.get('lng'));
    const near = Number.isFinite(lat) && Number.isFinite(lng) && lat && lng ? { lat, lng } : undefined;

    // 같은 검색은 하루 동안 캐시
    const cacheKey = new Request(`https://cache.marker/search?${new URLSearchParams({ q, lat: String(lat || ''), lng: String(lng || '') })}`);
    const cached = await caches.default.match(cacheKey);
    if (cached) return new Response(cached.body, cached);
    const res = json(await searchKeyword(env.KAKAO_REST_KEY, q, near), 200, { 'Cache-Control': 'public, max-age=86400' });
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()));
    return res;
  }

  if (path === '/api/route' && req.method === 'POST') {
    return json(await route(validateRoute(await readJson(req)), env));
  }

  if (path === '/api/maps' || path.startsWith('/api/maps/')) return handleMaps(req, env, ctx, path);

  return json({ error: 'not found' }, 404);
}

/** 공유 지도 API. 경로 형식과 동작은 src/shared.ts 맨 위 주석 참고 */
async function handleMaps(req: Request, env: Env, ctx: ExecutionContext, path: string): Promise<Response> {
  const db = env.DB;
  const m = req.method;
  if (path === '/api/maps' && m === 'POST') return json(await shared.createMap(db, await readJson(req)), 201);

  const parts = path.split('/').slice(3);   // [code, sub?, id?]
  const code = shared.normalizeCode(parts[0] ?? '');
  const [, sub, idStr] = parts;
  const id = Number(idStr);
  const room = () => env.ROOMS.get(env.ROOMS.idFromName(code));
  /** 바뀐 내용을 응답하면서, 같은 지도에 접속한 사람들에게 알림 (응답을 늦추지 않게 waitUntil) */
  const reply = <T extends { event?: shared.ChangeEvent }>({ event, ...data }: T, status = 200) => {
    if (event) ctx.waitUntil(room().fetch('https://room/broadcast', { method: 'POST', body: JSON.stringify(event) }).catch(e => console.error(e)));
    return json(data, status);
  };

  if (!sub) {
    if (m === 'GET') return json(await shared.getMap(db, code), 200, { 'Cache-Control': 'no-store' });
    if (m === 'PATCH') return reply(await shared.updateMap(db, code, await readJson(req)));
  } else if (sub === 'ws' && m === 'GET') {
    return connectRoom(req, env, code, room());
  } else if (sub === 'members' && !idStr && m === 'POST') {
    const { created, ...r } = await shared.joinMap(db, code, await readJson(req));
    return reply(r, created ? 201 : 200);
  } else if (sub === 'markers' && !idStr && m === 'POST') {
    return reply(await shared.addMarker(db, code, await readJson(req)), 201);
  } else if (sub === 'markers' && Number.isInteger(id)) {
    if (m === 'PATCH') return reply(await shared.updateMarker(db, code, id, await readJson(req)));
    if (m === 'DELETE') return reply(await shared.deleteMarker(db, code, id, new URL(req.url).searchParams.get('memberId')));
  } else if (sub === 'order' && m === 'PUT') {
    return reply(await shared.reorder(db, code, await readJson(req)));
  }
  return json({ error: 'not found' }, 404);
}

/**
 * 지도 방 웹소켓 연결. 허용된 출처에서만 받고, memberId 가 있으면 D1 에서 닉네임을 확인해서 방에 넘김
 * (닉네임이 없거나 이 지도 사람이 아니면 '구경 중'으로 연결)
 */
async function connectRoom(req: Request, env: Env, code: string, room: DurableObjectStub): Promise<Response> {
  if (req.headers.get('Upgrade') !== 'websocket') return json({ error: '웹소켓으로 연결해 주세요' }, 426);
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim());
  if (origin && !allowed.includes(origin)) return json({ error: '허용되지 않은 출처예요' }, 403);
  await shared.getMap(env.DB, code);   // 없는 지도면 404
  const target = new URL('https://room/connect');
  const memberId = new URL(req.url).searchParams.get('memberId');
  if (memberId) {
    try {
      const member = await shared.memberOf(env.DB, code, memberId);
      target.searchParams.set('memberId', String(member.id));
      target.searchParams.set('nickname', member.nickname);
    } catch { /* 모르는 닉네임 → 구경 중 */ }
  }
  return room.fetch(new Request(target, req));
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res: Response;
    try {
      res = await handle(req, env, ctx);
      if (res.status === 101) return res;   // 웹소켓 연결은 그대로 돌려줘야 함 (헤더를 다시 감싸면 연결이 끊김)
    } catch (e) {
      if (e instanceof BadRequest) res = json({ error: e.message }, 400);
      else if (e instanceof shared.NotFound) res = json({ error: e.message }, 404);
      else if (e instanceof shared.Conflict) res = json({ error: e.message }, 409);
      else if (e instanceof KakaoError) res = json({ error: `카카오 API 오류: ${e.message}` }, 502);
      else { console.error(e); res = json({ error: '서버 오류' }, 500); }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
} satisfies ExportedHandler<Env>;
