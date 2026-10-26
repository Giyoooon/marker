// 일정 최적화 (외부 의존성 없는 순수 함수)
// 1) 날짜별로 고정 일정을 시간순 뼈대로 놓고
// 2) 가볼 곳을 "총 이동시간이 가장 적게 늘어나는 자리"에 하나씩 끼워 넣되, 고정 일정·하루 종료 시간을 어기지 않게 하고
// 3) 배치된 곳을 다른 위치/날짜로 옮겨 보며 총 이동시간을 줄이는 개선을 반복
import type { Leg } from './types';

export interface Matrix { leg(i: number, j: number): Leg }

export interface Stop {
  id: string;
  /** 이동시간 행렬의 노드 번호 */
  n: number;
  fixed: boolean;
  /** 고정 일정 시작 시각(분). 가볼 곳은 0 */
  time: number;
  dur: number;
  must: boolean;
}

export interface DayDef {
  start: number;
  end: number;
  /** 출발/도착 노드. 없으면 -1 (첫/마지막 장소에서 시작·종료) */
  s: number;
  e: number;
  fixed: Stop[];
}

export interface SimItem { stop: Stop; leg: Leg; arrive: number; begin: number; end: number; wait: number; late: number }
export interface Sim { travel: number; late: number; over: number; items: SimItem[]; back: Leg; finish: number }

const NONE: Leg = { min: 0, walk: true };
const legOf = (M: Matrix, i: number, j: number) => (i < 0 || j < 0 ? NONE : M.leg(i, j));

export function simulate(day: DayDef, route: Stop[], M: Matrix): Sim {
  let t = day.start, prev = day.s, travel = 0, late = 0;
  const items: SimItem[] = [];
  for (const stop of route) {
    const leg = legOf(M, prev, stop.n);
    const arrive = t + leg.min;
    travel += leg.min;
    let begin = arrive, wait = 0, itemLate = 0;
    if (stop.fixed) {
      if (arrive > stop.time + 0.5) itemLate = arrive - stop.time;
      else { wait = stop.time - arrive; begin = stop.time; }
      late += itemLate;
    }
    items.push({ stop, leg, arrive, begin, end: begin + stop.dur, wait, late: itemLate });
    t = begin + stop.dur;
    prev = stop.n;
  }
  const back = legOf(M, prev, day.e);
  travel += back.min;
  const finish = t + back.min;
  return { travel, late, over: Math.max(0, finish - day.end), items, back, finish };
}

export function optimize(days: DayDef[], flex: Stop[], M: Matrix) {
  const routes = days.map(d => d.fixed.slice());
  const sims = days.map((d, i) => simulate(d, routes[i], M));
  // 고정 일정만으로 이미 늦는 경우가 있으므로, 그보다 나빠지지 않는 것을 기준으로 삼음
  const limits = sims.map(s => ({ late: s.late, over: s.over }));
  const ok = (d: number, s: Sim) => s.late <= limits[d].late + 0.5 && s.over <= limits[d].over + 0.5;
  const insertAt = (r: Stop[], p: number, s: Stop) => [...r.slice(0, p), s, ...r.slice(p)];

  function insertAll(pool: Stop[]): Stop[] {
    const left = pool.slice();
    while (left.length) {
      let best: { cost: number; stop: Stop; d: number; route: Stop[]; sim: Sim } | null = null;
      for (const stop of left) {
        for (let d = 0; d < days.length; d++) {
          for (let p = 0; p <= routes[d].length; p++) {
            const route = insertAt(routes[d], p, stop);
            const sim = simulate(days[d], route, M);
            if (!ok(d, sim)) continue;
            const cost = sim.travel - sims[d].travel - (stop.must ? 1e6 : 0);
            if (!best || cost < best.cost) best = { cost, stop, d, route, sim };
          }
        }
      }
      if (!best) break;
      routes[best.d] = best.route;
      sims[best.d] = best.sim;
      left.splice(left.indexOf(best.stop), 1);
    }
    return left;
  }

  function improve() {
    for (let pass = 0; pass < 40; pass++) {
      let improved = false;
      outer: for (let d = 0; d < days.length; d++) {
        for (let i = 0; i < routes[d].length; i++) {
          const stop = routes[d][i];
          if (stop.fixed) continue;
          const without = routes[d].filter((_, k) => k !== i);
          const simWithout = simulate(days[d], without, M);
          let best: { gain: number; d2: number; route: Stop[]; sim: Sim } | null = null;
          for (let d2 = 0; d2 < days.length; d2++) {
            const base = d2 === d ? without : routes[d2];
            for (let p = 0; p <= base.length; p++) {
              if (d2 === d && p === i) continue;
              const route = insertAt(base, p, stop);
              const sim = simulate(days[d2], route, M);
              if (!ok(d2, sim)) continue;
              const gain = d2 === d
                ? sims[d].travel - sim.travel
                : sims[d].travel - simWithout.travel - (sim.travel - sims[d2].travel);
              if (gain > 0.5 && (!best || gain > best.gain)) best = { gain, d2, route, sim };
            }
          }
          if (best) {
            if (best.d2 !== d) { routes[d] = without; sims[d] = simWithout; }
            routes[best.d2] = best.route;
            sims[best.d2] = best.sim;
            improved = true;
            break outer;
          }
        }
      }
      if (!improved) break;
    }
  }

  const ordered = flex.slice().sort((a, b) => Number(b.must) - Number(a.must));
  let unplaced = insertAll(ordered);
  improve();
  if (unplaced.length) { unplaced = insertAll(unplaced); improve(); }
  return { routes, sims, unplaced };
}
