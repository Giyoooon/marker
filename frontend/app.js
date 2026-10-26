// 화면·상태 관리. 경로 계산과 장소 검색은 백엔드(marker-api)가 담당
const CONFIG = window.MARKER_CONFIG || {};
const API = (CONFIG.API_BASE || '').replace(/\/+$/, '');
const MODES = { car: ['🚗', '자동차', 'car'], transit: ['🚌', '대중교통', 'traffic'], walk: ['🚶', '도보', 'walk'] };
const DAY_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#c2255c'];

// ───────────── 유틸 ─────────────
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toMin = s => { const [h, m] = (s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
const human = m => { m = Math.round(m); if (m < 60) return m + '분'; const h = Math.floor(m / 60), r = m % 60; return h + '시간' + (r ? ' ' + r + '분' : ''); };
const uid = () => Math.random().toString(36).slice(2, 9);
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2200); };
const b64enc = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));

async function api(path, body) {
  const res = await fetch(API + path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `서버 응답 ${res.status}`);
  return data;
}

// ───────────── 상태 ─────────────
let REGIONS = {};
let state;
let lastPlan = null;
let searchResults = [];
let clickPlace = null;
let activeTab = 'setup';

function curatedSpots(region) {
  return (REGIONS[region]?.spots || []).map(s => ({ ...s, selected: false, must: false, custom: false }));
}
function defaultState() {
  const region = REGIONS.daegu ? 'daegu' : Object.keys(REGIONS)[0];
  return { region, days: 2, mode: 'car', dayTimes: [{ start: '10:00', end: '21:00' }, { start: '09:30', end: '19:00' }],
    lodging: null, firstStart: null, lastEnd: null, fixed: [], spots: curatedSpots(region), route: [] };
}
// 저장·공유 시에는 선택한 곳/직접 추가한 곳만 남겨 링크를 짧게 유지
function serialize() {
  return JSON.stringify({ ...state, spots: state.spots.filter(s => s.selected || s.custom) });
}
function hydrate(obj) {
  const s = { ...defaultState(), ...obj };
  if (!REGIONS[s.region]) s.region = defaultState().region;
  const saved = new Map((obj.spots || []).map(x => [x.id, x]));
  s.spots = curatedSpots(s.region).map(c => saved.has(c.id) ? { ...c, ...saved.get(c.id), custom: false } : c)
    .concat((obj.spots || []).filter(x => x.custom));
  syncDayTimes(s);
  return s;
}
function syncDayTimes(s) {
  while (s.dayTimes.length < s.days) s.dayTimes.push({ start: '09:00', end: '21:00' });
  s.dayTimes.length = s.days;
}
function save() { localStorage.setItem('marker-trip', serialize()); }
function load() {
  try {
    const m = location.hash.match(/^#t=(.+)$/);
    if (m) { const s = hydrate(JSON.parse(b64dec(m[1]))); history.replaceState(null, '', location.pathname); toast('공유받은 여행 계획을 불러왔어요'); return s; }
    const raw = localStorage.getItem('marker-trip');
    if (raw) return hydrate(JSON.parse(raw));
  } catch (e) { console.warn(e); }
  return defaultState();
}

// ───────────── 지도 표시 ─────────────
function placeActions(src) {
  return `<div class="chips">
    <button class="chip" data-act="pick" data-role="spot" data-src="${src}">+ 가볼 곳</button>
    <button class="chip" data-act="pick" data-role="fixed" data-src="${src}">+ 고정 일정</button>
    <button class="chip" data-act="pick" data-role="route" data-src="${src}">+ 내 경로</button>
    <button class="chip" data-act="pick" data-role="lodging" data-src="${src}">🏨 숙소</button>
    <button class="chip" data-act="pick" data-role="firstStart" data-src="${src}">첫날 출발지</button>
    <button class="chip" data-act="pick" data-role="lastEnd" data-src="${src}">마지막날 도착지</button>
  </div>`;
}
function onMapClick(lat, lng) {
  clickPlace = { lat, lng };
  const el = KMap.openPopup(lat, lng, `<b>이 위치를 추가</b><input id="clickName" placeholder="이름 (예: 우리 숙소)">${placeActions('click')}`);
  setTimeout(() => el.querySelector('input')?.focus(), 50);
}

function renderMarkers() {
  if (!KMap.ready()) return;
  KMap.clear('base');
  const planned = new Set();
  if (lastPlan) lastPlan.days.forEach(d => d.items.forEach(it => planned.add((it.fixed ? 'f:' : 's:') + it.id)));
  // 내 경로 탭에서는 경로에 넣은 곳을 번호 마커로만 보여 줌
  const onRoute = new Set(state.route.map(posKey));
  for (const s of state.spots) {
    if (planned.has('s:' + s.id) || (activeTab === 'route' && onRoute.has(posKey(s)))) continue;
    KMap.pin('base', { lat: s.lat, lng: s.lng, color: s.selected ? '#2f9e44' : '#adb5bd', label: s.must ? '★' : '',
      size: s.selected ? 18 : 14, title: s.name,
      onClick: () => KMap.openPopup(s.lat, s.lng, `<b>${esc(s.name)}</b>
        <button class="chip" data-act="toggle" data-id="${s.id}">${s.selected ? '선택 해제' : '✓ 가볼 곳으로 선택'}</button>
        <button class="chip" data-act="addRoute" data-id="${s.id}">+ 내 경로</button>`) });
  }
  for (const f of state.fixed) {
    if (planned.has('f:' + f.id)) continue;
    KMap.pin('base', { lat: f.lat, lng: f.lng, color: '#e03131', label: '📌', title: `${f.day}일차 ${f.time} ${f.name}`, z: 5 });
  }
  for (const [p, icon, label] of [[state.lodging, '🏨', '숙소'], [state.firstStart, '🚩', '첫날 출발지'], [state.lastEnd, '🏁', '마지막날 도착지']]) {
    if (p) KMap.pin('base', { lat: p.lat, lng: p.lng, color: '#343a40', label: icon, size: 26, title: `${label}: ${p.name}`, z: 20 });
  }
}

// ───────────── 사이드바 ─────────────
function placeBox(key, label) {
  const p = state[key];
  return `<label class="f"><span>${label}</span></label><div class="place">
    ${p ? `<span data-act="focus" data-lat="${p.lat}" data-lng="${p.lng}" style="cursor:pointer">${esc(p.name)}</span><button class="x" data-act="clear" data-key="${key}" title="지우기">✕</button>`
        : `<span class="empty">미정 — 위에서 검색하거나 지도를 클릭해서 지정</span>`}</div>`;
}
function renderSetup() {
  $('#tab-setup').innerHTML = `
    <label class="f"><span>지역 (추천 명소 목록이 바뀌어요)</span>
      <select data-field="region">${Object.entries(REGIONS).map(([k, r]) => `<option value="${k}" ${k === state.region ? 'selected' : ''}>${r.name}</option>`).join('')}</select></label>
    <div class="row" style="gap:16px">
      <label class="f"><span>여행 일수</span><select data-field="days">${[1, 2, 3, 4, 5, 6, 7].map(n => `<option ${n === state.days ? 'selected' : ''} value="${n}">${n === 1 ? '당일치기' : `${n - 1}박 ${n}일`}</option>`).join('')}</select></label>
      <label class="f"><span>이동수단</span><select data-field="mode">${Object.entries(MODES).map(([k, [i, l]]) => `<option value="${k}" ${k === state.mode ? 'selected' : ''}>${i} ${l}</option>`).join('')}</select></label>
    </div>
    <label class="f"><span>하루 활동 시간</span></label>
    ${state.dayTimes.map((t, i) => `<div class="row" style="margin-bottom:6px"><span class="num" style="background:${DAY_COLORS[i]}">${i + 1}</span>
      <input type="time" data-field="dayStart" data-i="${i}" value="${t.start}"> ~ <input type="time" data-field="dayEnd" data-i="${i}" value="${t.end}"></div>`).join('')}
    <div style="height:10px"></div>
    ${placeBox('lodging', '🏨 숙소 (매일 여기서 출발해서 돌아와요)')}
    ${placeBox('firstStart', '🚩 첫날 출발지 (예: 강릉역, 비우면 숙소)')}
    ${placeBox('lastEnd', '🏁 마지막날 도착지 (예: 기차역, 비우면 숙소)')}
    <div class="row" style="margin-top:8px">
      <button class="btn" data-act="sample">예시 불러오기 (강릉 1박 2일)</button>
      <button class="btn" data-act="reset">초기화</button>
    </div>`;
}
function renderFixed() {
  const list = [...state.fixed].sort((a, b) => a.day - b.day || toMin(a.time) - toMin(b.time));
  $('#tab-fixed').innerHTML = `
    <p class="hint">기차 도착, 식당 예약, 공연·체험처럼 <b>시간이 정해진 일정</b>이에요. 경로는 이 시간에 맞춰 짜집니다.<br>
    위에서 장소를 검색하거나 지도를 클릭한 뒤 <b>+ 고정 일정</b>을 누르세요.</p>
    ${list.length ? '' : '<p class="hint">아직 고정 일정이 없어요.</p>'}
    ${list.map(f => `<div class="item">
      <div class="top"><span class="name"><input data-field="fName" data-id="${f.id}" value="${esc(f.name)}"></span>
        <button class="x" data-act="delFixed" data-id="${f.id}" title="삭제">✕</button></div>
      <div class="opts">
        <select data-field="fDay" data-id="${f.id}">${state.dayTimes.map((_, i) => `<option value="${i + 1}" ${f.day === i + 1 ? 'selected' : ''}>${i + 1}일차</option>`).join('')}</select>
        <input type="time" data-field="fTime" data-id="${f.id}" value="${f.time}">
        <span>부터</span><input type="number" min="0" step="10" data-field="fDur" data-id="${f.id}" value="${f.dur}"><span>분</span>
        <a href="#" data-act="focus" data-lat="${f.lat}" data-lng="${f.lng}">지도</a>
      </div></div>`).join('')}`;
  $('#nFixed').textContent = state.fixed.length;
}
function spotRow(s) {
  return `<div class="item ${s.selected ? '' : 'off'}">
    <div class="top">
      <input type="checkbox" data-act="toggle" data-id="${s.id}" ${s.selected ? 'checked' : ''}>
      <span class="name" data-act="focus" data-lat="${s.lat}" data-lng="${s.lng}">${esc(s.name)}</span>
      <button class="star ${s.must ? 'on' : ''}" data-act="must" data-id="${s.id}" title="꼭 가기 (우선 배치)">⭐</button>
      ${s.custom ? `<button class="x" data-act="delSpot" data-id="${s.id}" title="삭제">✕</button>` : ''}
    </div>
    ${s.selected ? `<div class="opts">머무는 시간 <input type="number" min="10" step="10" data-field="sDur" data-id="${s.id}" value="${s.dur}"> 분</div>` : ''}
  </div>`;
}
function renderSpots() {
  const custom = state.spots.filter(s => s.custom), curated = state.spots.filter(s => !s.custom);
  const n = state.spots.filter(s => s.selected).length;
  $('#tab-spots').innerHTML = `
    <p class="hint">가고 싶은 곳을 체크하세요. 시간이 모자라면 일부는 빠질 수 있어요 — 꼭 가야 하는 곳은 ⭐를 눌러 두면 먼저 넣어요.</p>
    <div class="row" style="justify-content:space-between"><span class="summary" style="margin:0">${n}곳 선택됨</span>
      ${n ? '<button class="btn" data-act="clearSel">선택 모두 해제</button>' : ''}</div>
    ${custom.length ? `<h4 class="sec">직접 추가한 곳</h4>${custom.map(spotRow).join('')}` : ''}
    <h4 class="sec">${esc(REGIONS[state.region]?.name)} 추천 명소</h4>
    ${curated.map(spotRow).join('')}`;
  $('#nSpots').textContent = n;
}
function render() { renderSetup(); renderFixed(); renderSpots(); renderRoute(); renderMarkers(); drawManual(); save(); }
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
  // 내 경로 탭에서는 직접 정한 경로만, 다른 탭에서는 자동으로 짠 일정 경로만 지도에 표시
  if (KMap.ready()) {
    KMap.setVisible('manual', name === 'route');
    KMap.setVisible('route', name !== 'route');
    renderMarkers();
  }
}

