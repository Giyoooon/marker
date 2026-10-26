// 화면·상태 관리. 경로 계산과 장소 검색은 백엔드(marker-api)가 담당
const CONFIG = window.MARKER_CONFIG || {};
const API = (CONFIG.API_BASE || '').replace(/\/+$/, '');
const MODES = { car: ['🚗', 'car'], transit: ['🚌', 'traffic'], walk: ['🚶', 'walk'] };
const COLOR = '#7048e8';
const DEFAULT_VIEW = { lat: 35.86, lng: 128.6, level: 8 };   // 대구
const MAX_MARKERS = 32;                                       // 카카오 다중 경유지 길찾기 한도

// ───────────── 유틸 ─────────────
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const human = m => { m = Math.round(m); if (m < 60) return m + '분'; const h = Math.floor(m / 60), r = m % 60; return h + '시간' + (r ? ' ' + r + '분' : ''); };
const uid = () => Math.random().toString(36).slice(2, 9);
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), 2200); };
const b64enc = s => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
const posKey = p => p.lat.toFixed(5) + ',' + p.lng.toFixed(5);

async function api(path, body) {
  const res = await fetch(API + path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : undefined);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `서버 응답 ${res.status}`);
  return data;
}

// ───────────── 상태 ─────────────
// markers: 방문 순서대로 [{ id, name, lat, lng }]
let state = { mode: 'car', markers: [] };
let searchResults = [];
let clickPlace = null;
let routeInfo = null;    // 마지막 /api/route 응답 + 어떤 순서·이동수단에 대한 응답인지(key)
let routeSeq = 0, routeTimer = null;

const pick = ({ id, name, lat, lng }) => ({ id: id || 'm' + uid(), name, lat, lng });
function fromSaved(obj) {
  const list = obj.markers || obj.route || [];   // 예전 버전의 '내 경로' 도 그대로 가져옴
  return { mode: MODES[obj.mode] ? obj.mode : 'car', markers: list.filter(p => p && isFinite(p.lat) && isFinite(p.lng)).map(pick) };
}
const serialize = () => JSON.stringify({ mode: state.mode, markers: state.markers.map(({ name, lat, lng }) => ({ name, lat, lng })) });
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
  return { mode: 'car', markers: [] };
}

const isMarked = p => state.markers.some(m => posKey(m) === posKey(p));
function mark(p) {
  if (isMarked(p)) { toast('이미 마킹한 곳이에요'); return; }
  if (state.markers.length >= MAX_MARKERS) { toast(`마커는 ${MAX_MARKERS}개까지 등록할 수 있어요`); return; }
  state.markers.push(pick({ name: p.name || '선택한 위치', lat: p.lat, lng: p.lng }));
  KMap.ready() && KMap.closePopup();
  changed();
  renderResults();
  toast(`📍 '${state.markers[state.markers.length - 1].name}' 마킹`);
}

// ───────────── 경로 (/api/route) ─────────────
const routeKey = () => state.mode + '|' + state.markers.map(posKey).join(';');
const currentRoute = () => (routeInfo && routeInfo.key === routeKey() ? routeInfo : null);

