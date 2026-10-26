// 카카오 로컬 / 카카오모빌리티 REST API 래퍼
import type { Place } from './types';

const LOCAL = 'https://dapi.kakao.com/v2/local';
const NAVI = 'https://apis-navi.kakaomobility.com/v1';

export class KakaoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call<T>(url: string, key: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `KakaoAK ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 160);
    throw new KakaoError(res.status, `HTTP ${res.status} ${text}`);
  }
  return res.json() as Promise<T>;
}

// group: 카카오 카테고리 그룹 코드 (AD5 숙박, FD6 음식점, CE7 카페, AT4 관광명소, CT1 문화시설 등)
export interface SearchResult extends Place { id: string; addr: string; category: string; group: string; url: string }

export async function searchKeyword(key: string, query: string, near?: { lat: number; lng: number }): Promise<SearchResult[]> {
  const q = new URLSearchParams({ query, size: '10' });
  if (near) { q.set('x', String(near.lng)); q.set('y', String(near.lat)); }
  const data = await call<{ documents: Record<string, string>[] }>(`${LOCAL}/search/keyword.json?${q}`, key);
  return data.documents.map(d => ({
    id: d.id,
    name: d.place_name,
    addr: d.road_address_name || d.address_name,
    category: d.category_name?.split(' > ').pop() ?? '',
    group: d.category_group_code ?? '',
    url: d.place_url,
    lat: Number(d.y),
    lng: Number(d.x),
  }));
}

/** 한 출발지에서 여러 목적지까지 자동차 소요시간(초). 목적지는 출발지 반경 10km 이내만 가능 */
export async function multiDestination(key: string, origin: Place, dests: { key: string; place: Place }[]): Promise<Map<string, number>> {
  const data = await call<{ routes?: { result_code: number; key: string; summary?: { duration: number } }[] }>(
    `${NAVI}/destinations/directions`, key, {
      origin: { x: origin.lng, y: origin.lat },
      destinations: dests.map(d => ({ x: d.place.lng, y: d.place.lat, key: d.key })),
      radius: 10000,
      priority: 'TIME',
    });
  const out = new Map<string, number>();
  for (const r of data.routes ?? []) if (r.result_code === 0 && r.summary) out.set(r.key, r.summary.duration);
  return out;
}

/** 한 구간: 소요시간(초), 거리(m), 지도에 그릴 도로 좌표 [lat, lng][] */
export interface Section { duration: number; distance: number; path: [number, number][] }
type RawSection = { duration: number; distance: number; roads: { vertexes: number[] }[] };
type RawRoutes = { routes?: { result_code: number; result_msg: string; sections?: RawSection[] }[] };

function toSection(s: RawSection): Section {
  const path: [number, number][] = [];
  for (const road of s.roads) {
    for (let i = 0; i + 1 < road.vertexes.length; i += 2) {
      const p: [number, number] = [+road.vertexes[i + 1].toFixed(5), +road.vertexes[i].toFixed(5)];
      const last = path[path.length - 1];
      if (!last || Math.abs(last[0] - p[0]) + Math.abs(last[1] - p[1]) > 0.0002) path.push(p);
    }
  }
  return { duration: s.duration, distance: s.distance, path };
}
function firstRoute(data: RawRoutes): RawSection[] {
  const route = data.routes?.[0];
  if (!route || route.result_code !== 0 || !route.sections) throw new KakaoError(200, route?.result_msg ?? 'no route');
  return route.sections;
}

/** 경유지 포함 자동차 경로를 한 번에 조회. 한 구간이라도 길이 없으면 전체가 실패함 */
export async function waypointsRoute(key: string, pts: Place[]): Promise<Section[]> {
  const xy = (p: Place) => ({ x: p.lng, y: p.lat });
  const data = await call<RawRoutes>(`${NAVI}/waypoints/directions`, key, {
    origin: xy(pts[0]),
    destination: xy(pts[pts.length - 1]),
    waypoints: pts.slice(1, -1).map(xy),
    priority: 'RECOMMEND',
  });
  return firstRoute(data).map(toSection);
}

/** 두 지점 사이 자동차 경로 한 구간 */
export async function directions(key: string, a: Place, b: Place): Promise<Section> {
  const q = new URLSearchParams({ origin: `${a.lng},${a.lat}`, destination: `${b.lng},${b.lat}`, priority: 'RECOMMEND' });
  const sections = firstRoute(await call<RawRoutes>(`${NAVI}/directions?${q}`, key));
  const merged = sections.map(toSection);
  return {
    duration: merged.reduce((t, s) => t + s.duration, 0),
    distance: merged.reduce((t, s) => t + s.distance, 0),
    path: merged.flatMap(s => s.path),
  };
}

export const errMsg = (e: unknown) => (e instanceof KakaoError ? e.message : String(e)).slice(0, 120);

/** 동시 요청 수를 제한해서 비동기 작업 실행 */
export async function pool<T>(tasks: (() => Promise<T>)[], size = 6): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}
