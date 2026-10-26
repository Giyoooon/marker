import { describe, expect, it } from 'vitest';
import { plan } from '../src/plan';
import { optimize, simulate, type DayDef, type Matrix, type Stop } from '../src/planner';
import { BadRequest, validatePlan } from '../src/validate';

// 노드 i→j 이동시간 = |i-j| * 10분 인 일직선 세계
const line: Matrix = { leg: (i, j) => ({ min: Math.abs(i - j) * 10, walk: false }) };
const spot = (n: number, dur = 30, must = false): Stop => ({ id: 's' + n, n, fixed: false, time: 0, dur, must });
const fixed = (n: number, time: number, dur = 60): Stop => ({ id: 'f' + n, n, fixed: true, time, dur, must: false });

describe('simulate', () => {
  it('고정 일정 전에 일찍 도착하면 기다린다', () => {
    const day: DayDef = { start: 540, end: 1260, s: 0, e: 0, fixed: [] };
    const sim = simulate(day, [fixed(1, 600)], line);
    expect(sim.items[0]).toMatchObject({ arrive: 550, begin: 600, wait: 50, late: 0 });
    expect(sim.finish).toBe(670);
  });

  it('늦게 도착하면 지각 시간을 기록한다', () => {
    const day: DayDef = { start: 540, end: 1260, s: 0, e: 0, fixed: [] };
    const sim = simulate(day, [spot(3, 60), fixed(1, 600)], line);
    expect(sim.late).toBe(30 + 60 + 20 - 60);
  });
});

describe('optimize', () => {
  it('가까운 순서로 배치해서 이동을 최소화한다', () => {
    const day: DayDef = { start: 540, end: 1260, s: 0, e: 0, fixed: [] };
    const { routes, unplaced } = optimize([day], [spot(3), spot(1), spot(2)], line);
    expect(unplaced).toEqual([]);
    const order = routes[0].map(s => s.n);
    expect(order[0] === 1 ? order : order.reverse()).toEqual([1, 2, 3]);
  });

  it('고정 일정 시간을 어기는 배치는 하지 않는다', () => {
    const day: DayDef = { start: 540, end: 1260, s: 0, e: 0, fixed: [fixed(1, 560)] };
    const { sims } = optimize([day], [spot(5, 120)], line);
    expect(sims[0].late).toBe(0);
    expect(sims[0].items.map(i => i.stop.id)).toEqual(['f1', 's5']);
  });

  it('시간이 모자라면 남기고, 꼭 갈 곳을 먼저 넣는다', () => {
    const day: DayDef = { start: 540, end: 700, s: 0, e: 0, fixed: [] };
    const { unplaced, routes } = optimize([day], [spot(1, 100), spot(2, 100, true)], line);
    expect(routes[0].map(s => s.id)).toEqual(['s2']);
    expect(unplaced.map(s => s.id)).toEqual(['s1']);
  });

  it('여러 날에 나눠 배치한다', () => {
    const days: DayDef[] = [0, 1].map(() => ({ start: 540, end: 720, s: 0, e: 0, fixed: [] }));
    const { routes, unplaced } = optimize(days, [spot(1, 120), spot(1.1, 120)], line);
    expect(unplaced).toEqual([]);
    expect(routes.map(r => r.length)).toEqual([1, 1]);
  });
});

describe('plan (카카오 키 없이 추정값)', () => {
  it('강릉 예시 일정을 짠다', async () => {
    const lodging = { name: '숙소', lat: 37.8, lng: 128.905 };
    const station = { name: '강릉역', lat: 37.7638, lng: 128.8997 };
    const res = await plan(validatePlan({
      mode: 'car',
      days: [{ start: '10:00', end: '21:30', from: station, to: lodging }, { start: '09:30', end: '18:30', from: lodging, to: station }],
      fixed: [{ id: '1', name: '점심', lat: 37.7905, lng: 128.9135, day: 1, time: '12:30', dur: 60 }],
      spots: [
        { id: 'a', name: '오죽헌', lat: 37.7792, lng: 128.8786, dur: 60 },
        { id: 'b', name: '정동진', lat: 37.6903, lng: 129.0343, dur: 60, must: true },
        { id: 'c', name: '경포해변', lat: 37.8055, lng: 128.9087, dur: 60 },
      ],
    }), {});
    expect(res.source).toBe('estimate');
    expect(res.unplaced).toEqual([]);
    const all = res.days.flatMap(d => d.items);
    expect(all.map(i => i.name).sort()).toEqual(['경포해변', '오죽헌', '점심', '정동진']);
    expect(all.find(i => i.fixed)).toMatchObject({ begin: '12:30', lateMin: 0 });
    expect(res.warnings[0]).toContain('카카오 REST 키');
  });
});

describe('validatePlan', () => {
  it('잘못된 입력을 거른다', () => {
    expect(() => validatePlan({ days: [] })).toThrow(BadRequest);
    expect(() => validatePlan({ days: [{ start: '9시', end: '18:00' }] })).toThrow(/HH:MM/);
    expect(() => validatePlan({ days: [{ start: '09:00', end: '18:00' }], spots: [{ id: 'x', name: '뉴욕', lat: 40.7, lng: -74, dur: 60 }] })).toThrow(/lat/);
  });
});
