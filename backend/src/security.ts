// 봇·자동화 대비 보안 규칙 (요청 수 제한, 웹소켓 접속 조건, 크롤러 차단)
// - 요청 수 제한은 wrangler.toml [[ratelimits]] 바인딩 (IP 마다, Cloudflare 위치별 근사치)
// - 바인딩이 없으면(테스트·로컬 일부) 제한하지 않음
import type { Env } from './types';

export class TooMany extends Error {}

export type Limiter = 'RL_WS' | 'RL_MISS' | 'RL_READ' | 'RL_WRITE' | 'RL_CREATE' | 'RL_JOIN' | 'RL_SEARCH' | 'RL_ROUTE';

/** 요청한 쪽 IP. Cloudflare 가 붙여 주는 헤더라 클라이언트가 바꿀 수 없음 */
export const clientIp = (req: Request) => req.headers.get('CF-Connecting-IP') ?? 'unknown';

/** 한도를 넘었으면 TooMany (→ 429). 같은 IP 라도 기능마다 따로 셈 */
export async function limit(env: Env, name: Limiter, key: string): Promise<void> {
  const rl = env[name];
  if (!rl) return;
  const { success } = await rl.limit({ key });
  if (!success) throw new TooMany('요청이 너무 많아요. 잠시 뒤 다시 해 주세요');
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
