import { describe, expect, it } from 'vitest';
import { bestOrder } from '../src/order';

// 일직선 위의 점들: 비용 = 위치 차이
const line = (xs: number[]) => (i: number, j: number) => Math.abs(xs[i] - xs[j]);

describe('bestOrder', () => {
  it('출발지(0번)는 고정하고 일직선 순서로 정렬한다', () => {
    const xs = [0, 30, 10, 40, 20];
    expect(bestOrder(xs.length, line(xs))).toEqual([0, 2, 4, 1, 3]);
  });

  it('무작위 평면 좌표에서 전수 탐색 최적값과 같다', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let t = 0; t < 20; t++) {
      const pts = Array.from({ length: 7 }, () => [rnd(), rnd()]);
      const cost = (i: number, j: number) => Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
      const total = (o: number[]) => o.slice(1).reduce((a, j, k) => a + cost(o[k], j), 0);
      const perms = (xs: number[]): number[][] => xs.length <= 1 ? [xs]
        : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map(p => [x, ...p]));
      const optimal = Math.min(...perms([1, 2, 3, 4, 5, 6]).map(p => total([0, ...p])));
      const order = bestOrder(7, cost);
      expect(order[0]).toBe(0);
      expect(total(order)).toBeCloseTo(optimal, 6);
    }
  });

  it('2곳 이하는 그대로', () => {
    expect(bestOrder(2, () => 1)).toEqual([0, 1]);
    expect(bestOrder(1, () => 1)).toEqual([0]);
  });

  it('비대칭 비용(일방통행)도 반영한다', () => {
    // 0→1 은 비싸고 0→2→1 이 쌈
    const c = [[0, 100, 1], [1, 0, 1], [1, 1, 0]];
    expect(bestOrder(3, (i, j) => c[i][j])).toEqual([0, 2, 1]);
  });
});
