import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { admitError, MapRoom, type Attachment } from '../src/room';
import { ROOM_LIMITS } from '../src/security';
import * as shared from '../src/shared';
import { fakeD1 } from './fake-d1';

const ORIGIN = 'https://giyoooon.github.io';
/** 한도: 이름을 주면 그 limiter 만 '넘침' */
const limiters = (over: string[] = []) => Object.fromEntries(
  ['RL_WS', 'RL_MISS', 'RL_READ', 'RL_WRITE', 'RL_CREATE', 'RL_JOIN', 'RL_SEARCH', 'RL_ROUTE']
    .map(n => [n, { limit: async () => ({ success: !over.includes(n) }) }]));
function env(over: string[] = []) {
  return { DB: fakeD1(), ALLOWED_ORIGINS: ORIGIN, KAKAO_REST_KEY: 'k', ...limiters(over),
    ROOMS: { idFromName: (n: string) => n, get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } };
}
const call = (e: ReturnType<typeof env>, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://api.test${path}`, { method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'CF-Connecting-IP': '1.2.3.4', Origin: ORIGIN, ...headers } }), e as never, { waitUntil: () => {} } as never);
const P = { name: 'a', lat: 35.86, lng: 128.6 };

describe('기능별 요청 수 제한 (넘으면 429)', () => {
  it.each([
    ['RL_SEARCH', 'GET', '/api/search?q=수성못'],
    ['RL_ROUTE', 'POST', '/api/leg', { from: P, to: { ...P, lat: 35.87 } }],
    ['RL_ROUTE', 'POST', '/api/route', { points: [P, { ...P, lat: 35.87 }] }],
    ['RL_CREATE', 'POST', '/api/maps', { title: 't', nickname: 'n' }],
  ])('%s: %s %s', async (name, method, path, body?) => {
    const res = await call(env([name]), method, path, body);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: '요청이 너무 많아요. 잠시 뒤 다시 해 주세요' });
  });

  it('지도 조회·닉네임·바꾸기·웹소켓은 각자 한도', async () => {
    const e = env();
    const { map, member } = await shared.createMap(e.DB, { title: 't', nickname: 'n' });
    const at = (over: string[]) => ({ ...env(over), DB: e.DB });
    expect((await call(at(['RL_READ']), 'GET', `/api/maps/${map.code}`)).status).toBe(429);
    expect((await call(at(['RL_JOIN']), 'POST', `/api/maps/${map.code}/members`, { nickname: 'x' })).status).toBe(429);
    expect((await call(at(['RL_WRITE']), 'POST', `/api/maps/${map.code}/markers`, { memberId: member.id, ...P })).status).toBe(429);
    expect((await call(at(['RL_WS']), 'GET', `/api/maps/${map.code}/ws`, undefined, { Upgrade: 'websocket' })).status).toBe(429);
    // 다른 기능 한도가 넘쳐도 조회는 됨
    expect((await call(at(['RL_WRITE', 'RL_JOIN']), 'GET', `/api/maps/${map.code}`)).status).toBe(200);
  });

  it('없는 코드를 자꾸 찌르면(코드 맞히기) 404 대신 429', async () => {
    expect((await call(env(), 'GET', '/api/maps/ZZZZ')).status).toBe(404);
    expect((await call(env(['RL_MISS']), 'GET', '/api/maps/ZZZZ')).status).toBe(429);
    expect((await call(env(['RL_MISS']), 'GET', '/api/maps/ZZZZ/ws', undefined, { Upgrade: 'websocket' })).status).toBe(429);
  });
});

