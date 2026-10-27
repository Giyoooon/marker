import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import * as shared from '../src/shared';
import { fakeD1 } from './fake-d1';

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const P = (name: string, k: number) => ({ name, lat: 35.86 + k * 0.01, lng: 128.6 + k * 0.01 });

async function setup() {
  const db = fakeD1();
  const { map, member } = await shared.createMap(db, { title: '대구 1박 2일', nickname: '지윤' });
  return { db, code: map.code, map, me: member };
}

describe('지도 만들기', () => {
  it('4자리 [A-Z0-9] 번호와 제목, 만든 사람 닉네임이 생기고 생성일·수정일이 있다', async () => {
    const { map, me } = await setup();
    expect(map.code).toMatch(/^[A-Z0-9]{4}$/);
    expect(map).toMatchObject({ title: '대구 1박 2일', mode: 'car', loop: true });
    expect(map.createdAt).toMatch(ISO);
    expect(map.updatedAt).toMatch(ISO);
    expect(me).toMatchObject({ nickname: '지윤' });
    expect(me.createdAt).toMatch(ISO);
  });

  it('DB 도 번호 규칙을 막는다 (소문자, 길이, 특수문자)', async () => {
    const db = fakeD1();
    for (const bad of ['ab12', 'ABC', 'ABCDE', 'AB-1']) {
      await expect(db.prepare('INSERT INTO maps (code, title) VALUES (?, ?)').bind(bad, 't').run()).rejects.toThrow(/CHECK/);
    }
  });

  it('번호가 겹치면 다시 뽑는다', async () => {
    const db = fakeD1();
    const codes = new Set<string>();
    for (let i = 0; i < 30; i++) codes.add((await shared.createMap(db, { title: 't', nickname: 'n' })).map.code);
    expect(codes.size).toBe(30);
  });

  it('제목·닉네임 검증', async () => {
    const db = fakeD1();
    await expect(shared.createMap(db, { title: ' ', nickname: 'a' })).rejects.toThrow(/제목/);
    await expect(shared.createMap(db, { title: 't', nickname: 'x'.repeat(21) })).rejects.toThrow(/20자/);
  });
});

describe('수정일', () => {
  it('행을 바꾸면 updated_at 이 갱신되고 created_at 은 그대로', async () => {
    const { db, code, map, me } = await setup();
    await sleep(5);
    const { map: after } = await shared.updateMap(db, code, { memberId: me.id, title: '대구 여행' });
    expect(after.title).toBe('대구 여행');
    expect(after.createdAt).toBe(map.createdAt);
    expect(after.updatedAt > map.updatedAt).toBe(true);
  });

  it('마커가 바뀌면 지도의 수정일도 갱신돼서 다른 사람이 변경을 알 수 있다', async () => {
    const { db, code, me } = await setup();
    const before = (await shared.getMap(db, code)).map.updatedAt;
    await sleep(5);
    const { marker } = await shared.addMarker(db, code, { memberId: me.id, ...P('동성로', 0) });
    const afterAdd = (await shared.getMap(db, code)).map.updatedAt;
    expect(afterAdd > before).toBe(true);
    await sleep(5);
    const { marker: m2 } = await shared.updateMarker(db, code, marker.id, { memberId: me.id, cat: 'food' });
    expect(m2.updatedAt > marker.updatedAt).toBe(true);
    expect(m2.createdAt).toBe(marker.createdAt);
    expect((await shared.getMap(db, code)).map.updatedAt > afterAdd).toBe(true);
  });
});

describe('닉네임', () => {
  it('새 닉네임은 만들고, 이미 있는 닉네임은 그 사람으로 들어간다', async () => {
    const { db, code, me } = await setup();
    const a = await shared.joinMap(db, code, { nickname: '민수' });
    expect(a.created).toBe(true);
    const again = await shared.joinMap(db, code, { nickname: '지윤' });
    expect(again).toMatchObject({ created: false, member: { id: me.id } });
    expect((await shared.getMap(db, code)).members.map(m => m.nickname)).toEqual(['지윤', '민수']);
  });

  it('없는 지도엔 들어갈 수 없다', async () => {
    const db = fakeD1();
    await expect(shared.joinMap(db, 'ZZZZ', { nickname: 'a' })).rejects.toThrow(shared.NotFound);
  });
});

