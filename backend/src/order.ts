// 방문 순서 최적화 (외부 의존성 없는 순수 함수)
// 0번(출발지)은 고정하고, 나머지를 들르는 열린 경로의 총 비용이 최소가 되도록
// 최근접 이웃으로 시작한 뒤 2-opt 와 단일 이동(or-opt)으로 개선

export type Cost = (i: number, j: number) => number;

const pathCost = (order: number[], cost: Cost) => {
  let sum = 0;
  for (let k = 1; k < order.length; k++) sum += cost(order[k - 1], order[k]);
  return sum;
};

function nearestNeighbor(n: number, cost: Cost): number[] {
  const order = [0];
  const left = new Set(Array.from({ length: n - 1 }, (_, i) => i + 1));
  while (left.size) {
    const cur = order[order.length - 1];
    let best = -1;
    for (const j of left) if (best < 0 || cost(cur, j) < cost(cur, best)) best = j;
    order.push(best);
    left.delete(best);
  }
  return order;
}

export function bestOrder(n: number, cost: Cost): number[] {
  if (n <= 2) return Array.from({ length: n }, (_, i) => i);
  let order = nearestNeighbor(n, cost);
  let best = pathCost(order, cost);
  for (let pass = 0; pass < 100; pass++) {
    let improved = false;
    // 2-opt: order[i..j] 구간 뒤집기 (비대칭 비용이라 전체 비용으로 비교)
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const c = pathCost(cand, cost);
        if (c < best - 1e-9) { order = cand; best = c; improved = true; }
      }
    }
    // or-opt: 한 곳을 다른 자리로 옮기기
    for (let i = 1; i < n; i++) {
      for (let j = 1; j < n; j++) {
        if (i === j) continue;
        const cand = order.slice();
        const [x] = cand.splice(i, 1);
        cand.splice(j, 0, x);
        const c = pathCost(cand, cost);
        if (c < best - 1e-9) { order = cand; best = c; improved = true; }
      }
    }
    if (!improved) break;
  }
  return order;
}