// ───────────── 내 경로 (직접 순서 정하기 → /api/route) ─────────────
const MANUAL_COLOR = '#7048e8';
let routeInfo = null;   // 마지막 /api/route 응답 + 어떤 순서·이동수단에 대한 응답인지(key)
let routeSeq = 0, routeTimer = null;

const posKey = p => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
const routeKey = () => state.mode + '|' + state.route.map(posKey).join(';');
const routeInfoFor = () => (routeInfo && routeInfo.key === routeKey() && !routeInfo.error ? routeInfo : null);

function routeChanged() {
  renderRoute(); renderMarkers(); drawManual(); save();
  scheduleRoute();
}
function scheduleRoute() {
  clearTimeout(routeTimer);
  if (state.route.length >= 2) routeTimer = setTimeout(fetchRoute, 300);
}
async function fetchRoute() {
  const seq = ++routeSeq, key = routeKey();
  let info;
  try {
    info = await api('/api/route', { mode: state.mode, points: state.route.map(({ name, lat, lng }) => ({ name, lat, lng })) });
  } catch (e) {
    info = { error: e.message };
  }
  if (seq !== routeSeq) return;   // 그 사이 순서가 또 바뀌었으면 버림
  routeInfo = { ...info, key };
  renderRoute(); drawManual();
}
function swapRoute(i, j) {
  if (j < 0 || j >= state.route.length) return;
  [state.route[i], state.route[j]] = [state.route[j], state.route[i]];
  routeChanged();
}
/** from 번째 마커를 to 자리(원래 배열 기준 삽입 위치)로 옮김 */
function moveRoute(from, to) {
  if (to > from) to--;
  if (to === from) return;
  const [p] = state.route.splice(from, 1);
  state.route.splice(to, 0, p);
  routeChanged();
}