describe('마커와 마킹한 사람', () => {
  it('누가 마킹했는지 저장되고, 지도를 여는 모든 사람에게 보인다', async () => {
    const { db, code, me } = await setup();
    const { member: minsu } = await shared.joinMap(db, code, { nickname: '민수' });
    await shared.addMarker(db, code, { memberId: me.id, ...P('동성로', 0), cat: 'sight' });
    await shared.addMarker(db, code, { memberId: minsu.id, ...P('서문시장', 1), cat: 'food' });
    const view = await shared.getMap(db, code);
    expect(view.markers.map(m => [m.name, m.markedBy?.nickname, m.cat, m.on])).toEqual([
      ['동성로', '지윤', 'sight', true],
      ['서문시장', '민수', 'food', true],
    ]);
    expect(view.markers[0].createdAt).toMatch(ISO);
  });

  it('다른 지도의 닉네임이나 없는 닉네임으로는 마킹할 수 없다', async () => {
    const { db, code } = await setup();
    const other = await shared.createMap(db, { title: '다른 지도', nickname: '남' });   // 같은 DB 의 다른 지도
    await expect(shared.addMarker(db, code, { memberId: other.member.id, ...P('a', 0) })).rejects.toThrow(/닉네임/);
    await expect(shared.addMarker(db, code, { memberId: 9999, ...P('a', 0) })).rejects.toThrow(/닉네임/);
  });

  it('같은 자리는 두 번 마킹할 수 없다 (좌표 소수 5자리 기준)', async () => {
    const { db, code, me } = await setup();
    await shared.addMarker(db, code, { memberId: me.id, name: 'a', lat: 35.8690001, lng: 128.5960001 });
    await expect(shared.addMarker(db, code, { memberId: me.id, name: 'b', lat: 35.869, lng: 128.596 }))
      .rejects.toThrow(shared.Conflict);
  });

  it(`지도마다 마커는 ${shared.MAX_MARKERS}개까지`, async () => {
    const { db, code, me } = await setup();
    for (let k = 0; k < shared.MAX_MARKERS; k++) await shared.addMarker(db, code, { memberId: me.id, ...P(`p${k}`, k) });
    await expect(shared.addMarker(db, code, { memberId: me.id, ...P('넘침', 99) })).rejects.toThrow(/31개/);
  });

  it('마킹한 사람이 지워져도 마커는 남는다', async () => {
    const { db, code, me } = await setup();
    const { marker } = await shared.addMarker(db, code, { memberId: me.id, ...P('a', 0) });
    await db.prepare('DELETE FROM members WHERE id = ?').bind(me.id).run();
    const view = await shared.getMap(db, code);
    expect(view.markers[0]).toMatchObject({ id: marker.id, markedBy: null });
  });
});

