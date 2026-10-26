// 화면·상태 관리. 경로 계산과 장소 검색은 백엔드(marker-api)가 담당
const CONFIG = window.MARKER_CONFIG || {};
const API = (CONFIG.API_BASE || '').replace(/\/+$/, '');
const MODES = { car: ['🚗', 'car'], transit: ['🚌', 'traffic'], walk: ['🚶', 'walk'] };
const CATS = {
  stay:  { icon: '🏨', name: '숙소', color: '#3B5BDB' },
  food:  { icon: '🍽️', name: '맛집', color: '#E03131' },
  cafe:  { icon: '☕', name: '카페', color: '#B7791F' },
  sight: { icon: '📸', name: '명소', color: '#2B8A3E' },
  etc:   { icon: '📌', name: '기타', color: '#7048E8' },
};
// 카카오 카테고리 그룹 코드 → 분류
const GROUP_CAT = { AD5: 'stay', FD6: 'food', CE7: 'cafe', AT4: 'sight', CT1: 'sight' };
const ROUTE_COLOR = '#1E2A44';
const DEFAULT_VIEW = { lat: 35.86, lng: 128.6, level: 8 };   // 대구
const MAX_MARKERS = 31;   // 카카오 다중 경유지 길찾기 한도(32) — 숙소 왕복이면 출발지가 한 번 더 들어감

// ───────────── 유틸 ─────────────
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const human = m => { m = Math.round(m); if (m < 60) return m + '분'; const h = Math.floor(m / 60), r = m % 60; return h + '시간' + (r ? ' ' + r + '분' : ''); };
const uid = () => Math.random().toString(36).slice(2, 9);
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2200); };
const b64enc = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
const posKey = p => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
const cat = m => CATS[m.cat] || CATS.etc;

async function api(path, body) {
  const res = await fetch(API + path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `서버 응답 ${res.status}`);
  return data;
}

// ───────────── 상태 ─────────────
// markers: 목록 순서 = 방문 순서. on 이 꺼진 마커는 지도에만 남고 경로에서 빠짐
// loop: 경로에 숙소가 있으면 숙소에서 출발해 숙소로 돌아옴
let state = { mode: 'car', loop: true, markers: [] };
let filter = 'all';
let searchResults = [];
let clickPlace = null;
let routeInfo = null;    // 마지막 /api/route 응답 + 어떤 경로에 대한 응답인지(key)
let routeSeq = 0, routeTimer = null;

const pick = m => ({ id: m.id || 'm' + uid(), name: m.name, lat: m.lat, lng: m.lng, cat: CATS[m.cat] ? m.cat : 'etc', on: m.on !== false });
function fromSaved(obj) {
  const list = obj.markers || obj.route || [];   // 예전 버전의 '내 경로' 도 그대로 가져옴
  return {
    mode: MODES[obj.mode] ? obj.mode : 'car',
    loop: obj.loop !== false,
    markers: list.filter(p => p && isFinite(p.lat) && isFinite(p.lng)).map(pick),
  };
}
const serialize = () => JSON.stringify({ mode: state.mode, loop: state.loop,
  markers: state.markers.map(({ name, lat, lng, cat, on }) => ({ name, lat, lng, cat, ...(on ? {} : { on: false }) })) });
