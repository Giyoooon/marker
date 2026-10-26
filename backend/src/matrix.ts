// 모든 마커 쌍의 이동시간(분) 행렬 — 순서 최적화용
import { estimateLeg, haversineKm } from './geo';
import { multiDestination, pool } from './kakao';
import type { Mode, Place } from './types';

/** 카카오모빌리티 다중 목적지 API는 출발지 반경 10km 안의 목적지만 받음 */
const MULTI_DEST_RADIUS_KM = 9.5;

export function estimateMatrix(points: Place[], mode: Mode): number[][] {
  return points.map(a => points.map(b => estimateLeg(a, b, mode).min));
}

/** 반경 안 구간은 카카오모빌리티 실제 자동차 소요시간, 그보다 먼 구간은 추정값 */
export async function kakaoMatrix(key: string, points: Place[]): Promise<number[][]> {
  const M = estimateMatrix(points, 'car');
  await pool(points.map((origin, i) => async () => {
    const dests = points
      .map((place, j) => ({ key: String(j), place }))
      .filter(({ place }, j) => j !== i && M[i][j] > 0 && haversineKm(origin, place) <= MULTI_DEST_RADIUS_KM);
    if (!dests.length) return;
    for (const [k, sec] of await multiDestination(key, origin, dests)) M[i][Number(k)] = sec / 60;
  }));
  return M;
}
