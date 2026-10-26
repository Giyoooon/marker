// 공유 지도 API (Cloudflare D1)
//   POST   /api/maps                         지도 만들기 { title, nickname } → { map, member }
//   GET    /api/maps/:code                   지도 + 닉네임 + 마커(마킹한 사람, 마지막으로 바꾼 사람 포함)
//   GET    /api/maps/:code/ws?memberId=      웹소켓: 접속자 목록(presence)과 변경 알림 (src/room.ts)
//   PATCH  /api/maps/:code                   { memberId, title?, mode?, loop? }
//   POST   /api/maps/:code/members           닉네임으로 들어가기 { nickname } (이미 있는 닉네임이면 그 사람으로)
//   POST   /api/maps/:code/markers           마킹 { memberId, name, lat, lng, cat? } → 경로 맨 끝
//   PATCH  /api/maps/:code/markers/:id       { memberId, name?, cat?, on? } — on 을 바꾸면 경로 맨 끝 / 뺀 곳 맨 아래로
//   DELETE /api/maps/:code/markers/:id?memberId=
//   PUT    /api/maps/:code/order             { memberId, ids } 경로에 든 마커의 새 순서
// 바꾸는 요청은 모두 누가 했는지(memberId)가 필요하고, 결과에 함께 돌려주는 event 를 지도 방(웹소켓)에 알림
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
  marked_by: number | null; nickname: string | null; updated_by: number | null; updater: string | null;
  created_at: string; updated_at: string;
}
type Who = { id: number; nickname: string };

/** 지도 방에 알리는 변경. by 는 바꾼 사람 */
export interface ChangeEvent {
  type: 'change';
  action: 'map.update' | 'member.join' | 'marker.add' | 'marker.update' | 'marker.delete' | 'order';
  by: Who;
  marker?: { id: number; name: string };
  changes?: Record<string, unknown>;
  at: string;
  /** 변경을 보낸 화면(탭) id (X-Client-Id). 방에 알릴 때 index.ts 가 붙임 */
  client?: string;
}

const mapOut = (r: MapRow) => ({ code: r.code, title: r.title, mode: r.mode, loop: !!r.loop, createdAt: r.created_at, updatedAt: r.updated_at });
const memberOut = (r: MemberRow) => ({ id: r.id, nickname: r.nickname, createdAt: r.created_at, updatedAt: r.updated_at });
const markerOut = (r: MarkerRow) => ({
  id: r.id, name: r.name, lat: r.lat, lng: r.lng, cat: r.cat, on: !!r.included,
  markedBy: r.marked_by == null ? null : { id: r.marked_by, nickname: r.nickname },
  updatedBy: r.updated_by == null ? null : { id: r.updated_by, nickname: r.updater },
  createdAt: r.created_at, updatedAt: r.updated_at,
});
const who = (m: MemberRow): Who => ({ id: m.id, nickname: m.nickname });
const event = (action: ChangeEvent['action'], by: MemberRow, extra: Partial<ChangeEvent> = {}): ChangeEvent =>
  ({ type: 'change', action, by: who(by), at: new Date().toISOString(), ...extra });

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
  if (!CODE.test(c)) throw new BadRequest('지도 코드는 영문 대문자와 숫자 4자리예요');
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
  if (!row) throw new NotFound('없는 지도 코드예요');
  return row;
}
/** 지도가 있는지만 (웹소켓 접속 등 지도 내용이 필요 없을 때) */
export async function mapExists(db: D1Database, code: string): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS ok FROM maps WHERE code = ?').bind(code).first());
}
/** 이 지도의 닉네임인지 확인. 바꾸는 요청은 모두 이걸로 누가 했는지 확인함 */
export async function memberOf(db: D1Database, code: string, memberId: unknown): Promise<MemberRow> {
  const id = Number(memberId);
  const row = Number.isInteger(id)
    ? await db.prepare('SELECT * FROM members WHERE id = ? AND map_code = ?').bind(id, code).first<MemberRow>()
    : null;
  if (!row) {
    // 닉네임 확인이 곧 지도 확인이라 따로 지도를 먼저 읽지 않음. 실패했을 때만 지도가 없는 건지 가려서 알려 줌
    if (!(await mapExists(db, code))) throw new NotFound('없는 지도 코드예요');
    throw new BadRequest('memberId: 이 지도의 닉네임이 아니에요. 닉네임을 다시 정해 주세요');
  }
  return row;
}
const MARKER_SELECT = `SELECT m.*, u.nickname, w.nickname AS updater FROM markers m
  LEFT JOIN members u ON u.id = m.marked_by LEFT JOIN members w ON w.id = m.updated_by`;
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
  throw new Error('지도 코드를 만들지 못했어요');
}

export async function updateMap(db: D1Database, code: string, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  const by = await memberOf(db, code, body.memberId);
  const sets: string[] = [], args: unknown[] = [], changes: Record<string, unknown> = {};
  if (body.title !== undefined) { changes.title = text(body.title, '제목', 60); sets.push('title = ?'); args.push(changes.title); }
  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode as Mode)) throw new BadRequest('mode: car | transit | walk');
    changes.mode = body.mode; sets.push('mode = ?'); args.push(body.mode);
  }
  if (body.loop !== undefined) { changes.loop = !!body.loop; sets.push('loop = ?'); args.push(body.loop ? 1 : 0); }
  if (!sets.length) throw new BadRequest('바꿀 값(title, mode, loop)이 없어요');
  await db.prepare(`UPDATE maps SET ${sets.join(', ')} WHERE code = ?`).bind(...args, code).run();
  return { map: mapOut(await getMapRow(db, code)), event: event('map.update', by, { changes }) };
}

