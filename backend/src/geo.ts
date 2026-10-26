import type { Leg, Mode, Place } from './types';

/** 자동차 이동 시 주차·도보 접근에 드는 고정 시간(분) */
export const PARKING_MIN = 5;

export function haversineKm(a: Place, b: Place): number {
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export const walkMin = (km: number) => (km * 1.3) / 4.5 * 60;

/** 걷는 게 더 빠르거나 아주 가까우면 도보로 처리 */
export function preferWalk(km: number, rideMin: number): Leg {
  const w = walkMin(km);
  return w <= rideMin || km < 0.7 ? { min: w, walk: true } : { min: rideMin, walk: false };
}

/** 직선거리 기반 이동시간 추정 */
export function estimateLeg(a: Place, b: Place, mode: Mode): Leg {
  const km = haversineKm(a, b);
  if (km < 0.05) return { min: 0, walk: true };
  if (mode === 'walk') return { min: walkMin(km), walk: true };
  const ride = mode === 'car'
    ? (km * 1.3) / (km > 10 ? 55 : 32) * 60 + PARKING_MIN
    : (km * 1.35) / (km > 10 ? 32 : 18) * 60 + 12; // 대중교통: 대기·환승 12분
  return preferWalk(km, ride);
}