function routeLegHtml(leg, a, b) {
  if (leg.km === 0) return '같은 자리';
  const [icon, , by] = leg.walk ? ['🚶', '도보', 'walk'] : MODES[state.mode];
  return `${icon} ${human(leg.min)} · ${leg.km}km<a href="${kakaoLink(a, b, by)}" target="_blank" rel="noopener">길찾기 ↗</a>`;
}
function renderRoute() {
  const R = state.route, info = routeInfoFor();
  const err = routeInfo && routeInfo.key === routeKey() && routeInfo.error;
  $('#nRoute').textContent = R.length;
  let html = `<p class="hint">검색하거나 지도를 클릭해서 <b>+ 내 경로</b>로 마커를 넣고, <b>⠿를 끌어 놓거나 ▲▼</b>로 순서를 바꾸면 그 순서대로 지도에 경로가 그려져요.</p>`;
  if (!R.length) { $('#tab-route').innerHTML = html + '<p class="hint">아직 등록한 마커가 없어요.</p>'; return; }
  if (R.length >= 2) {
    html += info
      ? `<div class="summary">${R.length}곳 · 이동 ${human(info.totalMin)} · ${info.totalKm}km · ${info.source === 'kakao' ? '카카오모빌리티 실제 도로 기준' : '직선거리 기반 추정'}</div>`
      : err ? `<div class="note">경로를 불러오지 못했어요: ${esc(err)}</div>` : '<div class="summary">경로 계산 중…</div>';
    info?.warnings.forEach(w => html += `<div class="note">${esc(w)}</div>`);
  }
  html += '<ol class="rt-list">';
  R.forEach((p, i) => {
    if (i > 0) html += `<li class="rt-leg" data-at="${i}">${info ? routeLegHtml(info.legs[i - 1], R[i - 1], p) : '…'}</li>`;
    html += `<li class="rt" draggable="true" data-i="${i}">
      <span class="grip" title="끌어서 순서 바꾸기">⠿</span>
      <span class="num" style="background:${MANUAL_COLOR}">${i + 1}</span>
      <span class="rt-name" data-act="focus" data-lat="${p.lat}" data-lng="${p.lng}" title="${esc(p.name)}">${esc(p.name)}</span>
      <button class="x" data-act="rtMove" data-i="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} title="위로">▲</button>
      <button class="x" data-act="rtMove" data-i="${i}" data-d="1" ${i === R.length - 1 ? 'disabled' : ''} title="아래로">▼</button>
      <button class="x" data-act="rtDel" data-i="${i}" title="삭제">✕</button>
    </li>`;
  });
  html += `</ol><div class="row" style="margin-top:12px;flex-wrap:wrap">
    <button class="btn" data-act="rtReverse">⇅ 순서 뒤집기</button>
    <button class="btn" data-act="rtFit">전체 보기</button>
    <button class="btn" data-act="rtClear">모두 지우기</button></div>`;
  $('#tab-route').innerHTML = html;
}
function drawManual() {
  if (!KMap.ready()) return;
  KMap.clear('manual');
  const R = state.route, info = routeInfoFor();
  if (R.length >= 2) KMap.line('manual', info?.path || R.map(p => [p.lat, p.lng]), MANUAL_COLOR, !info?.path);
  R.forEach((p, i) => KMap.pin('manual', { lat: p.lat, lng: p.lng, color: MANUAL_COLOR, label: i + 1, size: 26, z: 60, title: `${i + 1}. ${p.name}` }));
}

