// 공유 지도 API (Cloudflare D1)
//   POST   /api/maps                         지도 만들기 { title, nickname } → { map, member }
//   GET    /api/maps/:code                   지도 + 닉네임 + 마커(마킹한 사람 포함)
//   PATCH  /api/maps/:code                   { title?, mode?, loop? }
//   POST   /api/maps/:code/members           닉네임으로 들어가기 { nickname } (이미 있는 닉네임이면 그 사람으로)
//   POST   /api/maps/:code/markers           마킹 { memberId, name, lat, lng, cat? } → 경로 맨 끝
//   PATCH  /api/maps/:code/markers/:id       { name?, cat?, on? } — on 을 바꾸면 경로 맨 끝 / 뺀 곳 맨 아래로
//   DELETE /api/maps/:code/markers/:id
//   PUT    /api/maps/:code/order             { ids } 경로에 든 마커의 새 순서
import type { Mode } from './types';
import { BadRequest } from './validate';

export class NotFound extends Error {}
export class Conflict extends Error {}

const CODE = /^[A-Z0-9]{4}$/;
const CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const CATS = ['stay', 'food', 'cafe', 'sight', 'etc'] as const;
const MODES: Mode[] = ['car', 'transit', 'walk'];
/** 카카오 다중 경유지 한도에 맞춘 지도당 마커 수 (숙소 왕복이면 출발지가 한 번 더 들어감) */
export const MAX_MARKERS = 31;

// ───────── 응답 형식 ─────────
interface MapRow { code: string; title: string; mode: Mode; loop: number; created_at: string; updated_at: string }
interface MemberRow { id: number; nickname: string; created_at: string; updated_at: string }
interface MarkerRow {
  id: number; name: string; lat: number; lng: number; cat: string; included: number; position: number;
  marked_by: number | null; nickname: string | null; created_at: string; updated_at: string;
}
const mapOut = (r: MapRow) => ({ code: r.code, title: r.title, mode: r.mode, loop: !!r.loop, createdAt: r.created_at, updatedAt: r.updated_at });
const memberOut = (r: MemberRow) => ({ id: r.id, nickname: r.nickname, createdAt: r.created_at, updatedAt: r.updated_at });
const markerOut = (r: MarkerRow) => ({
  id: r.id, name: r.name, lat: r.lat, lng: r.lng, cat: r.cat, on: !!r.included,
  markedBy: r.marked_by == null ? null : { id: r.marked_by, nickname: r.nickname },
  createdAt: r.created_at, updatedAt: r.updated_at,
});

// ───────── 입력 검증 ─────────
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new BadRequest(`${field}: 비어 있으면 안 돼요`);
  const s = v.trim().replace(/\s+/g, ' ');
  if ([...s].length > max) throw new BadRequest(`${field}: ${max}자까지 쓸 수 있어요`);
  return s;
}
function coord(v: unknown, field: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new BadRequest(`${field}: 대한민국 안의 좌표여야 해요`);
  return Math.round(n * 1e5) / 1e5;   // 같은 자리 판단을 프론트(소수 5자리)와 맞춤
}
function cat(v: unknown): string {
  if (v == null) return 'etc';
  if (!CATS.includes(v as typeof CATS[number])) throw new BadRequest(`cat: ${CATS.join(' | ')}`);
  return v as string;
}
export function normalizeCode(code: string): string {
  const c = code.toUpperCase();
  if (!CODE.test(c)) throw new BadRequest('지도 번호는 영문 대문자와 숫자 4자리예요');
  return c;
}
function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
const isUniqueError = (e: unknown) => /UNIQUE constraint failed/i.test(String(e));