function changed() {
  render();
  save();
  clearTimeout(routeTimer);
  if (state.markers.length >= 2) routeTimer = setTimeout(fetchRoute, 300);
}
async function fetchRoute() {
  const seq = ++routeSeq, key = routeKey();
  let info;
  try {
    info = await api('/api/route', { mode: state.mode, points: state.markers.map(({ name, lat, lng }) => ({ name, lat, lng })) });
  } catch (e) {
    info = { error: e.message };
  }
  if (seq !== routeSeq) return;   // 그 사이 순서가 또 바뀌었으면 버림
  routeInfo = { ...info, key };
  render();
}
async function optimize() {
  if (state.markers.length < 3) return;
  const btn = $('#optBtn');
  btn.disabled = true; btn.textContent = '정렬 중…';
  clearTimeout(routeTimer);
  const seq = ++routeSeq;
  try {
    const info = await api('/api/route', { mode: state.mode, optimize: true, points: state.markers.map(({ name, lat, lng }) => ({ name, lat, lng })) });
    if (seq !== routeSeq) return;
    const before = state.markers.map(m => m.id).join();
    state.markers = info.order.map(i => state.markers[i]);
    routeInfo = { ...info, key: routeKey() };
    render(); save(); fitAll();
    toast(before === state.markers.map(m => m.id).join() ? '이미 최단 순서예요' : `최단 순서로 정렬했어요 · ${human(info.totalMin)}`);
  } catch (e) {
    toast('정렬 실패: ' + e.message);
  } finally {
    btn.disabled = state.markers.length < 3; btn.textContent = '✨ 최단 순서로 정렬';
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
function legHtml(leg, a, b) {
  if (leg.km === 0) return '같은 자리';
  const [icon, by] = leg.walk ? ['🚶', 'walk'] : MODES[state.mode];
  return `${icon} ${human(leg.min)} · ${leg.km}km<a href="${kakaoLink(a, b, by)}" target="_blank" rel="noopener">길찾기 ↗</a>`;
}

function renderList() {
  const M = state.markers, info = currentRoute();
  const ok = info && !info.error ? info : null;
  let html = '';
  if (!M.length) {
    html = `<p class="hint">위에서 장소를 검색해 <b>📍 마킹</b>하거나 지도를 클릭해서 마커를 찍으세요.<br>
      찍은 순서대로 경로가 그려지고, <b>⠿를 끌어 놓거나 ▲▼</b>로 순서를 바꿀 수 있어요.</p>`;
  } else {
    if (M.length === 1) html += '<p class="hint">마커를 하나 더 찍으면 경로가 그려져요.</p>';
    else if (ok) html += `<div class="summary"><b>${M.length}곳 · ${human(ok.totalMin)} · ${ok.totalKm}km</b>
      <span class="src">${ok.source === 'kakao' ? '카카오모빌리티 실제 도로' : '직선거리 추정'}</span></div>`;
    else if (info?.error) html += `<div class="note">경로를 불러오지 못했어요: ${esc(info.error)}</div>`;
    else html += '<div class="summary"><span class="src">경로 계산 중…</span></div>';
    ok?.warnings.forEach(w => html += `<div class="note">${esc(w)}</div>`);

    html += '<ol class="rt-list">';
    M.forEach((p, i) => {
      if (i > 0) html += `<li class="rt-leg" data-at="${i}">${ok ? legHtml(ok.legs[i - 1], M[i - 1], p) : '…'}</li>`;
      html += `<li class="rt" draggable="true" data-i="${i}">
        <span class="grip" title="끌어서 순서 바꾸기">⠿</span>
        <span class="num">${i + 1}</span>
        <span class="rt-name" data-act="focus" data-i="${i}" title="${esc(p.name)}">${esc(p.name)}</span>
        <button class="x" data-act="up" data-i="${i}" ${i === 0 ? 'disabled' : ''} title="위로">▲</button>
        <button class="x" data-act="down" data-i="${i}" ${i === M.length - 1 ? 'disabled' : ''} title="아래로">▼</button>
        <button class="x" data-act="del" data-i="${i}" title="삭제">✕</button>
      </li>`;
    });
    html += `</ol><div class="list-actions">
      <button class="btn" data-act="reverse" ${M.length < 2 ? 'disabled' : ''}>⇅ 순서 뒤집기</button>
      <button class="btn" data-act="fit">전체 보기</button>
      <button class="btn" data-act="clearAll">모두 지우기</button></div>`;
  }
  $('#markers').innerHTML = html;
  $('#optBtn').disabled = M.length < 3;
  $('#mode').value = state.mode;
}

function renderMap() {
  if (!KMap.ready()) return;
  KMap.clear('manual');
  const M = state.markers, info = currentRoute();
  const path = info && !info.error ? info.path : null;
  if (M.length >= 2) KMap.line('manual', path || M.map(p => [p.lat, p.lng]), COLOR, !path);
  M.forEach((p, i) => KMap.pin('manual', {
    lat: p.lat, lng: p.lng, color: COLOR, label: i + 1, size: 26, z: 60, title: `${i + 1}. ${p.name}`,
    onClick: () => KMap.openPopup(p.lat, p.lng, `<b>${i + 1}. ${esc(p.name)}</b>
      <div class="actions"><button class="btn" data-act="del" data-i="${i}">✕ 마커 삭제</button></div>`),
  }));
}
function render() { renderList(); renderMap(); }

function markButton(p, src) {
  return isMarked(p)
    ? '<button class="mark" disabled>✓ 마킹됨</button>'
    : `<button class="mark" data-act="mark" data-src="${src}">📍 마킹</button>`;
}
function renderResults() {
  const box = $('#results');
  if (!searchResults.length) return;
  box.innerHTML = searchResults.map((r, i) => `<div class="res">
      <div class="info" data-act="showResult" data-i="${i}">
        <span class="name">${esc(r.name)}</span><span class="cat">${esc(r.category)}</span>
        <div class="addr">${esc(r.addr)}</div>
      </div>${markButton(r, 'res:' + i)}</div>`).join('')
    + '<div class="res-foot"><button class="link" data-act="closeResults">검색 결과 닫기 ✕</button></div>';
  if (!KMap.ready()) return;
  KMap.clear('base');
  searchResults.forEach((r, i) => KMap.pin('base', { lat: r.lat, lng: r.lng, color: '#868e96', size: 14, z: 10, title: r.name,
    onClick: () => showResult(i) }));
}
function showResult(i) {
  const r = searchResults[i];
  if (!KMap.ready()) return;
  KMap.focus(r.lat, r.lng);
  KMap.openPopup(r.lat, r.lng, `<b>${esc(r.name)}</b><div class="addr">${esc(r.addr)}</div>
    <div class="actions">${markButton(r, 'res:' + i)}</div>`);
}

// ───────────── 장소 검색 (백엔드 → 카카오 로컬) ─────────────
$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  const box = $('#results');
  box.innerHTML = '<p class="hint">검색 중…</p>';
  const near = KMap.ready() ? KMap.center() : DEFAULT_VIEW;
  try {
    searchResults = await api(`/api/search?${new URLSearchParams({ q, lat: near.lat, lng: near.lng })}`);
    if (!searchResults.length) { box.innerHTML = '<p class="hint">결과가 없어요. 다른 이름으로 검색하거나 지도를 클릭해서 마킹하세요.</p>'; return; }
    renderResults();
    KMap.ready() && KMap.fit(searchResults.map(r => [r.lat, r.lng]));
  } catch (err) {
    box.innerHTML = `<p class="hint">검색에 실패했어요 (${esc(err.message)}). 지도를 클릭해서 마킹할 수 있어요.</p>`;
  }
});
function closeResults() {
  searchResults = [];
  $('#results').innerHTML = '';
  KMap.ready() && (KMap.clear('base'), KMap.closePopup());
}