function save() { localStorage.setItem('marker-trip', serialize()); }
function load() {
  try {
    const m = location.hash.match(/^#t=(.+)$/);
    if (m) {
      history.replaceState(null, '', location.pathname);
      toast('공유받은 마커를 불러왔어요');
      return fromSaved(JSON.parse(b64dec(m[1])));
    }
    const raw = localStorage.getItem('marker-trip');
    if (raw) return fromSaved(JSON.parse(raw));
  } catch (e) { console.warn(e); }
  return { mode: 'car', loop: true, markers: [] };
}

const isMarked = p => state.markers.some(m => posKey(m) === posKey(p));
function mark(p) {
  if (isMarked(p)) { toast('이미 마킹한 곳이에요'); return; }
  if (state.markers.length >= MAX_MARKERS) { toast(`마커는 ${MAX_MARKERS}개까지 꽂을 수 있어요`); return; }
  const m = pick({ name: p.name || '이름 없는 곳', lat: p.lat, lng: p.lng, cat: p.cat });
  state.markers.push(m);
  KMap.ready() && KMap.closePopup();
  if (filter !== 'all' && filter !== m.cat) filter = 'all';
  changed();
  renderResults();
  toast(`${cat(m).icon} ${m.name} 마킹했어요`);
}

// ───────────── 경로 ─────────────
/** 지금 상태에서 실제로 이어지는 경로. stay 가 있으면 [숙소, ...stops, 숙소] 왕복 */
function routePlan() {
  const on = state.markers.filter(m => m.on);
  const stay = state.loop ? on.find(m => m.cat === 'stay') || null : null;
  const stops = stay ? on.filter(m => m !== stay) : on;
  const points = stay ? [stay, ...stops] : stops;
  return { stay, stops, points, roundTrip: !!stay && stops.length > 0 };
}
const routeKey = P => [state.mode, P.roundTrip ? 'loop' : 'line', ...P.points.map(posKey)].join('|');
function currentRoute(P = routePlan()) {
  return routeInfo && routeInfo.key === routeKey(P) && !routeInfo.error ? routeInfo : null;
}
const routeBody = (P, extra = {}) => ({ mode: state.mode, roundTrip: P.roundTrip,
  points: P.points.map(({ name, lat, lng }) => ({ name, lat, lng })), ...extra });

function changed() {
  render();
  save();
  clearTimeout(routeTimer);
  if (routePlan().points.length >= 2) routeTimer = setTimeout(fetchRoute, 300);
}
async function fetchRoute() {
  const seq = ++routeSeq, P = routePlan(), key = routeKey(P);
  let info;
  try { info = await api('/api/route', routeBody(P)); }
  catch (e) { info = { error: e.message }; }
  if (seq !== routeSeq) return;   // 그 사이 경로가 또 바뀌었으면 버림
  routeInfo = { ...info, key };
  render();
}

// 순서를 바꿀 곳이 두 곳 이상일 때만 의미 있음 (출발지·숙소는 고정)
const canOptimize = P => (P.roundTrip ? P.stops.length >= 2 : P.points.length >= 3);
async function optimize() {
  const P = routePlan();
  if (!canOptimize(P)) return;
  const btn = $('#optBtn');
  btn.disabled = true; btn.textContent = '정렬하는 중…';
  clearTimeout(routeTimer);
  const seq = ++routeSeq;
  try {
    const info = await api('/api/route', routeBody(P, { optimize: true }));
    if (seq !== routeSeq) return;
    // 경로에 든 마커들이 차지하던 목록 자리에 새 순서대로 다시 채움 (빠진 마커와 숙소는 제자리)
    const ordered = info.order.map(i => P.points[i]);
    const moving = P.roundTrip ? ordered.slice(1) : ordered;
    const slots = (P.roundTrip ? P.stops : P.points).map(m => state.markers.indexOf(m)).sort((a, b) => a - b);
    const before = state.markers.map(m => m.id).join();
    slots.forEach((pos, k) => { state.markers[pos] = moving[k]; });
    routeInfo = { ...info, key: routeKey(routePlan()) };
    render(); save(); fitAll();
    toast(before === state.markers.map(m => m.id).join() ? '이미 가장 짧은 순서예요' : `가장 짧은 순서로 바꿨어요 · ${human(info.totalMin)}`);
  } catch (e) {
    toast('정렬하지 못했어요: ' + e.message);
  } finally {
    btn.textContent = '최단 순서로 정렬';
    btn.disabled = !canOptimize(routePlan());
  }
}
function swap(i, j) {
  if (j < 0 || j >= state.markers.length) return;
  [state.markers[i], state.markers[j]] = [state.markers[j], state.markers[i]];
  changed();
}
/** from 번째 마커를 to 자리(원래 배열 기준 삽입 위치)로 옮김 */
function move(from, to) {
  if (to > from) to--;
  if (to === from) return;
  const [p] = state.markers.splice(from, 1);
  state.markers.splice(to, 0, p);
  changed();
}
function fitAll() {
  if (!KMap.ready() || !state.markers.length) return;
  KMap.fit(currentRoute()?.path || state.markers.map(p => [p.lat, p.lng]));
}

// ───────────── 화면 ─────────────
function kakaoLink(a, b, by) {
  const part = p => `${encodeURIComponent(p.name.replace(/[,/]/g, ' '))},${p.lat},${p.lng}`;
  return `https://map.kakao.com/link/by/${by}/${part(a)}/${part(b)}`;
}
const kakaoTo = p => `https://map.kakao.com/link/to/${encodeURIComponent(p.name.replace(/[,/]/g, ' '))},${p.lat},${p.lng}`;

function legInner(leg, a, b, prefix = '') {
  if (leg.km === 0) return `<span class="what">${prefix}같은 자리</span>`;
  const [icon, by] = leg.walk ? ['🚶', 'walk'] : MODES[state.mode];
  const [h, m] = leg.min >= 60 ? [Math.floor(leg.min / 60), leg.min % 60] : [0, leg.min];
  const time = h ? `<b>${h}</b>시간${m ? ` <b>${m}</b>분` : ''}` : `<b>${m}</b>분`;
  return `<span class="what">${prefix}${icon} ${time} <b>${leg.km}</b>km</span>
    <a class="go" href="${kakaoLink(a, b, by)}" target="_blank" rel="noopener" title="${esc(a.name)} → ${esc(b.name)} 카카오맵 길찾기">길찾기</a>`;
}

/** 목록·지도에 공통으로 쓰는 경로 정보: 마커별 번호와 '다음 곳까지' 구간 */
function routeView() {
  const P = routePlan(), info = currentRoute(P);
  const num = new Map(), legAfter = new Map();
  (P.stay ? P.stops : P.points).forEach((m, i) => num.set(m.id, i + 1));
  let firstLeg = null;
  if (info) {
    const seq = P.roundTrip ? [...P.points, P.stay] : P.points;
    seq.slice(0, -1).forEach((m, k) => {
      const leg = { leg: info.legs[k], from: m, to: seq[k + 1], back: P.roundTrip && k === seq.length - 2 };
      if (P.roundTrip && k === 0) firstLeg = leg; else legAfter.set(m.id, leg);
    });
  }
  return { P, info, num, legAfter, firstLeg };
}

function renderList() {
  const M = state.markers, { P, info, num, legAfter, firstLeg } = routeView();
  const box = $('#markers');
  if (!M.length) {
    box.innerHTML = `<p class="hint">위에서 장소를 검색해 <b>마킹</b>하거나, 지도를 눌러 원하는 자리에 핀을 꽂으세요.<br>
      목록 순서대로 경로가 이어지고, 체크를 끄면 경로에서 빠져요.</p>`;
    return;
  }
  let html = '';

  // 분류 필터
  const counts = {};
  M.forEach(m => { counts[m.cat] = (counts[m.cat] || 0) + 1; });
  html += `<div class="filters" role="group" aria-label="분류로 보기">
    <button class="chip" data-act="filter" data-f="all" aria-pressed="${filter === 'all'}">전체 <span class="n">${M.length}</span></button>
    ${Object.entries(CATS).filter(([k]) => counts[k]).map(([k, c]) =>
      `<button class="chip" data-act="filter" data-f="${k}" aria-pressed="${filter === k}">${c.icon} ${c.name} <span class="n">${counts[k]}</span></button>`).join('')}
  </div>`;

  // 경로 상태 안내
  if (P.points.length >= 2 && !info) {
    const err = routeInfo && routeInfo.key === routeKey(P) && routeInfo.error;
    if (err) html += `<div class="note">경로를 불러오지 못했어요: ${esc(err)}</div>`;
  }
  info?.warnings.forEach(w => html += `<div class="note">${esc(w)}</div>`);

  // 마커 목록 (구간은 '전체' 보기에서만 — 걸러 보면 앞뒤 순서가 안 보여서)
  // 숙소 왕복이면 숙소를 맨 위 출발지로 고정해서 보여 줌 (목록 안 실제 자리와 상관없이)
  const showLegs = filter === 'all';
  const stayCand = M.find(m => m.on && m.cat === 'stay');
  let rows = M.map((m, i) => ({ m, i })).filter(({ m }) => filter === 'all' || m.cat === filter);
  if (P.stay) rows = [...rows.filter(r => r.m === P.stay), ...rows.filter(r => r.m !== P.stay)];
  html += '<ol class="list">';
  rows.forEach(({ m, i }) => {
    const c = cat(m), pinned = P.stay === m;
    const badge = pinned ? '🏨' : num.get(m.id) ?? '–';
    html += `<li class="row ${m.on ? '' : 'off'} ${pinned ? 'pinned' : ''}" ${pinned ? '' : 'draggable="true"'} data-i="${i}" style="--c:${c.color}">
      <input type="checkbox" class="inc" data-i="${i}" ${m.on ? 'checked' : ''} aria-label="${esc(m.name)} 경로에 포함">
      <span class="grip" title="${pinned ? '숙소는 출발지로 고정돼요' : '끌어서 순서 바꾸기'}" aria-hidden="true">${pinned ? '' : '⠿'}</span>
      <span class="num" title="${pinned ? '출발·복귀' : m.on ? '방문 순서' : '경로에서 빠짐'}">${badge}</span>
      <span class="name" data-act="focus" data-i="${i}" title="${esc(m.name)}">${esc(m.name)}</span>
      <label class="cat" title="분류: ${c.name}"><span aria-hidden="true">${c.icon}</span>
        <select class="cat-sel" data-i="${i}" aria-label="${esc(m.name)} 분류">
          ${Object.entries(CATS).map(([k, cc]) => `<option value="${k}" ${k === m.cat ? 'selected' : ''}>${cc.icon} ${cc.name}</option>`).join('')}
        </select></label>
      <button class="icon-btn" data-act="up" data-i="${i}" ${i === 0 || pinned ? 'disabled' : ''} aria-label="위로">▲</button>
      <button class="icon-btn" data-act="down" data-i="${i}" ${i === M.length - 1 || pinned ? 'disabled' : ''} aria-label="아래로">▼</button>
      <button class="icon-btn del" data-act="del" data-i="${i}" aria-label="${esc(m.name)} 삭제">✕</button>
    </li>`;
    // 첫 숙소 바로 아래: 출발·복귀 스위치와 첫 구간
    if (m === stayCand && showLegs) {
      html += `<li class="leg loop" data-at="${i + 1}">
        <label class="switch"><input type="checkbox" id="loopToggle" ${state.loop ? 'checked' : ''}><span></span></label>
        <label for="loopToggle" class="loop-label">숙소에서 출발해서 돌아오기</label>
      </li>`;
      if (state.loop && firstLeg) html += `<li class="leg" data-at="${i + 1}">${legInner(firstLeg.leg, firstLeg.from, firstLeg.to)}</li>`;
    }
    const leg = showLegs && legAfter.get(m.id);
    if (leg) html += `<li class="leg" data-at="${i + 1}">${legInner(leg.leg, leg.from, leg.to, leg.back ? '🏨 숙소로 ' : '')}</li>`;
  });
  html += '</ol>';
  if (!rows.length) html += '<p class="hint">이 분류에는 아직 마커가 없어요.</p>';
  box.innerHTML = html;
}

function renderFoot() {
  const P = routePlan(), info = currentRoute(P);
  const stopsCount = P.stops.length + (P.stay && !P.roundTrip ? 1 : 0);
  let html = '';
  if (info) {
    html = `<span class="big">${human(info.totalMin)}</span><span class="big">${info.totalKm}km</span>
      <span class="muted">${P.roundTrip ? `숙소 왕복, ${P.stops.length}곳` : `${P.points.length}곳`}${info.source === 'kakao' ? '' : ', 직선거리 추정'}</span>`;
  } else if (P.points.length >= 2) {
    html = '<span class="muted">경로를 계산하고 있어요…</span>';
  } else if (state.markers.length) {
    html = `<span class="muted">${stopsCount ? '경로에 한 곳 더 넣으면 이동시간이 나와요' : '체크한 마커가 경로로 이어져요'}</span>`;
  }
  $('#totals').innerHTML = html;
  $('#optBtn').disabled = !canOptimize(P);
  $('#mode').value = state.mode;
}

function renderMap() {
  if (!KMap.ready()) return;
  KMap.clear('manual');
  const { P, info, num } = routeView();
  if (P.points.length >= 2) {
    const seq = P.roundTrip ? [...P.points, P.stay] : P.points;
    const path = info?.path || seq.map(p => [p.lat, p.lng]);
    KMap.line('manual', path, '#FFFFFF', { weight: 9, opacity: 0.9, dashed: !info?.path });
    KMap.line('manual', path, ROUTE_COLOR, { weight: 5, opacity: 0.9, dashed: !info?.path });
  }
  state.markers.forEach((m, i) => {
    const c = cat(m), inRoute = m.on, isLoopStay = P.stay === m;
    KMap.pin('manual', {
      lat: m.lat, lng: m.lng, color: c.color, drop: true, cls: inRoute ? '' : 'off',
      label: isLoopStay ? '🏨' : inRoute ? num.get(m.id) : c.icon,
      size: inRoute ? 32 : 24, z: inRoute ? 60 : 30,
      title: `${inRoute && !isLoopStay ? num.get(m.id) + '. ' : ''}${m.name}`,
      onClick: () => openMarkerPopup(i),
    });
  });
}
function openMarkerPopup(i) {
  const m = state.markers[i], c = cat(m);
  KMap.openPopup(m.lat, m.lng, `<span class="title">${esc(m.name)}</span>
    <div class="tag" style="--c:${c.color}">${c.icon} ${c.name}${m.on ? '' : ', 경로에서 빠짐'}</div>
    <div class="actions">
      <a class="btn sm" href="${kakaoTo(m)}" target="_blank" rel="noopener">여기로 길찾기</a>
      <button class="btn sm" data-act="toggleOn" data-i="${i}">${m.on ? '경로에서 빼기' : '경로에 넣기'}</button>
      <button class="btn sm danger" data-act="del" data-i="${i}">삭제</button>
    </div>`);
}
function render() { renderList(); renderFoot(); renderMap(); }

// ───────────── 장소 검색 (백엔드 → 카카오 로컬) ─────────────
function markButton(p, src) {
  return isMarked(p) ? '<button class="mark" disabled>마킹됨</button>'
    : `<button class="mark" data-act="mark" data-src="${src}">마킹</button>`;
}
function renderResults() {
  const box = $('#results');
  if (!searchResults.length) return;
  box.innerHTML = searchResults.map((r, i) => {
    const c = CATS[GROUP_CAT[r.group] || 'etc'];
    return `<div class="res">
      <span class="res-ic" style="--c:${c.color}" aria-hidden="true">${c.icon}</span>
      <div class="info" data-act="showResult" data-i="${i}">
        <span class="name">${esc(r.name)}</span><span class="cat">${esc(r.category)}</span>
        <div class="addr">${esc(r.addr)}</div>
      </div>${markButton(r, 'res:' + i)}</div>`;
  }).join('') + '<div class="res-foot"><button class="link-btn" data-act="closeResults">검색 결과 닫기</button></div>';
  if (!KMap.ready()) return;
  KMap.clear('base');
  searchResults.forEach((r, i) => KMap.pin('base', { lat: r.lat, lng: r.lng, color: ROUTE_COLOR, size: 16, z: 10, title: r.name,
    onClick: () => showResult(i) }));
}
function showResult(i) {
  const r = searchResults[i];
  if (!KMap.ready()) return;
  KMap.focus(r.lat, r.lng);
  KMap.openPopup(r.lat, r.lng, `<span class="title">${esc(r.name)}</span><div class="addr">${esc(r.addr)}</div>
    <div class="actions">${markButton(r, 'res:' + i)}</div>`);
}
$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  const box = $('#results');
  box.innerHTML = '<p class="hint">찾는 중…</p>';
  const near = KMap.ready() ? KMap.center() : DEFAULT_VIEW;
  try {
    searchResults = await api(`/api/search?${new URLSearchParams({ q, lat: near.lat, lng: near.lng })}`);
    if (!searchResults.length) { box.innerHTML = '<p class="hint">검색 결과가 없어요. 다른 이름으로 찾거나 지도를 눌러 직접 꽂으세요.</p>'; return; }
    renderResults();
    KMap.ready() && KMap.fit(searchResults.map(r => [r.lat, r.lng]));
  } catch (err) {
    box.innerHTML = `<p class="hint">검색하지 못했어요 (${esc(err.message)}). 지도를 눌러 직접 꽂을 수 있어요.</p>`;
  }
});
function closeResults() {
  searchResults = [];
  $('#results').innerHTML = '';
  KMap.ready() && (KMap.clear('base'), KMap.closePopup());
}

