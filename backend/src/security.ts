// 봇·자동화 대비 보안 규칙 (요청 수 제한, 웹소켓 접속 조건, 크롤러 차단)
// 요청 수 제한은 두 겹, IP 마다 기능별로:
//   1) wrangler.toml [[ratelimits]] 바인딩 — 빠르지만 Cloudflare 위치별 근사치라 실제 서비스에선 거의 막지 못했음(2026-10-27 측정)
//   2) Guard Durable Object (src/guard.ts) — 정확. 봇 대비에 꼭 필요한 곳(EXACT)만: 코드 맞히기·웹소켓·만들기·닉네임
// 바인딩·Guard 가 없으면(테스트) 그 겹은 건너뜀
import type { Env } from './types';

export class TooMany extends Error {}

export type Limiter = 'RL_WS' | 'RL_MISS' | 'RL_READ' | 'RL_WRITE' | 'RL_CREATE' | 'RL_JOIN' | 'RL_SEARCH' | 'RL_ROUTE' | 'RL_HUMAN';

/** Guard 로 정확히 세는 것: 분당 한도 (wrangler.toml 의 같은 이름 바인딩과 맞출 것) */
export const EXACT: Partial<Record<Limiter, number>> = { RL_MISS: 10, RL_WS: 20, RL_CREATE: 3, RL_JOIN: 10, RL_HUMAN: 10 };

/** 요청한 쪽 IP. Cloudflare 가 붙여 주는 헤더라 클라이언트가 바꿀 수 없음 */
export const clientIp = (req: Request) => req.headers.get('CF-Connecting-IP') ?? 'unknown';

const tooMany = () => new TooMany('요청이 너무 많아요. 잠시 뒤 다시 해 주세요');

/** 한도를 넘었으면 TooMany (→ 429). 같은 IP 라도 기능마다 따로 셈 */
export async function limit(env: Env, name: Limiter, key: string): Promise<void> {
  const rl = name === 'RL_HUMAN' ? undefined : env[name];   // RL_HUMAN 은 Guard 로만 셈
  if (rl && !(await rl.limit({ key })).success) throw tooMany();
  const exact = EXACT[name];
  if (exact && env.GUARD) {
    const q = new URLSearchParams({ bucket: name, limit: String(exact), window: '60' });
    const res = await env.GUARD.get(env.GUARD.idFromName(key)).fetch(`https://guard/hit?${q}`);
    if (res.status === 429) throw tooMany();
  }
}

/** 웹소켓은 허용된 사이트에서 연 것만. Origin 이 없으면(브라우저가 아닌 봇·스크립트) 거부 */
export function allowedOrigin(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return !!origin && allowed.includes(origin);
}

/** 지도 방 한 곳에 받는 연결 수 (src/room.ts 에서 사용) */
export const ROOM_LIMITS = {
  /** 전체 연결 */
  total: 60,
  /** 같은 IP (집·회사 와이파이에서 여럿이 쓰는 경우를 생각해 넉넉히) */
  perIp: 8,
  /** 닉네임 없이 구경하는 연결 */
  viewers: 30,
};

/** API 는 검색·AI 수집 대상이 아님 */
export const ROBOTS_TXT = 'User-agent: *\nDisallow: /\n';
export const NO_INDEX = { 'X-Robots-Tag': 'noindex, nofollow, noarchive, noai, noimageai' };
