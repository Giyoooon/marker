// marker-api — 마커 경로 API (Cloudflare Worker)
//   GET  /api/health              서버 상태, 카카오 키 설정 여부
//   GET  /api/search?q=&lat=&lng= 카카오 장소 검색
//   POST /api/route               마커 순서대로 경로 계산, optimize 면 최단 순서로 정렬 (형식: src/route.ts)
//   /api/maps...                  공유 지도 (src/shared.ts)
import { KakaoError, searchKeyword } from './kakao';
import { route } from './route';
import * as shared from './shared';
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

  if (path === '/api/maps' || path.startsWith('/api/maps/')) return handleMaps(req, env, path);

  return json({ error: 'not found' }, 404);
}

/** 공유 지도 API. 경로 형식과 동작은 src/shared.ts 맨 위 주석 참고 */
async function handleMaps(req: Request, env: Env, path: string): Promise<Response> {
  const db = env.DB;
  const m = req.method;
  if (path === '/api/maps' && m === 'POST') return json(await shared.createMap(db, await readJson(req)), 201);

  const parts = path.split('/').slice(3);   // [code, sub?, id?]
  const code = shared.normalizeCode(parts[0] ?? '');
  const [, sub, idStr] = parts;
  const id = Number(idStr);
  if (!sub) {
    if (m === 'GET') return json(await shared.getMap(db, code), 200, { 'Cache-Control': 'no-store' });
    if (m === 'PATCH') return json(await shared.updateMap(db, code, await readJson(req)));
  } else if (sub === 'members' && !idStr && m === 'POST') {
    const r = await shared.joinMap(db, code, await readJson(req));
    return json({ member: r.member }, r.created ? 201 : 200);
  } else if (sub === 'markers' && !idStr && m === 'POST') {
    return json(await shared.addMarker(db, code, await readJson(req)), 201);
  } else if (sub === 'markers' && Number.isInteger(id)) {
    if (m === 'PATCH') return json(await shared.updateMarker(db, code, id, await readJson(req)));
    if (m === 'DELETE') return json(await shared.deleteMarker(db, code, id));
  } else if (sub === 'order' && m === 'PUT') {
    return json(await shared.reorder(db, code, await readJson(req)));
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res: Response;
    try {
      res = await handle(req, env, ctx);
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