describe('경로 포함·순서', () => {
  async function three() {
    const s = await setup();
    const ids = [];
    for (const [k, n] of ['A', 'B', 'C'].entries()) ids.push((await shared.addMarker(s.db, s.code, { memberId: s.me.id, ...P(n, k) })).marker.id);
    return { ...s, ids };
  }
  const names = async (db: D1Database, code: string) =>
    (await shared.getMap(db, code)).markers.map(m => m.name + (m.on ? '' : '(off)')).join(' ');

  it('빼면 뺀 곳 맨 아래로, 다시 넣으면 경로 맨 끝으로', async () => {
    const { db, code, me, ids: [a, b] } = await three();
    await shared.updateMarker(db, code, a, { memberId: me.id, on: false });
    await shared.updateMarker(db, code, b, { memberId: me.id, on: false });
    expect(await names(db, code)).toBe('C A(off) B(off)');
    await shared.updateMarker(db, code, a, { memberId: me.id, on: true });
    expect(await names(db, code)).toBe('C A B(off)');
  });

  it('순서 바꾸기는 경로에 든 마커 전부를 받아야 한다', async () => {
    const { db, code, me, ids: [a, b, c] } = await three();
    await shared.reorder(db, code, { memberId: me.id, ids: [c, a, b] });
    expect(await names(db, code)).toBe('C A B');
    await expect(shared.reorder(db, code, { memberId: me.id, ids: [c, a] })).rejects.toThrow(shared.Conflict);
    await shared.updateMarker(db, code, b, { memberId: me.id, on: false });
    await expect(shared.reorder(db, code, { memberId: me.id, ids: [c, a, b] })).rejects.toThrow(/새로고침/);
  });

  it('삭제', async () => {
    const { db, code, me, ids: [, b] } = await three();
    await shared.deleteMarker(db, code, b, me.id);
    expect(await names(db, code)).toBe('A C');
    await expect(shared.deleteMarker(db, code, b, me.id)).rejects.toThrow(shared.NotFound);
  });
});

