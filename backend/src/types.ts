export type Mode = 'car' | 'transit' | 'walk';

export interface Place { name: string; lat: number; lng: number }

export interface Leg { min: number; walk: boolean }

export interface Env {
  KAKAO_REST_KEY?: string;
  ALLOWED_ORIGINS?: string;
  DB: D1Database;
  /** 지도 번호마다 하나인 지도 방 (src/room.ts) */
  ROOMS: DurableObjectNamespace;
  /** 요청 수 제한 (wrangler.toml [[ratelimits]], src/security.ts). 없으면 제한하지 않음 */
  RL_WS?: RateLimit; RL_MISS?: RateLimit; RL_READ?: RateLimit; RL_WRITE?: RateLimit;
  RL_CREATE?: RateLimit; RL_JOIN?: RateLimit; RL_SEARCH?: RateLimit; RL_ROUTE?: RateLimit;
}
