// 정확한 요청 수 제한 (Durable Object, IP 마다 하나)
// Cloudflare 의 [[ratelimits]] 바인딩은 위치별 근사치라 실제 서비스에서 짧은 몰림을 거의 막지 못해서,
// 봇 대비에 꼭 필요한 곳(코드 맞히기, 웹소켓 연결, 지도·닉네임 만들기)은 여기서 정확히 셈
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

/** 최근 window 초 안의 요청 시각들로 세는 슬라이딩 윈도. hit 하면 기록하고, 한도를 넘었으면 false */
export function slidingHit(times: number[], now: number, limit: number, windowMs: number): { ok: boolean; times: number[] } {
  const recent = times.filter(t => now - t < windowMs);
  if (recent.length >= limit) return { ok: false, times: recent };
  recent.push(now);
  return { ok: true, times: recent };
}

export class Guard extends DurableObject<Env> {
  /** 버킷 이름 → 최근 요청 시각 (메모리. 방이 잠들면 비워지지만, 잠들 만큼 조용하면 셀 것도 없음) */
  private buckets = new Map<string, number[]>();

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const bucket = url.searchParams.get('bucket') ?? 'default';
    const limit = Number(url.searchParams.get('limit')) || 10;
    const windowMs = (Number(url.searchParams.get('window')) || 60) * 1000;
    const r = slidingHit(this.buckets.get(bucket) ?? [], Date.now(), limit, windowMs);
    this.buckets.set(bucket, r.times);
    return Response.json({ ok: r.ok }, { status: r.ok ? 200 : 429 });
  }
}