function onMapClick(lat, lng) {
  clickPlace = { lat, lng };
  const el = KMap.openPopup(lat, lng, `<span class="title">여기에 마킹</span>
    <input type="text" id="clickName" placeholder="이름 (예: 우리 숙소)" aria-label="이름">
    <div class="cat-pick" role="radiogroup" aria-label="분류">
      ${Object.entries(CATS).map(([k, c]) => `<label style="--c:${c.color}"><input type="radio" name="clickCat" value="${k}" ${k === 'etc' ? 'checked' : ''}><span>${c.icon} ${c.name}</span></label>`).join('')}
    </div>
    <div class="actions"><button class="mark" data-act="mark" data-src="click">마킹</button></div>`);
  const input = el.querySelector('input[type=text]');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') markClicked(); });
  setTimeout(() => input.focus(), 50);
}
function markClicked() {
  mark({ ...clickPlace, name: $('#clickName')?.value.trim(), cat: document.querySelector('input[name=clickCat]:checked')?.value });
}

// ───────────── 이벤트 ─────────────
document.addEventListener('click', onAction);
function onAction(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, i = +el.dataset.i;
  if (act === 'mark') {
    if (el.dataset.src === 'click') markClicked();
    else { const r = searchResults[+el.dataset.src.split(':')[1]]; mark({ ...r, cat: GROUP_CAT[r.group] || 'etc' }); }
  } else if (act === 'showResult') showResult(i);
  else if (act === 'closeResults') closeResults();
  else if (act === 'closePopup') KMap.closePopup();
  else if (act === 'filter') { filter = el.dataset.f; renderList(); }
  else if (act === 'focus') { const p = state.markers[i]; if (KMap.ready()) { KMap.focus(p.lat, p.lng); openMarkerPopup(i); } }
  else if (act === 'up') swap(i, i - 1);
  else if (act === 'down') swap(i, i + 1);
  else if (act === 'toggleOn') { state.markers[i].on = !state.markers[i].on; KMap.ready() && KMap.closePopup(); changed(); }
  else if (act === 'del') {
    const [m] = state.markers.splice(i, 1);
    KMap.ready() && KMap.closePopup();
    changed(); renderResults();
    toast(`${m.name} 삭제했어요`);
  }
  else if (act === 'optimize') optimize();
  else if (act === 'share') {
    const url = location.origin + location.pathname + '#t=' + b64enc(serialize());
    navigator.clipboard.writeText(url).then(() => toast('공유 링크를 복사했어요'), () => prompt('아래 링크를 복사하세요', url));
  }
}
$('#markers').addEventListener('change', e => {
  const el = e.target, i = +el.dataset.i;
  if (el.classList.contains('inc')) state.markers[i].on = el.checked;
  else if (el.classList.contains('cat-sel')) state.markers[i].cat = el.value;
  else if (el.id === 'loopToggle') state.loop = el.checked;
  else return;
  changed();
});
$('#mode').addEventListener('change', e => { state.mode = e.target.value; changed(); });

