import { afterEach, describe, expect, it, vi } from 'vitest';
import { route } from '../src/route';
import { BadRequest, validateRoute } from '../src/validate';

const A = { name: '동대구역', lat: 35.8794, lng: 128.6286 };
const B = { name: '동성로', lat: 35.8690, lng: 128.5960 };
const B2 = { name: '동성로 옆 카페', lat: 35.86905, lng: 128.59605 }; // B 와 10m 이내
const C = { name: '수성못', lat: 35.8280, lng: 128.6170 };

afterEach(() => vi.unstubAllGlobals());

describe('route (추정값)', () => {
  it('정한 순서대로 구간별 시간·거리를 계산한다', async () => {
    const res = await route({ mode: 'transit', points: [A, B, C] }, {});
    expect(res.source).toBe('estimate');
    expect(res.legs).toHaveLength(2);
    expect(res.legs.every(l => l.min > 0 && l.km > 0)).toBe(true);
    expect(res.totalMin).toBe(res.legs[0].min + res.legs[1].min);
    expect(res.path).toBeNull();
  });

  it('같은 자리에 연달아 찍힌 마커는 이동 0', async () => {
    const res = await route({ mode: 'walk', points: [B, B2, C] }, {});
    expect(res.legs[0]).toEqual({ min: 0, km: 0, walk: true });
  });

  it('자동차인데 키가 없으면 경고와 함께 추정값', async () => {
    const res = await route({ mode: 'car', points: [A, B] }, {});
    expect(res.source).toBe('estimate');
    expect(res.warnings[0]).toContain('카카오 REST 키');
  });
});

describe('route (카카오)', () => {
  it('같은 자리 마커는 빼고 조회한 뒤 구간을 원래 순서에 맞춰 돌려준다', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.waypoints).toHaveLength(1); // A → B → C (B2 제외)
      return new Response(JSON.stringify({ routes: [{ result_code: 0, result_msg: 'ok', sections: [
        { duration: 600, distance: 4000, roads: [{ vertexes: [128.6286, 35.8794, 128.5960, 35.8690] }] },
        { duration: 900, distance: 6500, roads: [{ vertexes: [128.5960, 35.8690, 128.6170, 35.8280] }] },
      ] }] }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await route({ mode: 'car', points: [A, B, B2, C] }, { KAKAO_REST_KEY: 'k' });
    expect(res.source).toBe('kakao');
    expect(res.legs).toEqual([
      { min: 10, km: 4, walk: false },
      { min: 0, km: 0, walk: true },
      { min: 15, km: 6.5, walk: false },
    ]);
    expect(res.totalMin).toBe(25);
    expect(res.totalKm).toBe(10.5);
    expect(res.path).toHaveLength(3);
  });

  it('카카오 호출이 실패하면 추정값으로 대신한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const res = await route({ mode: 'car', points: [A, C] }, { KAKAO_REST_KEY: 'k' });
    expect(res.source).toBe('estimate');
    expect(res.legs[0].min).toBeGreaterThan(0);
    expect(res.warnings[0]).toContain('HTTP 401');
  });
});

describe('validateRoute', () => {
  it('2곳 미만, 32곳 초과, 잘못된 좌표를 거른다', () => {
    expect(() => validateRoute({ points: [A] })).toThrow(/최소 2곳/);
    expect(() => validateRoute({ points: Array(33).fill(A) })).toThrow(/최대 32개/);
    expect(() => validateRoute({ points: [A, { name: 'x', lat: 0, lng: 0 }] })).toThrow(BadRequest);
    expect(validateRoute({ points: [A, B] }).mode).toBe('car');
  });
});