// ───────── 조회 ─────────
async function getMapRow(db: D1Database, code: string): Promise<MapRow> {
  const row = await db.prepare('SELECT * FROM maps WHERE code = ?').bind(code).first<MapRow>();
  if (!row) throw new NotFound('없는 지도 번호예요');
  return row;
}
async function memberOf(db: D1Database, code: string, memberId: unknown): Promise<MemberRow> {
  const id = Number(memberId);
  const row = Number.isInteger(id)
    ? await db.prepare('SELECT * FROM members WHERE id = ? AND map_code = ?').bind(id, code).first<MemberRow>()
    : null;
  if (!row) throw new BadRequest('memberId: 이 지도의 닉네임이 아니에요. 닉네임을 다시 정해 주세요');
  return row;
}
const MARKER_SELECT = `SELECT m.*, u.nickname FROM markers m LEFT JOIN members u ON u.id = m.marked_by`;
async function markerRow(db: D1Database, code: string, id: number): Promise<MarkerRow> {
  const row = await db.prepare(`${MARKER_SELECT} WHERE m.id = ? AND m.map_code = ?`).bind(id, code).first<MarkerRow>();
  if (!row) throw new NotFound('없는 마커예요');
  return row;
}
/** 경로에 든 것끼리 / 뺀 것끼리 position 의 다음 값 */
async function nextPosition(db: D1Database, code: string, included: 0 | 1): Promise<number> {
  const r = await db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM markers WHERE map_code = ? AND included = ?')
    .bind(code, included).first<{ p: number }>();
  return r?.p ?? 0;
}

export async function getMap(db: D1Database, code: string) {
  const map = await getMapRow(db, code);
  const [members, markers] = await db.batch([
    db.prepare('SELECT * FROM members WHERE map_code = ? ORDER BY id').bind(code),
    db.prepare(`${MARKER_SELECT} WHERE m.map_code = ? ORDER BY m.included DESC, m.position, m.id`).bind(code),
  ]);
  return {
    map: mapOut(map),
    members: (members.results as unknown as MemberRow[]).map(memberOut),
    markers: (markers.results as unknown as MarkerRow[]).map(markerOut),
  };
}

// ───────── 변경 ─────────
export async function createMap(db: D1Database, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  const title = text(body.title, '제목', 60);
  const nickname = text(body.nickname, '닉네임', 20);
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = randomCode();
    try {
      await db.prepare('INSERT INTO maps (code, title) VALUES (?, ?)').bind(code, title).run();
    } catch (e) {
      if (isUniqueError(e)) continue;   // 번호가 겹치면 다시 뽑기
      throw e;
    }
    const member = await db.prepare('INSERT INTO members (map_code, nickname) VALUES (?, ?) RETURNING *').bind(code, nickname).first<MemberRow>();
    return { map: mapOut(await getMapRow(db, code)), member: memberOut(member!) };
  }
  throw new Error('지도 번호를 만들지 못했어요');
}

export async function updateMap(db: D1Database, code: string, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  await getMapRow(db, code);
  const sets: string[] = [], args: unknown[] = [];
  if (body.title !== undefined) { sets.push('title = ?'); args.push(text(body.title, '제목', 60)); }
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode as Mode)) throw new BadRequest('mode: car | transit | walk');
    sets.push('mode = ?'); args.push(body.mode);
  }
  if (body.loop !== undefined) { sets.push('loop = ?'); args.push(body.loop ? 1 : 0); }
  if (!sets.length) throw new BadRequest('바꿀 값(title, mode, loop)이 없어요');
  await db.prepare(`UPDATE maps SET ${sets.join(', ')} WHERE code = ?`).bind(...args, code).run();
  return { map: mapOut(await getMapRow(db, code)) };
}