// 끌어서 놓기: 마커 행 위에서는 위/아래 절반에 따라 앞/뒤로, 구간 행 위에서는 그 사이로 삽입
let dragFrom = null;
const tabRoute = $('#tab-route');
function dropTarget(e) {
  const row = e.target.closest('li.rt, li.rt-leg');
  if (!row) return null;
  if (row.classList.contains('rt-leg')) return { row, to: +row.dataset.at, cls: 'drop-on' };
  const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
  return { row, to: +row.dataset.i + (after ? 1 : 0), cls: after ? 'drop-after' : 'drop-before' };
}
const clearDropMarks = () => tabRoute.querySelectorAll('.drop-before, .drop-after, .drop-on')
  .forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-on'));
tabRoute.addEventListener('dragstart', e => {
  const li = e.target.closest('li.rt');
  if (!li) return;
  dragFrom = +li.dataset.i;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(dragFrom));
});
tabRoute.addEventListener('dragover', e => {
  if (dragFrom == null) return;
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  clearDropMarks();
  t.row.classList.add(t.cls);
});
tabRoute.addEventListener('drop', e => {
  if (dragFrom == null) return;
  const t = dropTarget(e);
  if (!t) return;
  e.preventDefault();
  moveRoute(dragFrom, t.to);
});
tabRoute.addEventListener('dragend', () => {
  dragFrom = null;
  clearDropMarks();
  tabRoute.querySelector('.dragging')?.classList.remove('dragging');
});
function viewRegion() {
  const r = REGIONS[state.region];
  if (r && KMap.ready()) KMap.setView(r.center[0], r.center[1], r.level);
}