describe('웹소켓 접속 조건', () => {
  it('Origin 이 없거나(브라우저가 아닌 봇) 다른 사이트면 거부', async () => {
    const e = env();
    const { map } = await shared.createMap(e.DB, { title: 't', nickname: 'n' });
    const ws = (origin?: string) => worker.fetch(new Request(`https://api.test/api/maps/${map.code}/ws`, {
      headers: { Upgrade: 'websocket', ...(origin ? { Origin: origin } : {}) } }), e as never, {} as never);
    expect((await ws()).status).toBe(403);
    expect((await ws('https://evil.example')).status).toBe(403);
    expect((await ws(ORIGIN)).status).toBe(204);   // 통과해서 방까지 감 (테스트용 방은 204)
  });

  const att = (k: number, ip: string, member = true): Attachment =>
    ({ sid: String(k), member: member ? { id: k, nickname: 'n' + k } : null, since: 'x', ip });

  it('방 하나에 전체·같은 IP·구경 연결 수 제한', () => {
    expect(admitError([], '1.1.1.1', false)).toBeNull();
    const many = Array.from({ length: ROOM_LIMITS.total }, (_, k) => att(k, `10.0.0.${k}`));
    expect(admitError(many, '9.9.9.9', false)).toMatch(/너무 많아요/);
    const sameIp = Array.from({ length: ROOM_LIMITS.perIp }, (_, k) => att(k, '1.1.1.1'));
    expect(admitError(sameIp, '1.1.1.1', false)).toMatch(/같은 곳/);
    expect(admitError(sameIp, '2.2.2.2', false)).toBeNull();
    const viewers = Array.from({ length: ROOM_LIMITS.viewers }, (_, k) => att(k, `10.0.1.${k}`, false));
    expect(admitError(viewers, '3.3.3.3', true)).toMatch(/구경/);
    expect(admitError(viewers, '3.3.3.3', false)).toBeNull();   // 닉네임 있는 사람은 들어올 수 있음
  });

  it('한도를 넘으면 방이 연결을 받기 전에 429', async () => {
    const sockets = Array.from({ length: ROOM_LIMITS.perIp }, (_, k) => ({ deserializeAttachment: () => att(k, '1.1.1.1') }));
    const room = new MapRoom({ getWebSockets: () => sockets } as never, {} as never);
    const res = await room.fetch(new Request('https://room/connect?ip=1.1.1.1&memberId=99&nickname=x', { headers: { Upgrade: 'websocket' } }));
    expect(res.status).toBe(429);
  });

  it('ping 이 아닌 메시지를 보내면 연결을 끊음', async () => {
    const mk = (a: Attachment) => ({ sent: [] as string[], closed: null as number | null, send(t: string) { this.sent.push(t); }, close(c: number) { this.closed = c; }, deserializeAttachment: () => a });
    const bot = mk(att(1, '1.1.1.1')), friend = mk(att(2, '2.2.2.2'));
    const room = new MapRoom({ getWebSockets: () => [bot, friend] } as never, {} as never);
    await room.webSocketMessage(bot as never, 'ping');
    expect(bot.sent).toEqual(['pong']);
    await room.webSocketMessage(bot as never, '{"type":"change","action":"marker.delete"}');
    expect(bot.closed).toBe(1008);
    expect(JSON.parse(friend.sent.at(-1)!)).toMatchObject({ type: 'presence', online: [{ id: 2 }] });
  });
});

describe('검색·AI 수집 금지', () => {
  it('robots.txt 와 모든 응답의 X-Robots-Tag', async () => {
    const r = await call(env(), 'GET', '/robots.txt');
    expect(await r.text()).toBe('User-agent: *\nDisallow: /\n');
    const h = await call(env(), 'GET', '/api/health');
    expect(h.headers.get('X-Robots-Tag')).toContain('noai');
  });
});