/** 닉네임으로 들어가기. 이미 있는 닉네임이면 그 사람으로 들어감 (로그인 없이 기기에 기억하는 방식) */
export async function joinMap(db: D1Database, code: string, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  await getMapRow(db, code);
  const nickname = text(body.nickname, '닉네임', 20);
  const existing = await db.prepare('SELECT * FROM members WHERE map_code = ? AND nickname = ?').bind(code, nickname).first<MemberRow>();
  if (existing) return { member: memberOut(existing), created: false };
  try {
    const row = await db.prepare('INSERT INTO members (map_code, nickname) VALUES (?, ?) RETURNING *').bind(code, nickname).first<MemberRow>();
    return { member: memberOut(row!), created: true };
  } catch (e) {
    if (!isUniqueError(e)) throw e;   // 동시에 같은 닉네임을 만든 경우
    const row = await db.prepare('SELECT * FROM members WHERE map_code = ? AND nickname = ?').bind(code, nickname).first<MemberRow>();
    return { member: memberOut(row!), created: false };
  }
}

export async function addMarker(db: D1Database, code: string, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  await getMapRow(db, code);
  const member = await memberOf(db, code, body.memberId);
  const name = text(body.name, '이름', 80);
  const lat = coord(body.lat, 'lat', 32, 39.5), lng = coord(body.lng, 'lng', 124, 132);
  const c = cat(body.cat);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM markers WHERE map_code = ?').bind(code).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MARKERS) throw new Conflict(`마커는 지도마다 ${MAX_MARKERS}개까지 꽂을 수 있어요`);
  try {
    const row = await db.prepare(
      'INSERT INTO markers (map_code, marked_by, name, lat, lng, cat, included, position) VALUES (?, ?, ?, ?, ?, ?, 1, ?) RETURNING id',
    ).bind(code, member.id, name, lat, lng, c, await nextPosition(db, code, 1)).first<{ id: number }>();
    return { marker: markerOut(await markerRow(db, code, row!.id)) };
  } catch (e) {
    if (isUniqueError(e)) throw new Conflict('이미 마킹한 곳이에요');
    throw e;
  }
}

export async function updateMarker(db: D1Database, code: string, id: number, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  const current = await markerRow(db, code, id);
  const sets: string[] = [], args: unknown[] = [];
  if (body.name !== undefined) { sets.push('name = ?'); args.push(text(body.name, '이름', 80)); }
  if (body.cat !== undefined) { sets.push('cat = ?'); args.push(cat(body.cat)); }
  if (body.on !== undefined) {
    const on = body.on ? 1 : 0;
    if (on !== current.included) {
      // 경로에 넣으면 경로 맨 끝, 빼면 뺀 곳 맨 아래
      sets.push('included = ?', 'position = ?');
      args.push(on, await nextPosition(db, code, on));
    }
  }
  if (!sets.length) return { marker: markerOut(current) };
  await db.prepare(`UPDATE markers SET ${sets.join(', ')} WHERE id = ? AND map_code = ?`).bind(...args, id, code).run();
  return { marker: markerOut(await markerRow(db, code, id)) };
}

export async function deleteMarker(db: D1Database, code: string, id: number) {
  await markerRow(db, code, id);
  await db.prepare('DELETE FROM markers WHERE id = ? AND map_code = ?').bind(id, code).run();
  return { deleted: id };
}

/** 경로에 든 마커의 순서를 ids 순서로. ids 는 지금 경로에 든 마커 전부여야 함 */
export async function reorder(db: D1Database, code: string, body: unknown) {
  if (!isObj(body) || !Array.isArray(body.ids)) throw new BadRequest('ids: 마커 id 배열이 필요해요');
  await getMapRow(db, code);
  const ids = body.ids.map(Number);
  const rows = await db.prepare('SELECT id FROM markers WHERE map_code = ? AND included = 1').bind(code).all<{ id: number }>();
  const current = new Set(rows.results.map(r => r.id));
  if (ids.length !== current.size || new Set(ids).size !== ids.length || !ids.every(i => current.has(i))) {
    throw new Conflict('그 사이 마커가 바뀌었어요. 새로고침한 뒤 다시 해 주세요');
  }
  if (ids.length) {
    await db.batch(ids.map((mid, k) => db.prepare('UPDATE markers SET position = ? WHERE id = ? AND map_code = ?').bind(k, mid, code)));
  }
  return getMap(db, code);
}
