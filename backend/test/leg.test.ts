import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { route, routeLeg } from '../src/route';
import { validateLeg } from '../src/validate';

const A = { name: '동대구역', lat: 35.8794, lng: 128.6286 };
const B = { name: '동성로', lat: 35.8690, lng: 128.5960 };
const road = { duration: 600, distance: 4500, path: [[35.8794, 128.6286], [35.875, 128.61], [35.869, 128.596]] as [number, number][] };

afterEach(() => vi.unstubAllGlobals());

describe('한 구간 (/api/leg)', () => {
  it('도로 구간으로 이동수단별 시간을 계산하고 도로 좌표를 돌려준다', async () => {
    const fn = vi.fn(async () => road);
    expect(await routeLeg({ mode: 'car', from: A, to: B }, fn)).toEqual({ leg: { min: 10, km: 4.5, walk: false }, path: road.path, source: 'kakao' });
    expect((await routeLeg({ mode: 'walk', from: A, to: B }, fn)).leg).toEqual({ min: 60, km: 4.5, walk: true });
    expect((await routeLeg({ mode: 'transit', from: A, to: B }, fn)).leg).toEqual({ min: 25, km: 4.5, walk: false });
    expect(fn).toHaveBeenCalledWith(A, B);
  });

  it('도로를 못 찾거나 키가 없으면 직선거리 추정 (path 없음, 이유 알림)', async () => {
    const failed = await routeLeg({ mode: 'car', from: A, to: B }, async () => { throw new Error('경로 없음'); });
    expect(failed).toMatchObject({ path: null, source: 'estimate', warning: expect.stringContaining('경로 없음') });
    expect(failed.leg.km).toBeGreaterThan(0);
    const noKey = await routeLeg({ mode: 'car', from: A, to: B }, null);
    expect(noKey).toMatchObject({ path: null, source: 'estimate', warning: expect.stringContaining('카카오 REST 키') });
  });

  it('같은 자리면 카카오를 부르지 않고 0', async () => {
    const fn = vi.fn(async () => road);
    const r = await routeLeg({ mode: 'car', from: B, to: { ...B, lat: B.lat + 0.00005 } }, fn);
    expect(r.leg).toEqual({ min: 0, km: 0, walk: true });
    expect(fn).not.toHaveBeenCalled();
  });

  it('입력 검증과 HTTP (키 없음 → 추정)', async () => {
    expect(() => validateLeg({ from: A })).toThrow(/to/);
    const res = await worker.fetch(new Request('https://api.test/api/leg', { method: 'POST', body: JSON.stringify({ mode: 'walk', from: A, to: B }) }), {} as never, {} as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ source: 'estimate', path: null, leg: { walk: true } });
  });
});

describe('최단 순서만 (orderOnly)', () => {
  it('순서만 계산하고 도로 경로는 부르지 않는다', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const C = { name: '수성못', lat: 35.828, lng: 128.617 };
    const res = await route({ mode: 'walk', optimize: true, orderOnly: true, points: [A, C, B] }, { KAKAO_REST_KEY: 'k' });
    expect(res.order).toEqual([0, 2, 1]);
    expect(res.legs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();   // 도보 정렬은 직선거리 기준이라 카카오 호출 없음
  });
});