// ───────────── 장소 검색 (백엔드 → 카카오 로컬) ─────────────
$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  const box = $('#results');
  box.innerHTML = '<p class="hint">검색 중…</p>';
  const [lat, lng] = REGIONS[state.region]?.center || [];
  try {
    searchResults = await api(`/api/search?${new URLSearchParams({ q, lat: lat ?? '', lng: lng ?? '' })}`);
    box.innerHTML = searchResults.length ? searchResults.map((r, i) => `<div class="res">
        <b data-act="focus" data-lat="${r.lat}" data-lng="${r.lng}" style="cursor:pointer">${esc(r.name)}</b><span class="cat">${esc(r.category)}</span>
        <div class="addr">${esc(r.addr)}</div>${placeActions('res:' + i)}</div>`).join('')
        + '<div class="row" style="justify-content:flex-end"><button class="chip" data-act="closeResults">닫기</button></div>'
      : '<p class="hint">결과가 없어요. 다른 이름으로 검색하거나 지도를 직접 클릭해서 추가하세요.</p>';
  } catch (err) {
    box.innerHTML = `<p class="hint">검색에 실패했어요 (${esc(err.message)}). 지도를 직접 클릭해서 추가할 수 있어요.</p>`;
  }
});

function addPlace(role, p) {
  const place = { name: p.name || '선택한 위치', lat: p.lat, lng: p.lng };
  if (role === 'spot') {
    state.spots.unshift({ id: 'c' + uid(), ...place, dur: 60, selected: true, must: false, custom: true });
    showTab('spots');
  } else if (role === 'fixed') {
    state.fixed.push({ id: 'f' + uid(), ...place, day: 1, time: '12:00', dur: 60 });
    showTab('fixed');
  } else if (role === 'route') {
    state.route.push({ id: 'r' + uid(), ...place });
    showTab('route');
    scheduleRoute();
  } else {
    state[role] = place;
    showTab('setup');
  }
  KMap.ready() && KMap.closePopup();
  render();
  toast(`'${place.name}' 추가됨`);
}

// ───────────── 이벤트 ─────────────
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.addEventListener('click', onAction);
const findSpot = id => state.spots.find(s => s.id === id);
const findFixed = id => state.fixed.find(f => f.id === id);