/** 닉네임으로 들어가기. 이미 있는 닉네임이면 그 사람으로 들어감 (로그인 없이 기기에 기억하는 방식) */
export async function joinMap(db: D1Database, code: string, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  await getMapRow(db, code);
  const nickname = text(body.nickname, '닉네임', 20);
  const existing = await db.prepare('SELECT * FROM members WHERE map_code = ? AND nickname = ?').bind(code, nickname).first<MemberRow>();
  if (existing) return { member: memberOut(existing), created: false };
  try {
    const row = (await db.prepare('INSERT INTO members (map_code, nickname) VALUES (?, ?) RETURNING *').bind(code, nickname).first<MemberRow>())!;
    return { member: memberOut(row), created: true, event: event('member.join', row) };
  } catch (e) {
    if (!isUniqueError(e)) throw e;   // 동시에 같은 닉네임을 만든 경우
    const row = await db.prepare('SELECT * FROM members WHERE map_code = ? AND nickname = ?').bind(code, nickname).first<MemberRow>();
    return { member: memberOut(row!), created: false };
  }
}

export async function addMarker(db: D1Database, code: string, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  const by = await memberOf(db, code, body.memberId);
  const name = text(body.name, '이름', 80);
  const lat = coord(body.lat, 'lat', 32, 39.5), lng = coord(body.lng, 'lng', 124, 132);
  const c = cat(body.cat);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM markers WHERE map_code = ?').bind(code).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_MARKERS) throw new Conflict(`마커는 지도마다 ${MAX_MARKERS}개까지 새길 수 있어요`);
  try {
    const row = await db.prepare(
      'INSERT INTO markers (map_code, marked_by, name, lat, lng, cat, included, position) VALUES (?, ?, ?, ?, ?, ?, 1, ?) RETURNING id',
    ).bind(code, by.id, name, lat, lng, c, await nextPosition(db, code, 1)).first<{ id: number }>();
    const marker = markerOut(await markerRow(db, code, row!.id));
    return { marker, event: event('marker.add', by, { marker: { id: marker.id, name }, changes: { cat: c } }) };
  } catch (e) {
    if (isUniqueError(e)) throw new Conflict('이미 마킹한 곳이에요');
    throw e;
  }
}

export async function updateMarker(db: D1Database, code: string, id: number, body: unknown) {
  if (!isObj(body)) throw new BadRequest('JSON 객체가 필요해요');
  const current = await markerRow(db, code, id);
  const by = await memberOf(db, code, body.memberId);
  const sets: string[] = [], args: unknown[] = [], changes: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = text(body.name, '이름', 80);
    if (name !== current.name) { changes.name = name; sets.push('name = ?'); args.push(name); }
  }
  if (body.cat !== undefined) {
    const c = cat(body.cat);
    if (c !== current.cat) { changes.cat = c; sets.push('cat = ?'); args.push(c); }
  }
  if (body.on !== undefined) {
    const on = body.on ? 1 : 0;
    if (on !== current.included) {
      // 경로에 넣으면 경로 맨 끝, 빼면 뺀 곳 맨 아래
      changes.on = !!on;
      sets.push('included = ?', 'position = ?');
      args.push(on, await nextPosition(db, code, on));
    }
  }
  if (!sets.length) return { marker: markerOut(current) };   // 바뀐 게 없으면 알리지 않음
  sets.push('updated_by = ?'); args.push(by.id);
  await db.prepare(`UPDATE markers SET ${sets.join(', ')} WHERE id = ? AND map_code = ?`).bind(...args, id, code).run();
  return {
    marker: markerOut(await markerRow(db, code, id)),
    event: event('marker.update', by, { marker: { id, name: current.name }, changes }),
  };
}

export async function deleteMarker(db: D1Database, code: string, id: number, memberId: unknown) {
  const current = await markerRow(db, code, id);
  const by = await memberOf(db, code, memberId);
  await db.prepare('DELETE FROM markers WHERE id = ? AND map_code = ?').bind(id, code).run();
  return { deleted: id, event: event('marker.delete', by, { marker: { id, name: current.name } }) };
}

/** 경로에 든 마커의 순서를 ids 순서로. ids 는 지금 경로에 든 마커 전부여야 함 */
export async function reorder(db: D1Database, code: string, body: unknown) {
  if (!isObj(body) || !Array.isArray(body.ids)) throw new BadRequest('ids: 마커 id 배열이 필요해요');
  const by = await memberOf(db, code, body.memberId);
  const ids = body.ids.map(Number);
  const rows = await db.prepare('SELECT id, position FROM markers WHERE map_code = ? AND included = 1 ORDER BY position, id')
    .bind(code).all<{ id: number }>();
  const current = new Set(rows.results.map(r => r.id));
  if (ids.length !== current.size || new Set(ids).size !== ids.length || !ids.every(i => current.has(i))) {
    throw new Conflict('그 사이 마커가 바뀌었어요. 새로고침한 뒤 다시 해 주세요');
  }
  const same = rows.results.every((r, k) => r.id === ids[k]);
  if (!same) {
    await db.batch(ids.map((mid, k) => db.prepare('UPDATE markers SET position = ? WHERE id = ? AND map_code = ?').bind(k, mid, code)));
  }
  return { ...(await getMap(db, code)), ...(same ? {} : { event: event('order', by) }) };
}
