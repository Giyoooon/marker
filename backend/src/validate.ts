import type { RouteRequest } from './route';
import type { Mode, Place } from './types';

export class BadRequest extends Error {}

/** 카카오모빌리티 다중 경유지 길찾기 한도(경유지 30 + 출발·도착) */
const MAX_POINTS = 32;

function fail(msg: string): never { throw new BadRequest(msg); }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, field: string, max = 80) => {
  if (typeof v !== 'string' || !v.trim()) fail(`${field}: 문자열이 필요해요`);
  return v.trim().slice(0, max);
};
const num = (v: unknown, field: string, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${field}: ${min}~${max} 사이 숫자여야 해요`);
  return n;
};

function place(v: unknown, field: string): Place {
  if (!isObj(v)) fail(`${field}: 장소 객체가 필요해요`);
  return {
    name: str(v.name, `${field}.name`),
    lat: num(v.lat, `${field}.lat`, 32, 39.5),   // 대한민국 범위
    lng: num(v.lng, `${field}.lng`, 124, 132),
  };
}

function mode(v: unknown): Mode {
  const m = (v ?? 'car') as Mode;
  if (!['car', 'transit', 'walk'].includes(m)) fail('mode: car | transit | walk');
  return m;
}

export function validateRoute(body: unknown): RouteRequest {
  if (!isObj(body)) fail('JSON 객체가 필요해요');
  if (!Array.isArray(body.points)) fail('points: 배열이 필요해요');
  if (body.points.length > MAX_POINTS) fail(`points: 최대 ${MAX_POINTS}개까지 가능해요`);
  const points = body.points.map((p, i) => place(p, `points[${i}]`));
  if (points.length < 2) fail('points: 최소 2곳이 필요해요');
  return { mode: mode(body.mode), points, optimize: body.optimize === true };
}