function onAction(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const { act, id } = el.dataset;
  if (act === 'pick') {
    const src = el.dataset.src;
    const p = src === 'click' ? { ...clickPlace, name: document.getElementById('clickName')?.value.trim() } : searchResults[+src.split(':')[1]];
    addPlace(el.dataset.role, p);
  } else if (act === 'toggle') {
    const s = findSpot(id); s.selected = !s.selected; KMap.ready() && KMap.closePopup(); render();
  } else if (act === 'must') {
    const s = findSpot(id); s.must = !s.must; if (s.must) s.selected = true; render();
  } else if (act === 'addRoute') {
    addPlace('route', findSpot(id));
  } else if (act === 'rtMove') {
    swapRoute(+el.dataset.i, +el.dataset.i + +el.dataset.d);
  } else if (act === 'rtDel') {
    state.route.splice(+el.dataset.i, 1); routeChanged();
  } else if (act === 'rtReverse') {
    state.route.reverse(); routeChanged();
  } else if (act === 'rtClear') {
    if (confirm('내 경로의 마커를 모두 지울까요?')) { state.route = []; routeChanged(); }
  } else if (act === 'rtFit') {
    KMap.ready() && KMap.fit(routeInfoFor()?.path || state.route.map(p => [p.lat, p.lng]));
  } else if (act === 'delSpot') {
    state.spots = state.spots.filter(s => s.id !== id); render();
  } else if (act === 'delFixed') {
    state.fixed = state.fixed.filter(f => f.id !== id); render();
  } else if (act === 'clearSel') {
    state.spots.forEach(s => { s.selected = false; s.must = false; }); render();
  } else if (act === 'clear') {
    state[el.dataset.key] = null; render();
  } else if (act === 'focus') {
    e.preventDefault(); KMap.ready() && KMap.focus(+el.dataset.lat, +el.dataset.lng);
  } else if (act === 'closePopup') {
    KMap.closePopup();
  } else if (act === 'closeResults') {
    $('#results').innerHTML = '';
  } else if (act === 'sample') {
    loadSample();
  } else if (act === 'reset') {
    if (confirm('모든 설정을 지울까요?')) { state = defaultState(); clearPlan(); render(); viewRegion(); }
  } else if (act === 'plan') {
    runPlan();
  } else if (act === 'share') {
    copy(location.origin + location.pathname + '#t=' + b64enc(serialize()), '공유 링크를 복사했어요. 단톡방에 붙여 넣으세요!');
  } else if (act === 'copyText') {
    copy(planText(), '일정을 텍스트로 복사했어요');
  }
}

document.addEventListener('change', e => {
  const el = e.target, f = el.dataset.field;
  if (!f) return;
  const v = el.value, i = +el.dataset.i;
  switch (f) {
    case 'region':
      state.region = v;
      state.spots = curatedSpots(v).concat(state.spots.filter(s => s.custom));
      viewRegion();
      break;
    case 'days': state.days = +v; syncDayTimes(state); break;
    case 'mode': state.mode = v; if (state.route.length) routeChanged(); break;
    case 'dayStart': state.dayTimes[i].start = v; break;
    case 'dayEnd': state.dayTimes[i].end = v; break;
    case 'fName': findFixed(el.dataset.id).name = v; break;
    case 'fDay': findFixed(el.dataset.id).day = +v; break;
    case 'fTime': findFixed(el.dataset.id).time = v; break;
    case 'fDur': findFixed(el.dataset.id).dur = Math.max(0, +v || 0); break;
    case 'sDur': findSpot(el.dataset.id).dur = Math.max(5, +v || 60); break;
  }
  if (['region', 'days', 'fDay', 'fTime'].includes(f)) render(); else { renderMarkers(); save(); }
});

function copy(text, msg) {
  navigator.clipboard.writeText(text).then(() => toast(msg), () => prompt('아래 내용을 복사하세요', text));
}

function loadSample() {
  state = hydrate({
    region: 'gangneung', days: 2, mode: 'car',
    dayTimes: [{ start: '10:00', end: '21:30' }, { start: '09:30', end: '18:30' }],
    lodging: { name: '숙소 (경포 근처)', lat: 37.8000, lng: 128.9050 },
    firstStart: { name: '강릉역', lat: 37.7638, lng: 128.8997 },
    lastEnd: { name: '강릉역', lat: 37.7638, lng: 128.8997 },
    fixed: [
      { id: 'f1', name: '점심: 초당순두부', lat: 37.7905, lng: 128.9135, day: 1, time: '12:30', dur: 60 },
      { id: 'f2', name: '저녁 예약: 주문진 회센터', lat: 37.8939, lng: 128.8265, day: 1, time: '18:30', dur: 90 },
      { id: 'f3', name: '점심: 중앙시장 닭강정', lat: 37.7545, lng: 128.8990, day: 2, time: '12:00', dur: 60 },
    ],
    spots: ['gn1', 'gn3', 'gn5', 'gn12', 'gn13', 'gn2', 'gn11', 'gn7'].map(id => ({ id, selected: true, must: id === 'gn12' })),
  });
  clearPlan();
  viewRegion();
  render();
  toast('예시를 불러왔어요. 경로 짜기를 눌러 보세요!');
}

