// /api/plan: 요청 → 이동시간 행렬 → 최적화 → (자동차면) 실제 도로 경로로 시간 보정
import { estimateLeg, haversineKm, hhmm, PARKING_MIN, preferWalk, toMin } from './geo';
import { KakaoError, multiDestination, pool, waypointsRoute } from './kakao';
import { optimize, simulate, type DayDef, type Matrix, type Sim, type Stop } from './planner';
import type { Env, Leg, Mode, Place, PlanDay, PlanRequest, PlanResponse } from './types';

/** Workers 무료 플랜의 요청당 외부 호출 한도(50)를 넘지 않도록 */
const MAX_KAKAO_NODES = 40;
const MULTI_DEST_RADIUS_KM = 9.5;

function estimateMatrix(nodes: Place[], mode: Mode): Leg[][] {
  return nodes.map(a => nodes.map(b => estimateLeg(a, b, mode)));
}

/** 반경 10km 이내 구간은 카카오모빌리티 실제 소요시간, 그보다 먼 구간은 추정값 */
async function kakaoMatrix(key: string, nodes: Place[], base: Leg[][]): Promise<Leg[][]> {
  const M = base.map(row => row.slice());
  const tasks = nodes.map((origin, i) => async () => {
    const dests = nodes
      .map((place, j) => ({ key: String(j), place }))
      .filter(({ place }, j) => j !== i && M[i][j].min > 0 && haversineKm(origin, place) <= MULTI_DEST_RADIUS_KM);
    if (!dests.length) return;
    const secs = await multiDestination(key, origin, dests);
    for (const [k, sec] of secs) {
      const j = Number(k);
      M[i][j] = preferWalk(haversineKm(origin, nodes[j]), sec / 60 + PARKING_MIN);
    }
  });
  await pool(tasks);
  return M;
}

export async function plan(req: PlanRequest, env: Env): Promise<PlanResponse> {
  const warnings: string[] = [];
  const nodes: Place[] = [];
  const index = new Map<string, number>();
  const node = (p?: Place | null) => {
    if (!p) return -1;
    const k = p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
    if (!index.has(k)) { index.set(k, nodes.length); nodes.push(p); }
    return index.get(k)!;
  };

  const fixedById = new Map(req.fixed.map(f => ['f:' + f.id, f]));
  const spotById = new Map(req.spots.map(s => ['s:' + s.id, s]));
  const source = (id: string) => fixedById.get(id) ?? spotById.get(id)!;

  const days: DayDef[] = req.days.map((d, i) => {
    const start = toMin(d.start);
    let end = toMin(d.end);
    if (end <= start) end += 1440;
    return {
      start, end, s: node(d.from), e: node(d.to),
      fixed: req.fixed
        .filter(f => f.day === i + 1)
        .sort((a, b) => toMin(a.time) - toMin(b.time))
        .map(f => ({ id: 'f:' + f.id, n: node(f), fixed: true, time: toMin(f.time), dur: f.dur, must: false })),
    };
  });
  for (const f of req.fixed) {
    if (f.day > req.days.length) warnings.push(`'${f.name}'은(는) ${f.day}일차라서 여행 기간 밖이에요.`);
  }
  const flex: Stop[] = req.spots.map(s => ({ id: 's:' + s.id, n: node(s), fixed: false, time: 0, dur: s.dur, must: !!s.must }));

  // 이동시간 행렬
  let legs = estimateMatrix(nodes, req.mode);
  let usedKakao = false;
  const key = env.KAKAO_REST_KEY;
  if (req.mode === 'car') {
    if (!key) warnings.push('서버에 카카오 REST 키가 설정되지 않아 이동시간을 직선거리로 추정했어요.');
    else if (nodes.length > MAX_KAKAO_NODES) warnings.push(`장소가 ${MAX_KAKAO_NODES}곳을 넘어 이동시간을 직선거리로 추정했어요.`);
    else {
      try { legs = await kakaoMatrix(key, nodes, legs); usedKakao = true; }
      catch (e) { warnings.push(`카카오모빌리티 호출 실패(${errMsg(e)}) — 이동시간을 추정값으로 계산했어요.`); }
    }
  }
  const M: Matrix = { leg: (i, j) => legs[i][j] };
  const { routes, sims, unplaced } = optimize(days, flex, M);

  // 자동차: 확정된 순서로 날짜별 실제 경로를 조회해 시간을 보정하고 지도용 경로 좌표를 받음
  const paths: (PlanDay['path'])[] = days.map(() => null);
  let finalSims: Sim[] = sims;
  if (usedKakao && key) {
    const override = new Map<string, Leg>();
    await Promise.all(days.map(async (d, i) => {
      const seq: number[] = [];
      for (const n of [d.s, ...routes[i].map(s => s.n), d.e]) if (n >= 0 && seq[seq.length - 1] !== n) seq.push(n);
      if (seq.length < 2 || seq.length > 32) return;
      try {
        const r = await waypointsRoute(key, seq.map(n => nodes[n]));
        r.sections.forEach((sec, k) => {
          const a = seq[k], b = seq[k + 1];
          if (!legs[a][b].walk) override.set(`${a},${b}`, { min: sec / 60 + PARKING_MIN, walk: false });
        });
        paths[i] = r.path;
      } catch (e) {
        warnings.push(`${i + 1}일차 실제 도로 경로를 못 불러왔어요(${errMsg(e)}).`);
      }
    }));
    if (override.size) {
      const M2: Matrix = { leg: (a, b) => override.get(`${a},${b}`) ?? legs[a][b] };
      finalSims = days.map((d, i) => simulate(d, routes[i], M2));
    }
  }

  return {
    source: usedKakao ? 'kakao' : 'estimate',
    warnings,
    unplaced: unplaced.map(s => ({ id: s.id.slice(2), name: source(s.id).name })),
    days: finalSims.map((sim, i) => ({
      day: i + 1,
      start: req.days[i].start,
      finish: hhmm(sim.finish),
      travelMin: Math.round(sim.travel),
      overMin: Math.round(sim.over),
      from: req.days[i].from ?? null,
      to: req.days[i].to ?? null,
      back: roundLeg(sim.back),
      path: paths[i],
      items: sim.items.map(it => {
        const src = source(it.stop.id);
        return {
          id: it.stop.id.slice(2), name: src.name, lat: src.lat, lng: src.lng,
          fixed: it.stop.fixed, must: it.stop.must, dur: it.stop.dur,
          arrive: hhmm(it.arrive), begin: hhmm(it.begin), end: hhmm(it.end),
          waitMin: Math.round(it.wait), lateMin: Math.round(it.late), leg: roundLeg(it.leg),
        };
      }),
    })),
  };
}

const roundLeg = (l: Leg): Leg => ({ min: Math.round(l.min), walk: l.walk });
const errMsg = (e: unknown) => (e instanceof KakaoError ? e.message : String(e)).slice(0, 120);
