// 사람 확인 (Cloudflare Turnstile) → 24시간짜리 '통과증(pass)'
// - POST /api/human { token }: 화면에서 받은 Turnstile 토큰을 Cloudflare 에 확인하고 통과증을 발급
// - 지도 만들기·닉네임·모든 변경·웹소켓 연결은 통과증이 있어야 함 (X-Human-Pass 헤더, 웹소켓은 ?pass=)
// - TURNSTILE_SECRET 이 없으면 전부 꺼짐 (통과증 없이 지금처럼 동작)
// 통과증 = "<만료 시각(ms)>.<HMAC-SHA256 서명>". 서버만 아는 키로 서명해서 위조할 수 없음. IP 는 묶지 않음(폰이 와이파이↔LTE 로 바뀌어도 유지)
import type { Env } from './types';

export class NeedHuman extends Error {}

export const PASS_TTL_MS = 24 * 60 * 60 * 1000;
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const enabled = (env: Env) => !!env.TURNSTILE_SECRET;
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sign(env: Env, data: string): Promise<string> {
  // 통과증 서명 키는 Turnstile 비밀키에서 만듦 (비밀값을 하나 더 늘리지 않으려고)
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`marker-pass:${env.TURNSTILE_SECRET}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

export async function issuePass(env: Env, now = Date.now()): Promise<{ pass: string; exp: number }> {
  const exp = now + PASS_TTL_MS;
  return { pass: `${exp}.${await sign(env, String(exp))}`, exp };
}

export async function validPass(env: Env, pass: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!pass) return false;
  const [exp, sig] = pass.split('.');
  if (!exp || !sig || !(Number(exp) > now)) return false;
  return sig === await sign(env, exp);
}

/** 통과증이 필요한 요청에서 호출. 꺼져 있으면 그냥 통과 */
export async function requireHuman(env: Env, pass: string | null | undefined): Promise<void> {
  if (!enabled(env)) return;
  if (!(await validPass(env, pass))) throw new NeedHuman('사람 확인이 필요해요. 잠시 뒤 다시 해 주세요');
}

/** Turnstile 토큰 확인 → 통과증. 허용된 사이트에서 받은 토큰인지(hostname)도 확인 */
export async function verifyHuman(env: Env, body: unknown, ip: string): Promise<{ pass: string | null; exp?: number }> {
  if (!enabled(env)) return { pass: null };   // 꺼져 있음: 화면은 통과증 없이 계속
  const token = typeof body === 'object' && body && 'token' in body ? String((body as { token: unknown }).token) : '';
  if (!token || token.length > 2048) throw new NeedHuman('사람 확인 토큰이 없어요');
  const form = new FormData();
  form.set('secret', env.TURNSTILE_SECRET!);
  form.set('response', token);
  if (ip !== 'unknown') form.set('remoteip', ip);
  const res = await fetch(SITEVERIFY, { method: 'POST', body: form });
  const out = await res.json() as { success: boolean; hostname?: string; 'error-codes'?: string[]; metadata?: { result_with_testing_key?: boolean } };
  const hosts = (env.ALLOWED_ORIGINS ?? '').split(',').map(o => { try { return new URL(o.trim()).hostname; } catch { return ''; } });
  // 시험용 키(비밀키가 시험용일 때만 나옴)는 hostname 이 늘 example.com 이라 건너뜀
  const hostOk = out.metadata?.result_with_testing_key || !out.hostname || hosts.includes(out.hostname);
  if (!out.success || !hostOk) {
    throw new NeedHuman(`사람 확인에 실패했어요${out['error-codes']?.length ? ` (${out['error-codes'].join(', ')})` : ''}`);
  }
  return issuePass(env);
}
