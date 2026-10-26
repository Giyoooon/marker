// 지도 방 (Cloudflare Durable Object, 지도 번호마다 하나)
// - 웹소켓으로 접속한 사람들을 알고 있다가, 접속·종료 때마다 접속자 목록(presence)을 모두에게 보냄
// - 지도가 바뀌면 Worker 가 POST /broadcast 로 변경(ChangeEvent)을 넘기고, 방이 접속한 모두에게 전달
// 웹소켓 Hibernation API 를 써서, 아무도 말하지 않을 땐 방이 잠들어도 연결은 유지됨
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

/** 연결마다 붙여 두는 정보. member 가 없으면 닉네임 없이 구경 중 */
export interface Attachment { sid: string; member: { id: number; nickname: string } | null; since: string }

export interface Presence {
  type: 'presence';
  /** 지금 접속 중인 닉네임 (같은 사람이 탭 여러 개면 한 번만, tabs 로 개수) */
  online: { id: number; nickname: string; since: string; tabs: number }[];
  /** 닉네임 없이 보고 있는 연결 수 */
  viewers: number;
}

/** 연결 목록 → 접속자 목록 */
export function presenceOf(conns: Attachment[]): Presence {
  const byId = new Map<number, Presence['online'][number]>();
  let viewers = 0;
  for (const c of conns) {
    if (!c.member) { viewers++; continue; }
    const cur = byId.get(c.member.id);
    if (cur) { cur.tabs++; if (c.since < cur.since) cur.since = c.since; }
    else byId.set(c.member.id, { id: c.member.id, nickname: c.member.nickname, since: c.since, tabs: 1 });
  }
  return { type: 'presence', online: [...byId.values()].sort((a, b) => a.since.localeCompare(b.since)), viewers };
}

/** 화면이 이 간격으로 'ping' 을 보냄 (room.js 와 맞출 것) */
export const PING_MS = 15_000;
/** 마지막 ping 뒤 이만큼 지나면 나간 것으로 봄 (화면을 끄거나 앱을 강제로 닫아서 종료 신호 없이 끊긴 경우) */
export const STALE_MS = 40_000;
/** 접속자가 있는 동안 이 간격으로 오래된 연결을 정리 */
export const SWEEP_MS = 15_000;

export class MapRoom extends DurableObject<Env> {
  /** 방금 정리해서 닫았지만 아직 getWebSockets() 에 남아 있을 수 있는 연결 */
  private closing = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // 'ping' 에는 방을 깨우지 않고 런타임이 바로 'pong' 으로 답함. 마지막으로 답한 시각은 연결마다 기록됨
    if (typeof WebSocketRequestResponsePair !== 'undefined') {
      this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  private live(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter(ws => ws !== except && !this.closing.has(ws));
  }
  private conns(except?: WebSocket): Attachment[] {
    return this.live(except).map(ws => ws.deserializeAttachment() as Attachment).filter(Boolean);
  }
  private send(data: unknown, except?: WebSocket) {
    const text = JSON.stringify(data);
    for (const ws of this.live(except)) {
      try { ws.send(text); } catch { /* 이미 끊긴 연결 */ }
    }
  }
  private sendPresence(except?: WebSocket) { this.send(presenceOf(this.conns(except)), except); }

  /** 연결의 마지막 생존 신호 시각: 마지막 ping 자동 응답, 아직 없으면 접속 시각 */
  private lastSeen(ws: WebSocket): number {
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp?.(ws);
    if (pinged) return pinged.getTime();
    const a = ws.deserializeAttachment() as Attachment | null;
    return a ? Date.parse(a.since) : 0;
  }
  private async scheduleSweep() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/broadcast' && req.method === 'POST') {
      this.send(await req.json());
      return new Response(null, { status: 204 });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('웹소켓으로 연결해 주세요', { status: 426 });

    // Worker 가 D1 에서 확인한 닉네임만 넘겨줌 (클라이언트가 보낸 값을 그대로 믿지 않음)
    const id = Number(url.searchParams.get('memberId'));
    const nickname = url.searchParams.get('nickname');
    const attachment: Attachment = {
      sid: crypto.randomUUID(),
      member: Number.isInteger(id) && id > 0 && nickname ? { id, nickname } : null,
      since: new Date().toISOString(),
    };
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    this.sendPresence();
    await this.scheduleSweep();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** 오래 신호가 없는 연결을 닫고 남은 사람들에게 바뀐 접속자 목록을 보냄. 접속자가 남아 있으면 다음 점검 예약 */
  async alarm() {
    const now = Date.now();
    const stale = this.live().filter(ws => now - this.lastSeen(ws) > STALE_MS);
    for (const ws of stale) {
      this.closing.add(ws);
      try { ws.close(4000, '응답 없음'); } catch { /* 이미 끊김 */ }
    }
    if (stale.length) this.sendPresence();
    if (this.live().length) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // 보통 'ping' 은 자동 응답이 처리함. 변경은 반드시 HTTP API 로 (누가 했는지 D1 에서 확인하려고)
    if (message === 'ping') ws.send('pong');
  }
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.closing.add(ws);
    try { ws.close(code === 1005 ? 1000 : code, reason); } catch { /* 이미 닫힘 */ }   // 닫힘에 답해야 연결이 바로 정리됨
    this.sendPresence(ws);
  }
  async webSocketError(ws: WebSocket) {
    this.closing.add(ws);
    this.sendPresence(ws);
  }
}
