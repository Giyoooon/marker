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

export class MapRoom extends DurableObject<Env> {
  private conns(except?: WebSocket): Attachment[] {
    return this.ctx.getWebSockets().filter(ws => ws !== except).map(ws => ws.deserializeAttachment() as Attachment).filter(Boolean);
  }
  private send(data: unknown, except?: WebSocket) {
    const text = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(text); } catch { /* 이미 끊긴 연결 */ }
    }
  }
  private sendPresence(except?: WebSocket) { this.send(presenceOf(this.conns(except)), except); }

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
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // 연결 유지용 ping 에만 답함. 변경은 반드시 HTTP API 로 (누가 했는지 D1 에서 확인하려고)
    if (message === 'ping') ws.send('pong');
  }
  async webSocketClose(ws: WebSocket) { this.sendPresence(ws); }
  async webSocketError(ws: WebSocket) { this.sendPresence(ws); }
}
