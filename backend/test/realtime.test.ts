import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { MapRoom, presenceOf, type Attachment } from '../src/room';
import * as shared from '../src/shared';
import { fakeD1 } from './fake-d1';

const P = (name: string, k: number) => ({ name, lat: 35.86 + k * 0.01, lng: 128.6 + k * 0.01 });

async function setup() {
  const db = fakeD1();
  const { map, member: jiyun } = await shared.createMap(db, { title: '대구', nickname: '지윤' });
  const { member: minsu } = await shared.joinMap(db, map.code, { nickname: '민수' });
  return { db, code: map.code, jiyun, minsu };
}

describe('변경 알림(event)과 누가 했는지', () => {
  it('마킹·수정·삭제·순서·설정마다 누가 무엇을 했는지 알림이 나온다', async () => {
    const { db, code, jiyun, minsu } = await setup();
    const a = await shared.addMarker(db, code, { memberId: jiyun.id, ...P('동성로', 0), cat: 'sight' });
    expect(a.event).toMatchObject({ type: 'change', action: 'marker.add', by: { nickname: '지윤' }, marker: { name: '동성로' } });
    const b = await shared.addMarker(db, code, { memberId: minsu.id, ...P('서문시장', 1) });

    const off = await shared.updateMarker(db, code, a.marker.id, { memberId: minsu.id, on: false });
    expect(off.event).toMatchObject({ action: 'marker.update', by: { nickname: '민수' }, marker: { name: '동성로' }, changes: { on: false } });

    const renamed = await shared.updateMarker(db, code, b.marker.id, { memberId: jiyun.id, name: '서문시장 야시장', cat: 'food' });
    expect(renamed.event?.changes).toEqual({ name: '서문시장 야시장', cat: 'food' });
    expect(renamed.event?.marker?.name).toBe('서문시장');   // 바꾸기 전 이름으로 알림

    const del = await shared.deleteMarker(db, code, a.marker.id, jiyun.id);
    expect(del.event).toMatchObject({ action: 'marker.delete', by: { nickname: '지윤' }, marker: { name: '동성로' } });

    const map = await shared.updateMap(db, code, { memberId: minsu.id, mode: 'walk' });
    expect(map.event).toMatchObject({ action: 'map.update', by: { nickname: '민수' }, changes: { mode: 'walk' } });
  });

  it('바뀐 게 없으면 알림도 없다 (같은 값으로 수정, 같은 순서)', async () => {
    const { db, code, jiyun } = await setup();
    const a = await shared.addMarker(db, code, { memberId: jiyun.id, ...P('A', 0), cat: 'food' });
    const b = await shared.addMarker(db, code, { memberId: jiyun.id, ...P('B', 1) });
    expect((await shared.updateMarker(db, code, a.marker.id, { memberId: jiyun.id, cat: 'food', on: true })).event).toBeUndefined();
    expect((await shared.reorder(db, code, { memberId: jiyun.id, ids: [a.marker.id, b.marker.id] })).event).toBeUndefined();
    expect((await shared.reorder(db, code, { memberId: jiyun.id, ids: [b.marker.id, a.marker.id] })).event).toMatchObject({ action: 'order' });
  });

  it('마커를 마지막으로 바꾼 사람이 저장되고 모두에게 보인다', async () => {
    const { db, code, jiyun, minsu } = await setup();
    const a = await shared.addMarker(db, code, { memberId: jiyun.id, ...P('동성로', 0) });
    expect(a.marker.updatedBy).toBeNull();
    await shared.updateMarker(db, code, a.marker.id, { memberId: minsu.id, cat: 'cafe' });
    const view = await shared.getMap(db, code);
    expect(view.markers[0]).toMatchObject({ markedBy: { nickname: '지윤' }, updatedBy: { nickname: '민수' } });
  });

  it('바꾸는 요청은 이 지도의 닉네임이 있어야 한다', async () => {
    const { db, code, jiyun } = await setup();
    const a = await shared.addMarker(db, code, { memberId: jiyun.id, ...P('A', 0) });
    await expect(shared.updateMarker(db, code, a.marker.id, { cat: 'food' })).rejects.toThrow(/닉네임/);
    await expect(shared.deleteMarker(db, code, a.marker.id, null)).rejects.toThrow(/닉네임/);
    await expect(shared.updateMap(db, code, { title: 'x' })).rejects.toThrow(/닉네임/);
    await expect(shared.reorder(db, code, { ids: [a.marker.id] })).rejects.toThrow(/닉네임/);
  });

  it('새 닉네임이 들어오면 알림, 이미 있는 닉네임으로 다시 들어오면 알림 없음', async () => {
    const { db, code } = await setup();
    expect((await shared.joinMap(db, code, { nickname: '수아' })).event).toMatchObject({ action: 'member.join', by: { nickname: '수아' } });
    expect((await shared.joinMap(db, code, { nickname: '수아' })).event).toBeUndefined();
  });
});

