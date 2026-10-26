// /api/route: 사용자가 정한 순서 그대로 경로를 계산 (순서 최적화 없음)
import { estimateLeg, haversineKm } from './geo';
import { errMsg, waypointsRoute } from './kakao';
import type { Env, Mode, Place } from './types';

export interface RouteRequest { mode: Mode; points: Place[] }
export interface RouteLeg { min: number; km: number; walk: boolean }
export interface RouteResponse {
  source: 'kakao' | 'estimate';
  legs: RouteLeg[];
  totalMin: number;
  totalKm: number;
  path: [number, number][] | null;
  warnings: string[];
}

/** 이 거리(km) 안에 연달아 찍힌 마커는 같은 자리로 보고 이동 0 */
const SAME_SPOT_KM = 0.02;

export async function route(req: RouteRequest, env: Env): Promise<RouteResponse> {
  const { mode, points } = req;
  const warnings: string[] = [];
  const same = points.map((p, i) => i > 0 && haversineKm(points[i - 1], p) < SAME_SPOT_KM);

  // legs[i] = points[i] → points[i+1]. 기본값은 직선거리 기반 추정
  const legs: RouteLeg[] = points.slice(1).map((b, i) => {
    if (same[i + 1]) return { min: 0, km: 0, walk: true };
    const est = estimateLeg(points[i], b, mode);
    return { min: est.min, km: haversineKm(points[i], b) * 1.3, walk: est.walk };
  });

  let path: RouteResponse['path'] = null;
  let source: RouteResponse['source'] = 'estimate';
  if (mode === 'car') {
    // 같은 자리 마커는 빼고 조회 (카카오는 너무 가까운 경유지를 거부함)
    const kept = points.map((_, i) => i).filter(i => !same[i]);
    if (!env.KAKAO_REST_KEY) {
      warnings.push('서버에 카카오 REST 키가 설정되지 않아 직선거리로 추정했어요.');
    } else if (kept.length >= 2) {
      try {
        const r = await waypointsRoute(env.KAKAO_REST_KEY, kept.map(i => points[i]));
        // section k 는 kept[k] → kept[k+1] 이고, 그 사이 마커는 모두 kept[k] 와 같은 자리
        r.sections.forEach((s, k) => {
          legs[kept[k + 1] - 1] = { min: s.duration / 60, km: s.distance / 1000, walk: false };
        });
        path = r.path;
        source = 'kakao';
      } catch (e) {
        warnings.push(`실제 도로 경로를 못 불러와 직선거리로 추정했어요(${errMsg(e)}).`);
      }
    }
  }

  const rounded = legs.map(l => ({ min: Math.round(l.min), km: Math.round(l.km * 10) / 10, walk: l.walk }));
  return {
    source,
    legs: rounded,
    totalMin: rounded.reduce((a, l) => a + l.min, 0),
    totalKm: Math.round(legs.reduce((a, l) => a + l.km, 0) * 10) / 10,
    path,
    warnings,
  };
}