function onMapClick(lat, lng) {
  clickPlace = { lat, lng };
  const el = KMap.openPopup(lat, lng, `<b>여기에 마킹</b><input id="clickName" placeholder="이름 (예: 우리 숙소)">
    <div class="actions"><button class="mark" data-act="mark" data-src="click">📍 마킹</button></div>`);
  const input = el.querySelector('input');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') mark({ ...clickPlace, name: input.value.trim() }); });
  setTimeout(() => input.focus(), 50);
}

// ───────────── 이벤트 ─────────────
document.addEventListener('click', onAction);
function onAction(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, i = +el.dataset.i;
  if (act === 'mark') {
    const src = el.dataset.src;
    mark(src === 'click' ? { ...clickPlace, name: document.getElementById('clickName')?.value.trim() } : searchResults[+src.split(':')[1]]);
  } else if (act === 'showResult') showResult(i);
  else if (act === 'closeResults') closeResults();
  else if (act === 'closePopup') KMap.closePopup();
  else if (act === 'focus') { const p = state.markers[i]; KMap.ready() && KMap.focus(p.lat, p.lng); }
  else if (act === 'up') swap(i, i - 1);
  else if (act === 'down') swap(i, i + 1);
  else if (act === 'del') { state.markers.splice(i, 1); KMap.ready() && KMap.closePopup(); changed(); renderResults(); }
  else if (act === 'reverse') { state.markers.reverse(); changed(); }
  else if (act === 'fit') fitAll();
  else if (act === 'clearAll') { if (confirm('마커를 모두 지울까요?')) { state.markers = []; changed(); renderResults(); } }
  else if (act === 'optimize') optimize();
  else if (act === 'share') {
    const url = location.origin + location.pathname + '#t=' + b64enc(serialize());
    navigator.clipboard.writeText(url).then(() => toast('공유 링크를 복사했어요. 단톡방에 붙여 넣으세요!'), () => prompt('아래 링크를 복사하세요', url));
  }
}
$('#mode').addEventListener('change', e => { state.mode = e.target.value; changed(); });

// 끌어서 놓기: 마커 행 위에서는 위/아래 절반에 따라 앞/뒤로, 구간 행 위에서는 그 사이로 삽입
let dragFrom = null;
const list = $('#markers');
function dropTarget(e) {
  const row = e.target.closest('li.rt, li.rt-leg');
  if (!row) return null;
  if (row.classList.contains('rt-leg')) return { row, to: +row.dataset.at, cls: 'drop-on' };
  const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
  return { row, to: +row.dataset.i + (after ? 1 : 0), cls: after ? 'drop-after' : 'drop-before' };
}
const clearDropMarks = () => list.querySelectorAll('.drop-before, .drop-after, .drop-on')
  .forEach(el => el.classList.remove('drop-before', 'drop-after', 'drop-on'));
list.addEventListener('dragstart', e => {
  const li = e.target.closest('li.rt');
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
