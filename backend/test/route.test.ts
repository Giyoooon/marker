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
    expect(res.paths).toEqual([null, null]);
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
    expect(res.paths.map(p => p?.length ?? null)).toEqual([2, null, 2]);   // 같은 자리 구간은 그릴 것 없음
  });

  it('도보·대중교통도 도로를 따라 그리고, 시간은 도로 거리로 추정한다', async () => {
    const kakao = () => new Response(JSON.stringify({ routes: [{ result_code: 0, result_msg: 'ok', sections: [
      { duration: 600, distance: 4500, roads: [{ vertexes: [128.6286, 35.8794, 128.61, 35.875, 128.5960, 35.8690] }] },
    ] }] }));
    vi.stubGlobal('fetch', vi.fn(async () => kakao()));
    const walk = await route({ mode: 'walk', points: [A, B] }, { KAKAO_REST_KEY: 'k' });
    expect(walk.source).toBe('kakao');
    expect(walk.paths[0]).toHaveLength(3);                       // 직선(2점)이 아니라 도로 좌표
    expect(walk.legs[0]).toEqual({ min: 60, km: 4.5, walk: true }); // 4.5km ÷ 4.5km/h

    const transit = await route({ mode: 'transit', points: [A, B] }, { KAKAO_REST_KEY: 'k' });
    expect(transit.paths[0]).toHaveLength(3);
    expect(transit.legs[0]).toEqual({ min: 25, km: 4.5, walk: false }); // 자동차 10분 × 1.5 + 10
  });

  it('카카오 호출이 실패하면 추정값으로 대신한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const res = await route({ mode: 'car', points: [A, C] }, { KAKAO_REST_KEY: 'k' });
    expect(res.source).toBe('estimate');
    expect(res.legs[0].min).toBeGreaterThan(0);
    expect(res.warnings[0]).toContain('동대구역 → 수성못');
  });

  it('한 번에 조회가 실패하면 구간마다 다시 조회해서, 찾은 구간은 도로로 그린다', async () => {
    const ok = (from: number[], to: number[], sec: number, m: number) => new Response(JSON.stringify({ routes: [{ result_code: 0, result_msg: 'ok',
      sections: [{ duration: sec, distance: m, roads: [{ vertexes: [...from, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2, ...to] }] }] }] }));
    const fetchMock = vi.fn(async (url: string) => {
      // 경유지 한 번에 조회: 길 없는 구간이 있어서 실패
      if (url.includes('/waypoints/')) return new Response(JSON.stringify({ routes: [{ result_code: 104, result_msg: '경로 없음' }] }));
      const dest = new URL(url).searchParams.get('destination');
      if (dest === `${B.lng},${B.lat}`) return ok([A.lng, A.lat], [B.lng, B.lat], 600, 4000);   // 동대구역 → 동성로: 됨
      return new Response(JSON.stringify({ routes: [{ result_code: 104, result_msg: '경로 없음' }] })); // 동성로 → 수성못: 안 됨
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await route({ mode: 'car', points: [A, B, C] }, { KAKAO_REST_KEY: 'k' });
    expect(fetchMock).toHaveBeenCalledTimes(3);              // 한 번에 1 + 구간별 2
    expect(res.source).toBe('kakao');
    expect(res.paths[0]).toHaveLength(3);                     // 찾은 구간: 도로 좌표
    expect(res.paths[1]).toBeNull();                          // 못 찾은 구간: 직선으로 표시
    expect(res.legs[0]).toEqual({ min: 10, km: 4, walk: false });
    expect(res.legs[1].km).toBeGreaterThan(0);                // 직선거리 추정값
    expect(res.warnings).toEqual(['도로 경로를 찾지 못해 직선거리로 표시한 구간: 동성로 → 수성못']);
  });
});

describe('route optimize', () => {
  it('첫 마커는 그대로 두고 최단 순서로 바꾼 뒤 그 순서로 구간을 돌려준다', async () => {
    // 동대구역 출발, 수성못(멀리) → 동성로 → 동성로 근처 순으로 찍었을 때
    const res = await route({ mode: 'walk', optimize: true, points: [A, C, B, B2] }, {});
    expect(res.order[0]).toBe(0);
    // 동대구역 → 동성로·동성로 옆(10m 차이라 둘 중 어느 쪽이 먼저든 같음) → 수성못
    expect(res.order[3]).toBe(1);
    expect(res.order.slice(1, 3).sort()).toEqual([2, 3]);
    expect(res.legs).toHaveLength(3);
    expect(res.legs[1]).toEqual({ min: 0, km: 0, walk: true });
  });

  it('optimize 가 아니면 순서를 바꾸지 않는다', async () => {
    const res = await route({ mode: 'walk', points: [A, C, B] }, {});
    expect(res.order).toEqual([0, 1, 2]);
  });
});

describe('route roundTrip (숙소 출발·복귀)', () => {
  it('마지막에 첫 마커로 돌아오는 구간이 붙는다', async () => {
    const res = await route({ mode: 'walk', roundTrip: true, points: [A, B, C] }, {});
    expect(res.order).toEqual([0, 1, 2]);
    expect(res.legs).toHaveLength(3);
    expect(res.legs[2].km).toBeGreaterThan(0);   // 수성못 → 동대구역
  });

  it('최단 정렬도 돌아오는 길까지 포함해서 계산한다', async () => {
    // 일직선: 숙소(0) 오른쪽에 1, 2, 3 이 순서대로 있을 때 왕복이면 1→2→3 또는 3→2→1 이 같음
    const P = (lng: number) => ({ name: String(lng), lat: 35.8, lng });
    const res = await route({ mode: 'walk', roundTrip: true, optimize: true, points: [P(128.5), P(128.53), P(128.51), P(128.52)] }, {});
    expect(res.order[0]).toBe(0);
    expect([[0, 2, 3, 1], [0, 1, 3, 2]]).toContainEqual(res.order);
  });

  it('왕복은 31곳까지만 받는다', () => {
    expect(() => validateRoute({ roundTrip: true, points: Array(32).fill(A) })).toThrow(/왕복은 최대 31개/);
    expect(validateRoute({ roundTrip: true, points: [A, B] }).roundTrip).toBe(true);
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