describe('HTTP', () => {
  // 지도 방(Durable Object) 대신: 방에 보낸 알림을 모아 둠
  const env = () => {
    const broadcasts: unknown[] = [];
    const stub = { fetch: async (_url: string, init: RequestInit) => { broadcasts.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }); } };
    return { DB: fakeD1(), ALLOWED_ORIGINS: 'https://giyoooon.github.io', broadcasts,
      ROOMS: { idFromName: (n: string) => n, get: () => stub } };
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
  const call = (e: ReturnType<typeof env>, method: string, path: string, body?: unknown) =>
    worker.fetch(new Request(`https://api.test${path}`, { method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', Origin: 'https://giyoooon.github.io' } }), e as never, ctx as never).then(async r => { await Promise.all(pending); return r; });

  it('만들기 → 들어가기 → 마킹 → 조회 흐름과 상태 코드', async () => {
    const e = env();
    const created = await call(e, 'POST', '/api/maps', { title: '부산', nickname: '지윤' });
    expect(created.status).toBe(201);
    const { map, member } = await created.json() as { map: { code: string }; member: { id: number } };
    const joined = await call(e, 'POST', `/api/maps/${map.code.toLowerCase()}/members`, { nickname: '민수' });   // 번호는 소문자로 쳐도 됨
    expect(joined.status).toBe(201);
    expect((await call(e, 'POST', `/api/maps/${map.code}/members`, { nickname: '민수' })).status).toBe(200);
    const marked = await call(e, 'POST', `/api/maps/${map.code}/markers`, { memberId: member.id, ...P('해운대', 0) });
    expect(marked.status).toBe(201);
    expect((await call(e, 'POST', `/api/maps/${map.code}/markers`, { memberId: member.id, ...P('해운대', 0) })).status).toBe(409);
    const got = await call(e, 'GET', `/api/maps/${map.code}`);
    expect(got.headers.get('Access-Control-Allow-Origin')).toBe('https://giyoooon.github.io');
    const view = await got.json() as { markers: { markedBy: { nickname: string } }[] };
    expect(view.markers[0].markedBy.nickname).toBe('지윤');
  });

  it('잘못된 번호 400, 없는 번호 404, PATCH/PUT/DELETE 를 CORS 로 허용', async () => {
    const e = env();
    expect((await call(e, 'GET', '/api/maps/AB')).status).toBe(400);
    expect((await call(e, 'GET', '/api/maps/ZZZZ')).status).toBe(404);
    const pre = await call(e, 'OPTIONS', '/api/maps/ZZZZ');
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
    expect(pre.headers.get('Access-Control-Allow-Methods')).toContain('DELETE');
  });
});

describe('구간별 이동수단', () => {
  const K = '35.86000,128.60000>35.87000,128.61000';
  it('처음엔 비어 있고, 기본과 다른 구간만 저장·조회된다 (지도 수정일도 바뀜)', async () => {
    const { db, code, map, me } = await setup();
    expect(map.legModes).toEqual({});
    await sleep(5);
    const r = await shared.updateMap(db, code, { memberId: me.id, legModes: { [K]: 'walk' } });
    expect(r.map.legModes).toEqual({ [K]: 'walk' });
    expect(r.map.updatedAt > map.updatedAt).toBe(true);
    expect(r.event).toMatchObject({ action: 'map.update', changes: { legModes: { [K]: 'walk' } } });
    expect((await shared.getMap(db, code)).map.legModes).toEqual({ [K]: 'walk' });
  });

  it('형식이 틀리거나 너무 많으면 거부', async () => {
    const { db, code, me } = await setup();
    const bad = (legModes: unknown) => expect(shared.updateMap(db, code, { memberId: me.id, legModes })).rejects.toThrow(/legModes/);
    await bad([]);
    await bad({ [K]: 'plane' });
    await bad({ '35.86,128.6>35.87,128.61': 'walk' });      // 소수 5자리가 아님
    await bad({ "x'; DROP TABLE maps; --": 'walk' });
    await bad(Object.fromEntries(Array.from({ length: shared.MAX_LEG_MODES + 1 }, (_, k) =>
      [`35.${String(k).padStart(5, '0')},128.60000>35.87000,128.61000`, 'walk'])));
  });
});

describe('지도 관리: 만든 사람·삭제·닉네임 바꾸기', () => {
  it('만든 사람이 기록되고, 지도 삭제는 만든 사람만 (닉네임·마커·표도 함께 지워짐)', async () => {
    const { db, code, map, me } = await setup();
    expect(map.createdBy).toBe(me.id);
    const { member: other } = await shared.joinMap(db, code, { nickname: '민수' });
    const { marker } = await shared.addMarker(db, code, { memberId: other.id, ...P('동성로', 0) });
    await shared.voteMarker(db, code, marker.id, { memberId: other.id, value: 1 });
    await expect(shared.deleteMap(db, code, other.id)).rejects.toThrow(/만든 사람만/);
    const r = await shared.deleteMap(db, code, me.id);
    expect(r.event).toMatchObject({ action: 'map.delete', by: { id: me.id }, changes: { title: '대구 1박 2일' } });
    await expect(shared.getMap(db, code)).rejects.toThrow(/없는 지도/);
    for (const t of ['members', 'markers', 'marker_votes']) {
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n).toBe(0);
    }
  });

  it('닉네임은 본인만 바꾸고, 겹치면 거부. 마커의 마킹한 사람 이름도 따라 바뀜', async () => {
    const { db, code, me } = await setup();
    const { member: other } = await shared.joinMap(db, code, { nickname: '민수' });
    await shared.addMarker(db, code, { memberId: me.id, ...P('동성로', 0) });
    await expect(shared.renameMember(db, code, me.id, { memberId: other.id, nickname: 'x' })).rejects.toThrow(/내 닉네임만/);
    await expect(shared.renameMember(db, code, me.id, { memberId: me.id, nickname: '민수' })).rejects.toThrow(/이미 있는/);
    const r = await shared.renameMember(db, code, me.id, { memberId: me.id, nickname: '지윤이' });
    expect(r.member.nickname).toBe('지윤이');
    expect(r.event).toMatchObject({ action: 'member.rename', changes: { from: '지윤', to: '지윤이' } });
    expect((await shared.getMap(db, code)).markers[0].markedBy).toEqual({ id: me.id, nickname: '지윤이' });
  });
});

describe('일차', () => {
  it('마킹할 때·바꿀 때 일차를 정하고, 조회는 일차 순', async () => {
    const { db, code, me } = await setup();
    const a = (await shared.addMarker(db, code, { memberId: me.id, ...P('a', 0), day: 2 })).marker;
    const b = (await shared.addMarker(db, code, { memberId: me.id, ...P('b', 1) })).marker;
    expect([a.day, b.day]).toEqual([2, 1]);
    expect((await shared.getMap(db, code)).markers.map(m => m.name)).toEqual(['b', 'a']);
    const r = await shared.updateMarker(db, code, b.id, { memberId: me.id, day: 3 });
    expect(r.marker.day).toBe(3);
    expect(r.event?.changes).toEqual({ day: 3 });
    for (const bad of [0, 10, 1.5, 'x']) {
      await expect(shared.updateMarker(db, code, b.id, { memberId: me.id, day: bad })).rejects.toThrow(/day/);
    }
  });
});

describe('가볼 곳 투표', () => {
  it('👍·👎·거두기, 사람마다 하나, 누가 했는지 보임. 같은 표를 다시 보내면 알리지 않음', async () => {
    const { db, code, me } = await setup();
    const { member: other } = await shared.joinMap(db, code, { nickname: '민수' });
    const { marker } = await shared.addMarker(db, code, { memberId: me.id, ...P('동성로', 0) });
    expect(marker.votes).toEqual({ up: [], down: [] });
    let r = await shared.voteMarker(db, code, marker.id, { memberId: me.id, value: 1 });
    expect(r.event).toMatchObject({ action: 'marker.vote', marker: { name: '동성로' }, changes: { value: 1 } });
    r = await shared.voteMarker(db, code, marker.id, { memberId: other.id, value: -1 });
    expect(r.marker.votes).toEqual({ up: [{ id: me.id, nickname: '지윤' }], down: [{ id: other.id, nickname: '민수' }] });
    r = await shared.voteMarker(db, code, marker.id, { memberId: other.id, value: 1 });   // 마음을 바꿈
    expect(r.marker.votes.up.map(v => v.nickname)).toEqual(['지윤', '민수']);
    expect(r.marker.votes.down).toEqual([]);
    expect((await shared.voteMarker(db, code, marker.id, { memberId: other.id, value: 1 })).event).toBeUndefined();
    await sleep(5);
    const before = (await shared.getMap(db, code)).map.updatedAt;
    await shared.voteMarker(db, code, marker.id, { memberId: me.id, value: 0 });
    const after = await shared.getMap(db, code);
    expect(after.markers[0].votes.up.map(v => v.nickname)).toEqual(['민수']);
    expect(after.map.updatedAt > before).toBe(true);   // 다른 사람 화면이 알아채도록
    await expect(shared.voteMarker(db, code, marker.id, { memberId: me.id, value: 2 })).rejects.toThrow(/value/);
  });
});

describe('관리·투표 API 경로', () => {
  it('PUT vote / PATCH members/:id / DELETE map, 권한 없으면 403', async () => {
    const db = fakeD1();
    const env = { DB: db, ALLOWED_ORIGINS: 'https://x.test', ROOMS: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(null) }) } };
    const ctx = { waitUntil: () => {} };
    const call = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://api.test${path}`,
      { method, body: body ? JSON.stringify(body) : undefined }), env as never, ctx as never);
    const { map, member } = await shared.createMap(db, { title: 't', nickname: 'a' });
    const { member: b } = await shared.joinMap(db, map.code, { nickname: 'b' });
    const { marker } = await shared.addMarker(db, map.code, { memberId: member.id, ...P('x', 0) });
    expect((await call('PUT', `/api/maps/${map.code}/markers/${marker.id}/vote`, { memberId: b.id, value: -1 })).status).toBe(200);
    expect((await call('PATCH', `/api/maps/${map.code}/members/${member.id}`, { memberId: b.id, nickname: 'z' })).status).toBe(403);
    expect((await call('PATCH', `/api/maps/${map.code}/members/${b.id}`, { memberId: b.id, nickname: 'z' })).status).toBe(200);
    expect((await call('DELETE', `/api/maps/${map.code}?memberId=${b.id}`)).status).toBe(403);
    expect((await call('DELETE', `/api/maps/${map.code}?memberId=${member.id}`)).status).toBe(200);
    expect((await call('GET', `/api/maps/${map.code}`)).status).toBe(404);
  });
});