// ───────────── 경로 계산 (백엔드 /api/plan) ─────────────
function planRequest() {
  const pick = p => (p ? { name: p.name, lat: p.lat, lng: p.lng } : null);
  return {
    mode: state.mode,
    days: state.dayTimes.map((t, d) => ({
      start: t.start, end: t.end,
      from: pick(d === 0 ? (state.firstStart || state.lodging) : state.lodging),
      to: pick(d === state.days - 1 ? (state.lastEnd || state.lodging) : state.lodging),
    })),
    fixed: state.fixed.map(({ id, name, lat, lng, day, time, dur }) => ({ id, name, lat, lng, day, time, dur })),
    spots: state.spots.filter(s => s.selected).map(({ id, name, lat, lng, dur, must }) => ({ id, name, lat, lng, dur, must })),
  };
}

async function runPlan() {
  const req = planRequest();
  if (!req.spots.length && !req.fixed.length) { toast('가볼 곳이나 고정 일정을 먼저 추가하세요'); showTab('spots'); return; }
  const btn = $('#planBtn');
  btn.disabled = true; btn.textContent = '경로 계산 중…';
  try {
    lastPlan = await api('/api/plan', req);
    lastPlan.mode = state.mode;
    if (!state.lodging) lastPlan.warnings.unshift('숙소가 없어서 매일 첫 장소에서 시작해 마지막 장소에서 끝나는 걸로 계산했어요.');
    renderPlan();
    drawRoutes();
    showTab('plan');
  } catch (e) {
    toast('경로 계산 실패: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '🧭 경로 짜기';
  }
}
function clearPlan() { lastPlan = null; KMap.ready() && KMap.clear('route'); }

// ───────────── 결과 표시 ─────────────
function kakaoLink(a, b, by) {
  const part = p => `${encodeURIComponent(p.name.replace(/[,/]/g, ' '))},${p.lat},${p.lng}`;
  return `https://map.kakao.com/link/by/${by}/${part(a)}/${part(b)}`;
}
function legHtml(leg, from, to, mode) {
  if (!from || !to || leg.min < 1) return '';
  const [icon, label, by] = leg.walk ? ['🚶', '도보', 'walk'] : MODES[mode];
  return `<li class="leg">${icon} ${label} ${human(leg.min)}<a href="${kakaoLink(from, to, by)}" target="_blank" rel="noopener">카카오맵 길찾기 ↗</a></li>`;
}
function renderPlan() {
  const P = lastPlan;
  let num = 0;
  const totalTravel = P.days.reduce((a, d) => a + d.travelMin, 0);
  const placed = P.days.reduce((a, d) => a + d.items.filter(i => !i.fixed).length, 0);
  const source = P.source === 'kakao' ? '카카오모빌리티 실제 도로 기준 (주차 5분 포함)' : '직선거리 기반 추정';
  let html = `<div class="summary">가볼 곳 ${placed}곳 배치 · 총 이동 ${human(totalTravel)} · 이동시간: ${source}</div>`;
  P.warnings.forEach(w => html += `<div class="note">${esc(w)}</div>`);
  if (P.unplaced.length) html += `<div class="note">⏰ 시간이 부족해서 못 넣은 곳: <b>${P.unplaced.map(s => esc(s.name)).join(', ')}</b><br>
    머무는 시간을 줄이거나, 하루 활동 시간을 늘리거나, 꼭 가야 하면 ⭐를 눌러 다른 곳보다 먼저 넣으세요.</div>`;
  P.days.forEach((d, di) => {
    const color = DAY_COLORS[di];
    html += `<div class="day"><h3 style="border-color:${color}">${d.day}일차</h3>
      <div class="meta">${d.start} ~ ${d.finish} · 이동 ${human(d.travelMin)}</div><ol class="tl">`;
    html += `<li class="stop"><span class="t">${d.start}</span>${d.from ? esc(d.from.name) + ' 출발' : '출발'}</li>`;
    let prev = d.from;
    d.items.forEach(it => {
      html += legHtml(it.leg, prev, it, P.mode);
      if (it.waitMin >= 5) html += `<li class="leg">⏳ ${human(it.waitMin)} 여유 (근처 카페·산책)</li>`;
      num++;
      html += `<li class="stop ${it.fixed ? 'fixed' : ''}"><span class="t">${it.begin}–${it.end}</span>`
        + `<span class="num" style="background:${it.fixed ? '#e03131' : color}">${num}</span>${it.fixed ? '📌 ' : ''}${esc(it.name)}${it.must ? ' ⭐' : ''}</li>`;
      if (it.lateMin > 0) html += `<li class="warn">⚠ ${human(it.lateMin)} 늦게 도착해요 — 앞 일정을 줄이거나 시간을 조정하세요</li>`;
      prev = it;
    });
    if (d.to && prev) html += legHtml(d.back, prev, d.to, P.mode);
    html += `<li class="stop"><span class="t">${d.finish}</span>${d.to ? esc(d.to.name) + ' 도착' : '일정 끝'}</li>`;
    if (d.overMin > 0) html += `<li class="warn">⚠ 활동 종료 시간보다 ${human(d.overMin)} 늦어요</li>`;
    html += '</ol></div>';
  });
  html += `<div class="row"><button class="btn" data-act="copyText">📋 단톡방용 텍스트 복사</button>
    <button class="btn" data-act="share">🔗 공유 링크</button></div>
    <p class="hint" style="margin-top:12px">이동 시간은 추정치예요. 명소의 운영 시간·휴무일은 따로 확인하세요.</p>`;
  $('#tab-plan').innerHTML = html;
  renderMarkers();
}

function drawRoutes() {
  if (!KMap.ready()) return;
  KMap.clear('route');
  const bounds = [];
  let num = 0;
  lastPlan.days.forEach((d, di) => {
    const color = DAY_COLORS[di];
    d.items.forEach(it => {
      num++;
      bounds.push([it.lat, it.lng]);
      KMap.pin('route', { lat: it.lat, lng: it.lng, color: it.fixed ? '#e03131' : color, label: num, size: 24, z: 50,
        title: `${d.day}일차 ${it.begin} ${it.name}` });
    });
    const straight = [d.from, ...d.items, d.to].filter(Boolean).map(p => [p.lat, p.lng]);
    const path = d.path || straight;
    if (path.length >= 2) KMap.line('route', path, color, !d.path);
    bounds.push(...straight);
  });
  KMap.fit(bounds);
}

function planText() {
  const P = lastPlan;
  if (!P) return '';
  const lines = [`[${REGIONS[state.region]?.name ?? ''} 여행 일정]`];
  P.days.forEach(d => {
    lines.push('', `■ ${d.day}일차`);
    if (d.from) lines.push(`${d.start} ${d.from.name} 출발`);
    d.items.forEach(it => lines.push(`${it.begin}~${it.end} ${it.fixed ? '📌' : ''}${it.name}  (이동 ${human(it.leg.min)})`));
    if (d.to) lines.push(`${d.finish} ${d.to.name} 도착`);
  });
  if (P.unplaced.length) lines.push('', `못 간 곳: ${P.unplaced.map(s => s.name).join(', ')}`);
  return lines.join('\n');
}

// ───────────── 시작 ─────────────
function showMapError(html) { const el = $('#mapError'); el.innerHTML = `<div>${html}</div>`; el.classList.add('on'); }

(async function start() {
  try {
    REGIONS = await api('/api/regions');
  } catch (e) {
    showMapError(`백엔드(${esc(API || '주소 미설정')})에 연결하지 못했어요.<br>${esc(e.message)}`);
    $('#tab-setup').innerHTML = '<p class="hint">서버에 연결되면 새로고침 해 주세요.</p>';
    return;
  }
  state = load();
  const r = REGIONS[state.region];
  try {
    await KMap.init($('#map'), { appKey: CONFIG.KAKAO_JS_KEY, center: r.center, level: r.level, onClick: onMapClick, onAction });
  } catch (e) {
    showMapError(`카카오맵을 불러오지 못했어요: ${esc(e.message)}<br>
      카카오 개발자 콘솔 > 앱 > 플랫폼 > Web 에 <b>${esc(location.origin)}</b> 가 등록돼 있는지 확인하세요.<br>
      지도 없이도 일정 짜기는 쓸 수 있어요.`);
  }
  render();
  scheduleRoute();
})();