describe('정확한 요청 수 제한 (Guard)', () => {
  it('최근 60초 안에서만 세는 슬라이딩 윈도', async () => {
    const { slidingHit } = await import('../src/guard');
    let times: number[] = [], ok = 0;
    for (let k = 0; k < 12; k++) { const r = slidingHit(times, 1000 + k, 10, 60_000); times = r.times; if (r.ok) ok++; }
    expect(ok).toBe(10);                                                     // 10번까지만
    expect(slidingHit(times, 1000 + 60_000, 10, 60_000).ok).toBe(true);      // 1분 지나면 다시
  });

  it('Guard 가 있으면 코드 맞히기는 바인딩과 상관없이 정확히 막음', async () => {
    const { Guard } = await import('../src/guard');
    const guards = new Map<string, InstanceType<typeof Guard>>();
    const GUARD = { idFromName: (n: string) => n,
      // 실제 Durable Object 스텁처럼 주소 문자열을 Request 로 바꿔서 넘김
      get: (n: string) => { if (!guards.has(n)) guards.set(n, new Guard({} as never, {} as never)); const g = guards.get(n)!; return { fetch: (u: string) => g.fetch(new Request(u)) }; } };
    const e = { ...env(), GUARD };   // 바인딩은 전부 '통과'로 응답하는 상태 (실서비스처럼)
    const codes: number[] = [];
    for (let k = 0; k < 13; k++) codes.push((await call(e, 'GET', `/api/maps/Z${String(k).padStart(3, '0')}`)).status);
    expect(codes.filter(c => c === 404)).toHaveLength(10);
    expect(codes.slice(10)).toEqual([429, 429, 429]);
    // 다른 IP 는 따로 셈
    const other = await worker.fetch(new Request('https://api.test/api/maps/ZZZZ', { headers: { 'CF-Connecting-IP': '5.6.7.8' } }), e as never, {} as never);
    expect(other.status).toBe(404);
  });
});

describe('사람 확인 통과증 (Turnstile)', () => {
  const on = () => ({ ...env(), TURNSTILE_SECRET: 's3cret' });

  it('비밀키가 없으면 꺼져 있음 (통과증 없이 지금처럼)', async () => {
    expect((await call(env(), 'POST', '/api/maps', { title: 't', nickname: 'n' })).status).toBe(201);
    expect(await (await call(env(), 'POST', '/api/human', { token: 'x' })).json()).toEqual({ pass: null });
  });

  it('켜져 있으면 만들기·닉네임·변경·웹소켓에 통과증이 필요 (조회는 열려 있음)', async () => {
    const e = on();
    const { map, member } = await shared.createMap(e.DB, { title: 't', nickname: 'n' });
    const r = await call(e, 'POST', '/api/maps', { title: 't', nickname: 'n' });
    expect(r.status).toBe(401);
    expect(await r.json()).toMatchObject({ needHuman: true });
    expect((await call(e, 'POST', `/api/maps/${map.code}/members`, { nickname: 'x' })).status).toBe(401);
    expect((await call(e, 'POST', `/api/maps/${map.code}/markers`, { memberId: member.id, ...P })).status).toBe(401);
    expect((await call(e, 'GET', `/api/maps/${map.code}/ws`, undefined, { Upgrade: 'websocket' })).status).toBe(401);
    expect((await call(e, 'GET', `/api/maps/${map.code}`)).status).toBe(200);

    const { issuePass } = await import('../src/human');
    const { pass } = await issuePass(e as never);
    expect((await call(e, 'POST', '/api/maps', { title: 't', nickname: 'n' }, { 'X-Human-Pass': pass })).status).toBe(201);
    expect((await call(e, 'GET', `/api/maps/${map.code}/ws?pass=${encodeURIComponent(pass)}`, undefined, { Upgrade: 'websocket' })).status).toBe(204);
  });

  it('위조·만료·다른 키로 만든 통과증은 거부', async () => {
    const { issuePass, validPass, PASS_TTL_MS } = await import('../src/human');
    const e = on() as never;
    const { pass, exp } = await issuePass(e, 1000);
    expect(await validPass(e, pass, 2000)).toBe(true);
    expect(await validPass(e, pass, exp + 1)).toBe(false);                                   // 만료
    expect(await validPass(e, `${exp + PASS_TTL_MS}.${pass.split('.')[1]}`, 2000)).toBe(false); // 만료 시각 늘리기
    expect(await validPass({ TURNSTILE_SECRET: 'other' } as never, pass, 2000)).toBe(false);   // 다른 키
    expect(await validPass(e, 'garbage', 2000)).toBe(false);
  });
});