describe('HTTP 로 바꾸면 지도 방에 알림이 가고, 응답에는 event 가 섞이지 않는다', () => {
  it('마킹 → 방에 marker.add', async () => {
    const db = fakeD1();
    const sent: { name: string; body: unknown }[] = [];
    const env = {
      DB: db, ALLOWED_ORIGINS: '',
      ROOMS: { idFromName: (n: string) => n, get: (name: string) => ({ fetch: async (_u: string, init: RequestInit) => { sent.push({ name, body: JSON.parse(String(init.body)) }); return new Response(null); } }) },
    };
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await worker.fetch(new Request(`https://api.test${path}`, { method, body: body ? JSON.stringify(body) : undefined }), env as never, ctx as never);
      await Promise.all(waits);
      return r;
    };
    const { map, member } = await (await call('POST', '/api/maps', { title: 't', nickname: '지윤' })).json() as { map: { code: string }; member: { id: number } };
    const res = await call('POST', `/api/maps/${map.code}/markers`, { memberId: member.id, ...P('동성로', 0) });
    const body = await res.json() as Record<string, unknown>;
    expect(body.event).toBeUndefined();
    expect(sent).toEqual([{ name: map.code, body: expect.objectContaining({ action: 'marker.add', by: { id: member.id, nickname: '지윤' } }) }]);
    // 삭제는 memberId 를 쿼리로
    const id = (body.marker as { id: number }).id;
    expect((await call('DELETE', `/api/maps/${map.code}/markers/${id}`)).status).toBe(400);
    expect((await call('DELETE', `/api/maps/${map.code}/markers/${id}?memberId=${member.id}`)).status).toBe(200);
    expect(sent.at(-1)?.body).toMatchObject({ action: 'marker.delete' });
  });

  it('웹소켓이 아닌 요청이나 허용되지 않은 출처는 지도 방에 연결하지 않는다', async () => {
    const env = { DB: fakeD1(), ALLOWED_ORIGINS: 'https://giyoooon.github.io', ROOMS: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response('should not reach') }) } };
    const { map } = await shared.createMap(env.DB, { title: 't', nickname: 'n' });
    const ws = (origin: string, upgrade = true) => worker.fetch(new Request(`https://api.test/api/maps/${map.code}/ws`, {
      headers: { Origin: origin, ...(upgrade ? { Upgrade: 'websocket' } : {}) } }), env as never, {} as never);
    expect((await ws('https://giyoooon.github.io', false)).status).toBe(426);
    expect((await ws('https://evil.example')).status).toBe(403);
  });
});

describe('지도 방 (접속자 목록, 알림 전달)', () => {
  const att = (sid: string, member: [number, string] | null, since: string): Attachment =>
    ({ sid, member: member && { id: member[0], nickname: member[1] }, since });

  it('같은 사람의 탭 여러 개는 한 명으로, 닉네임 없는 연결은 구경으로 센다', () => {
    const p = presenceOf([
      att('1', [2, '민수'], '2026-10-27T01:00:05Z'),
      att('2', [1, '지윤'], '2026-10-27T01:00:00Z'),
      att('3', [2, '민수'], '2026-10-27T01:00:01Z'),
      att('4', null, '2026-10-27T01:00:09Z'),
    ]);
    expect(p).toEqual({
      type: 'presence', viewers: 1,
      online: [
        { id: 1, nickname: '지윤', since: '2026-10-27T01:00:00Z', tabs: 1 },
        { id: 2, nickname: '민수', since: '2026-10-27T01:00:01Z', tabs: 2 },   // 먼저 들어온 탭 시각
      ],
    });
  });

  it('알림은 접속한 모두에게, 연결이 끊기면 남은 사람에게 바뀐 접속자 목록을 보낸다', async () => {
    const mk = (a: Attachment) => ({ sent: [] as string[], send(t: string) { this.sent.push(t); }, deserializeAttachment: () => a });
    const jiyun = mk(att('1', [1, '지윤'], 'a')), minsu = mk(att('2', [2, '민수'], 'b'));
    const sockets = [jiyun, minsu];
    const room = new MapRoom({ getWebSockets: () => sockets } as never, {} as never);

    const res = await room.fetch(new Request('https://room/broadcast', { method: 'POST', body: JSON.stringify({ type: 'change', action: 'order' }) }));
    expect(res.status).toBe(204);
    expect(jiyun.sent.map(s => JSON.parse(s).action)).toEqual(['order']);
    expect(minsu.sent.map(s => JSON.parse(s).action)).toEqual(['order']);

    await room.webSocketClose(minsu as never);
    const last = JSON.parse(jiyun.sent.at(-1)!);
    expect(last).toMatchObject({ type: 'presence', online: [{ nickname: '지윤' }], viewers: 0 });
    expect(minsu.sent).toHaveLength(1);   // 끊긴 연결엔 보내지 않음
  });
});
