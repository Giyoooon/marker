import type { RouteRequest } from './route';
import type { DayInput, FixedInput, Mode, Place, PlanRequest, SpotInput } from './types';

export class BadRequest extends Error {}

// routePoints: 카카오모빌리티 다중 경유지 길찾기 한도(경유지 30 + 출발·도착)
const LIMITS = { days: 7, fixed: 30, spots: 40, routePoints: 32 };
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

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
const time = (v: unknown, field: string) => {
  if (typeof v !== 'string' || !TIME.test(v)) fail(`${field}: HH:MM 형식이어야 해요`);
  return v;
};

function place(v: unknown, field: string): Place {
  if (!isObj(v)) fail(`${field}: 장소 객체가 필요해요`);
  return {
    name: str(v.name, `${field}.name`),
    lat: num(v.lat, `${field}.lat`, 32, 39.5),   // 대한민국 범위
    lng: num(v.lng, `${field}.lng`, 124, 132),
  };
}
const optPlace = (v: unknown, field: string) => (v == null ? null : place(v, field));
const list = (v: unknown, field: string, max: number) => {
  if (v == null) return [];
  if (!Array.isArray(v)) fail(`${field}: 배열이 필요해요`);
  if (v.length > max) fail(`${field}: 최대 ${max}개까지 가능해요`);
  return v as unknown[];
};

function mode(v: unknown): Mode {
  const m = (v ?? 'car') as Mode;
  if (!['car', 'transit', 'walk'].includes(m)) fail('mode: car | transit | walk');
  return m;
}

export function validateRoute(body: unknown): RouteRequest {
  if (!isObj(body)) fail('JSON 객체가 필요해요');
  const points = list(body.points, 'points', LIMITS.routePoints).map((p, i) => place(p, `points[${i}]`));
  if (points.length < 2) fail('points: 최소 2곳이 필요해요');
  return { mode: mode(body.mode), points };
}

export function validatePlan(body: unknown): PlanRequest {
  if (!isObj(body)) fail('JSON 객체가 필요해요');
  const days: DayInput[] = list(body.days, 'days', LIMITS.days).map((d, i) => {
    if (!isObj(d)) fail(`days[${i}]: 객체가 필요해요`);
    return { start: time(d.start, `days[${i}].start`), end: time(d.end, `days[${i}].end`),
      from: optPlace(d.from, `days[${i}].from`), to: optPlace(d.to, `days[${i}].to`) };
  });
  if (!days.length) fail('days: 최소 1일이 필요해요');
  const ids = new Set<string>();
  const id = (v: unknown, field: string) => {
    const s = str(v, field, 40);
    if (ids.has(field[0] + s)) fail(`${field}: id가 중복돼요`);
    ids.add(field[0] + s);
    return s;
  };
  const fixed: FixedInput[] = list(body.fixed, 'fixed', LIMITS.fixed).map((f, i) => {
    if (!isObj(f)) fail(`fixed[${i}]: 객체가 필요해요`);
    return { ...place(f, `fixed[${i}]`), id: id(f.id, `fixed[${i}].id`), day: num(f.day, `fixed[${i}].day`, 1, 31),
      time: time(f.time, `fixed[${i}].time`), dur: num(f.dur ?? 60, `fixed[${i}].dur`, 0, 1440) };
  });
  const spots: SpotInput[] = list(body.spots, 'spots', LIMITS.spots).map((s, i) => {
    if (!isObj(s)) fail(`spots[${i}]: 객체가 필요해요`);
    return { ...place(s, `spots[${i}]`), id: id(s.id, `spots[${i}].id`),
      dur: num(s.dur ?? 60, `spots[${i}].dur`, 5, 720), must: s.must === true };
  });
  return { mode: mode(body.mode), days, fixed, spots };
}
