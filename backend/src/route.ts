// /api/route: 마커 순서대로 경로 계산. optimize 면 첫 마커를 출발지로 고정하고 최단 순서로 바꾼 뒤 계산
// roundTrip 이면 마지막에 첫 마커(예: 숙소)로 돌아오는 구간까지 포함
import { estimateLeg, haversineKm } from './geo';
import { directions, errMsg, pool, waypointsRoute, type Section } from './kakao';
import { estimateMatrix, kakaoMatrix } from './matrix';
import { bestOrder } from './order';
import type { Env, Mode, Place } from './types';

export interface RouteRequest { mode: Mode; points: Place[]; optimize?: boolean; roundTrip?: boolean }
export interface RouteLeg { min: number; km: number; walk: boolean }
export interface RouteResponse {
  source: 'kakao' | 'estimate';
  /** 응답 경로의 마커 순서 (요청 points 의 인덱스, 복귀 지점 제외). optimize 가 아니면 0..n-1 그대로 */
  order: number[];
  legs: RouteLeg[];
  totalMin: number;
  totalKm: number;
  /** legs 와 같은 순서의 구간별 도로 좌표 [lat, lng][]. null 이면 도로 경로를 못 찾은 구간 */
  paths: ([number, number][] | null)[];
  warnings: string[];
}

/** 이 거리(km) 안에 연달아 찍힌 마커는 같은 자리로 보고 이동 0 */
const SAME_SPOT_KM = 0.02;
/** Workers 무료 플랜의 요청당 외부 호출 한도(50) 안에서 카카오를 부르도록 */
const KAKAO_CALL_LIMIT = 48;

/**
 * 카카오모빌리티 자동차 경로의 구간(도로 거리 km, 자동차 분)으로 이동수단별 시간 계산.
 * 도보·대중교통은 카카오 API가 없어서, 직선이 아닌 실제 도로 거리를 기준으로 추정
 */
export function legFromRoad(mode: Mode, roadKm: number, carMin: number): RouteLeg {
  const walk = (roadKm / 4.5) * 60;
  if (mode === 'walk') return { min: walk, km: roadKm, walk: true };
  if (mode === 'transit') {
    const ride = carMin * 1.5 + 10;   // 버스는 자동차보다 느리고, 기다리고 갈아타는 시간 10분
    return walk <= ride || roadKm < 0.8 ? { min: walk, km: roadKm, walk: true } : { min: ride, km: roadKm, walk: false };
  }
  return { min: carMin, km: roadKm, walk: false };
}

export async function route(req: RouteRequest, env: Pick<Env, 'KAKAO_REST_KEY'>): Promise<RouteResponse> {
  const { mode } = req;
  const warnings: string[] = [];
  const key = env.KAKAO_REST_KEY;
  if (!key) warnings.push('서버에 카카오 REST 키가 설정되지 않아 직선거리로 추정했어요.');

  let calls = 0;   // 이 요청에서 카카오를 부른 횟수 (한도 관리용)
  let order = req.points.map((_, i) => i);
  if (req.optimize && req.points.length > 2) {
    let M = estimateMatrix(req.points, mode);
    // 자동차 소요시간은 카카오 실측. 도보·대중교통 순서는 직선거리 추정으로 충분히 가려짐
    if (key && mode === 'car') {
      calls += req.points.length;   // 출발지마다 한 번씩
      try { M = await kakaoMatrix(key, req.points); }
      catch (e) { warnings.push(`실제 이동시간을 못 불러와 직선거리 기준으로 정렬했어요(${errMsg(e)}).`); }
    }
    order = bestOrder(req.points.length, (i, j) => M[i][j], req.roundTrip);
  }
  // legs 는 points 순서대로. roundTrip 이면 마지막 legs 가 첫 마커로 돌아오는 구간
  const points = [...order, ...(req.roundTrip ? [order[0]] : [])].map(i => req.points[i]);
  const same = points.map((p, i) => i > 0 && haversineKm(points[i - 1], p) < SAME_SPOT_KM);

  // legs[i] = points[i] → points[i+1]. 기본값은 직선거리 기반 추정
  const legs: RouteLeg[] = points.slice(1).map((b, i) => {
    if (same[i + 1]) return { min: 0, km: 0, walk: true };
    const est = estimateLeg(points[i], b, mode);
    return { min: est.min, km: haversineKm(points[i], b) * 1.3, walk: est.walk };
  });


  // paths[i] = legs[i] 의 도로 좌표. null 이면 도로 경로를 못 찾은 구간 (화면에서 직선 점선)
  const paths: RouteResponse['paths'] = legs.map(() => null);
  let source: RouteResponse['source'] = 'estimate';
  // 같은 자리 마커는 빼고 조회 (카카오는 너무 가까운 경유지를 거부함)
  const kept = points.map((_, i) => i).filter(i => !same[i]);
  if (key && kept.length >= 2) {
    // 이동수단과 상관없이 도로를 따라 그릴 경로와 도로 거리를 받아 옴.
    // section k 는 kept[k] → kept[k+1] 이고, 그 사이 마커는 모두 kept[k] 와 같은 자리
    const apply = (k: number, s: Section) => {
      const leg = kept[k + 1] - 1;
      legs[leg] = legFromRoad(mode, s.distance / 1000, s.duration / 60);
      paths[leg] = s.path;
    };
    try {
      (await waypointsRoute(key, kept.map(i => points[i]))).forEach((s, k) => apply(k, s));
      source = 'kakao';
    } catch {
      // 한 번에 조회가 안 되면(한 구간이라도 길이 없으면 전체 실패) 구간마다 따로 조회해서 되는 구간은 도로로
      const budget = Math.max(0, KAKAO_CALL_LIMIT - calls - 1);
      const results = await pool(kept.slice(1).map((b, k) => async () =>
        k < budget ? directions(key, points[kept[k]], points[b]).catch(() => null) : null));
      const failed: string[] = [];
      results.forEach((s, k) => {
        if (s) { apply(k, s); source = 'kakao'; }
        else failed.push(`${points[kept[k]].name} → ${points[kept[k + 1]].name}`);
      });
      if (failed.length) warnings.push(`도로 경로를 찾지 못해 직선거리로 표시한 구간: ${failed.join(', ')}`);
    }
  }

  const rounded = legs.map(l => ({ min: Math.round(l.min), km: Math.round(l.km * 10) / 10, walk: l.walk }));
  return {
    source,
    order,
    legs: rounded,
    totalMin: rounded.reduce((a, l) => a + l.min, 0),
    totalKm: Math.round(legs.reduce((a, l) => a + l.km, 0) * 10) / 10,
    paths,
    warnings,
  };
}