// 끌어서 놓기: 마커 행 위에서는 위/아래 절반에 따라 앞/뒤로, 구간 행 위에서는 그 사이로 삽입
let dragFrom = null;
const list = $('#markers');
function dropTarget(e) {
  const row = e.target.closest('li.row, li.leg');
  if (!row) return null;
  if (row.classList.contains('leg')) return { row, to: +row.dataset.at, cls: 'drop-on' };
  const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
  return { row, to: +row.dataset.i + (after ? 1 : 0), cls: after ? 'drop-after' : 'drop-before' };
}
const clearDropMarks = () => list.querySelectorAll('.drop-before, .drop-after, .drop-on')
  .forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-on'));
list.addEventListener('dragstart', e => {
  const li = e.target.closest('li.row');
  if (!li) return;
  dragFrom = +li.dataset.i;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
});
list.addEventListener('dragover', e => {
  if (dragFrom == null) return;
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  clearDropMarks();
  t.row.classList.add(t.cls);
});
list.addEventListener('drop', e => {
  if (dragFrom == null) return;
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  move(dragFrom, t.to);
});
list.addEventListener('dragend', () => {
  dragFrom = null;
  clearDropMarks();
  list.querySelector('.dragging')?.classList.remove('dragging');
});

// ───────────── 시작 ─────────────
function showMapError(html) { const el = $('#mapError'); el.innerHTML = `<div>${html}</div>`; el.classList.add('on'); }

(async function start() {
  state = load();
  try {
    await KMap.init($('#map'), { appKey: CONFIG.KAKAO_JS_KEY, center: [DEFAULT_VIEW.lat, DEFAULT_VIEW.lng], level: DEFAULT_VIEW.level,
      onClick: onMapClick, onAction });
  } catch (e) {
    showMapError(`카카오맵을 불러오지 못했어요: ${esc(e.message)}<br>
      카카오 개발자 콘솔 > 앱 > 플랫폼 > Web 에 <b>${esc(location.origin)}</b> 가 등록돼 있는지 확인하세요.`);
  }
  changed();
  fitAll();
})();
