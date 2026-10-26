// 공유 지도: 4자리 번호로 여럿이 같은 지도를 같이 씀 (백엔드 /api/maps, Cloudflare D1)
// app.js 의 상태(state)·화면 함수를 그대로 쓰고, 바뀐 내용을 서버에 보내거나 서버 내용을 받아 와서 맞춤.
// 로그인 없이 닉네임만 정하고, 그 기기에 기억함 (localStorage: marker-me-<번호>)
const Room = (() => {
  const POLL_MS = 8000;   // 다른 사람이 바꾼 내용을 확인하는 간격
  const AVATAR_COLORS = ['#1864AB', '#C2255C', '#0B7285', '#5F3DC4', '#E67700', '#2B8A3E', '#862E9C', '#495057'];
  let room = null;        // { code, title, members, me, updatedAt }
  let pending = 0;        // 서버에 보내는 중인 요청 수 (그동안은 받아 오지 않음)

  const meKey = code => `marker-me-${code}`;
  const roomLink = code => `${location.origin}${location.pathname}?map=${code}`;
  const avatarColor = id => AVATAR_COLORS[Math.abs(Number(id) || 0) % AVATAR_COLORS.length];
  const initial = name => [...(name || '?')][0];

  async function call(method, path, body) {
    pending++;
    try {
      const res = await fetch(API + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const err = new Error(data.error || `서버 응답 ${res.status}`); err.status = res.status; throw err; }
      return data;
    } finally { pending--; }
  }

  // ───────── 서버 → 화면 ─────────
  const fromServer = m => ({ id: m.id, name: m.name, lat: m.lat, lng: m.lng, cat: m.cat, on: m.on, by: m.markedBy });
  function apply(data) {
    room.title = data.map.title;
    room.members = data.members;
    room.updatedAt = data.map.updatedAt;
    if (room.me && !room.members.some(x => x.id === room.me.id)) forgetMe();
    state = { mode: data.map.mode, loop: data.map.loop, markers: partition(data.markers.map(fromServer)) };
    renderBar();
    changed();   // 목록·지도·경로 다시 그림 (공유 지도에선 브라우저에 저장하지 않음)
  }
  /** 서버의 최신 상태로 맞춤. force 가 아니면 지도 수정일이 바뀌었을 때만 */
  async function refresh(force = false) {
    if (!room) return;
    if (!force && (pending || dragFrom != null || document.hidden)) return;
    try {
      const data = await call('GET', `/api/maps/${room.code}`);
      if (force || data.map.updatedAt !== room.updatedAt) apply(data);
    } catch (e) {
      if (e.status === 404) { toast('공유 지도가 지워졌어요. 내 지도로 돌아가요'); setTimeout(leave, 1500); }
    }
  }
  /** 화면은 app.js 가 먼저 바꿔 두고, 여기서 서버에 보낸 뒤 서버 상태로 다시 맞춤 */
  async function write(method, path, body) {
    try { await call(method, path, body); }
    catch (e) { toast(e.message); }
    await refresh(true);
  }

  // ───────── 들어가기 ─────────
  async function enter(rawCode) {
    const code = String(rawCode).trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { toast('지도 번호는 영문·숫자 4자리예요'); return false; }
    let data;
    try { data = await call('GET', `/api/maps/${code}`); }
    catch (e) { toast(e.status === 404 ? `${code} 지도가 없어요` : `공유 지도를 열지 못했어요: ${e.message}`); return false; }
    let me = null;
    try { me = JSON.parse(localStorage.getItem(meKey(code)) || 'null'); } catch {}
    room = { code, title: '', members: [], me, updatedAt: '' };
    document.body.classList.add('in-room');
    apply(data);
    setInterval(() => refresh(), POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    if (!room.me) askNickname();
    return true;
  }
  function leave() { location.href = location.pathname; }
  function rememberMe(member) {
    room.me = { id: member.id, nickname: member.nickname };
    localStorage.setItem(meKey(room.code), JSON.stringify(room.me));
    renderBar();
  }
  function forgetMe() { room.me = null; localStorage.removeItem(meKey(room.code)); }

  // ───────── app.js 가 부르는 변경 ─────────
  /** 마킹 전에 닉네임이 있어야 함. 없으면 닉네임 창을 띄우고 false */
  function canWrite() {
    if (!room || room.me) return true;
    askNickname();
    return false;
  }
  const addMarker = m => write('POST', `/api/maps/${room.code}/markers`, { memberId: room.me.id, name: m.name, lat: m.lat, lng: m.lng, cat: m.cat });
  const patchMarker = (m, body) => typeof m.id === 'number' && write('PATCH', `/api/maps/${room.code}/markers/${m.id}`, body);
  const deleteMarker = m => typeof m.id === 'number' && write('DELETE', `/api/maps/${room.code}/markers/${m.id}`);
  const patchMap = body => write('PATCH', `/api/maps/${room.code}`, body);
  /** 경로에 든 마커 순서를 서버에 반영. 아직 서버 id 가 없는(방금 마킹 중인) 마커가 있으면 다음 동기화에 맡김 */
  function pushOrder() {
    const ids = state.markers.filter(m => m.on).map(m => m.id);
    if (ids.every(id => typeof id === 'number')) write('PUT', `/api/maps/${room.code}/order`, { ids });
  }

  // ───────── 화면: 위쪽 공유 막대, 닉네임 표시 ─────────
  function avatar(member, extra = '') {
    if (!member) return '';
    return `<span class="avatar ${extra}" style="--a:${avatarColor(member.id)}" title="${esc(member.nickname)}">${esc(initial(member.nickname))}</span>`;
  }
  /** 목록 행·팝업에 붙는 '누가 마킹했는지' */
  function byBadge(m) {
    if (!room || !m.by) return '';
    return `<span class="avatar by" style="--a:${avatarColor(m.by.id)}" title="${esc(m.by.nickname)} 님이 마킹">${esc(initial(m.by.nickname))}</span>`;
  }
  function byLine(m) {
    if (!room) return '';
    return m.by
      ? `<div class="by-line">${avatar(m.by)} <b>${esc(m.by.nickname)}</b> 님이 마킹</div>`
      : '<div class="by-line">마킹한 사람 정보 없음</div>';
  }
  function renderBar() {
    const bar = $('#roomBar');
    if (!room) { bar.innerHTML = ''; return; }
    const others = room.members.filter(x => x.id !== room.me?.id);
    bar.innerHTML = `
      <div class="room-top">
        <button class="room-code" data-act="roomCopy" title="링크 복사">${room.code}</button>
        <button class="room-title" data-act="roomRename" title="제목 바꾸기">${esc(room.title)}</button>
        <button class="link-btn" data-act="roomLeave">내 지도로</button>
      </div>
      <div class="room-people">
        ${room.me ? `<button class="me" data-act="roomNickname" title="닉네임 바꾸기">${avatar(room.me, 'mine')}<b>${esc(room.me.nickname)}</b></button>`
                  : '<button class="me" data-act="roomNickname"><b>닉네임 정하기</b></button>'}
        ${others.length ? `<span class="others" title="${others.map(o => esc(o.nickname)).join(', ')}">${others.slice(0, 6).map(o => avatar(o)).join('')}${others.length > 6 ? `<span class="more">+${others.length - 6}</span>` : ''}</span>
          <span class="muted">${others.length === 1 ? esc(others[0].nickname) : `${others.length}명`}과 함께</span>` : '<span class="muted">아직 혼자예요. 번호를 알려 주세요</span>'}
      </div>`;
  }

  // ───────── 대화창 ─────────
  const dlg = () => $('#dlg');
  function openDialog(html, onSubmit) {
    const d = dlg();
    d.innerHTML = `<form method="dialog">${html}</form>`;
    const form = d.querySelector('form');
    form.addEventListener('submit', async e => {
      const btn = e.submitter;
      if (btn?.value === 'cancel') return;   // 닫기
      e.preventDefault();
      const done = await onSubmit(new FormData(form), btn?.value, form);
      if (done !== false) d.close();
    });
    d.showModal();
    d.querySelector('input:not([type=checkbox])')?.focus();
  }

  function askNickname() {
    const names = room.members.map(x => x.nickname);
    openDialog(`
      <h2>이 지도에서 쓸 닉네임</h2>
      <p class="hint"><b>${esc(room.title)}</b> (${room.code}) 에 들어왔어요. 마킹하면 다른 사람들에게 닉네임이 보여요.</p>
      ${names.length ? `<p class="dlg-label">전에 들어온 적 있다면 내 닉네임을 누르세요</p>
        <div class="chips-row">${room.members.map(x => `<button class="chip" name="pick" value="${esc(x.nickname)}">${avatar(x)} ${esc(x.nickname)}</button>`).join('')}</div>` : ''}
      <label class="dlg-label" for="nick">새 닉네임</label>
      <input id="nick" name="nickname" maxlength="20" placeholder="예: 지윤" autocomplete="nickname">
      <div class="dlg-actions">
        <button class="btn" value="cancel">구경만 할게요</button>
        <button class="btn primary" value="new">들어가기</button>
      </div>`,
    async (fd, value, form) => {
      const nickname = value === 'new' ? String(fd.get('nickname') || '').trim() : value;
      if (!nickname) { form.querySelector('#nick').focus(); return false; }
      try {
        const { member } = await call('POST', `/api/maps/${room.code}/members`, { nickname });
        rememberMe(member);
        toast(`${member.nickname}(으)로 들어왔어요`);
        refresh(true);
      } catch (e) { toast(e.message); return false; }
    });   // 기존 닉네임 칩은 submit 버튼이라 그 value(닉네임)로 들어감
  }

  function openStart() {
    const n = state.markers.length;
    openDialog(`
      <h2>같이 꽂기</h2>
      <p class="hint">공유 지도를 만들면 4자리 번호가 생겨요. 번호를 아는 사람은 누구나 같이 마킹할 수 있어요.</p>
      <label class="dlg-label" for="ttl">지도 제목</label>
      <input id="ttl" name="title" maxlength="60" placeholder="예: 대구 1박 2일">
      <label class="dlg-label" for="nick2">내 닉네임</label>
      <input id="nick2" name="nickname" maxlength="20" placeholder="예: 지윤">
      ${n ? `<label class="check"><input type="checkbox" name="copy" checked> 지금 내 마커 ${n}개도 같이 올리기</label>` : ''}
      <div class="dlg-actions"><button class="btn primary" value="create">공유 지도 만들기</button></div>
      <div class="dlg-or">또는 받은 번호로 들어가기</div>
      <div class="join-row">
        <input name="code" maxlength="4" placeholder="번호 4자리" autocapitalize="characters" aria-label="지도 번호">
        <button class="btn" value="join">들어가기</button>
      </div>
      <div class="dlg-actions"><button class="btn" value="cancel">닫기</button></div>`,
    async (fd, value, form) => {
      if (value === 'join') {
        const code = String(fd.get('code') || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code)) { toast('번호는 영문·숫자 4자리예요'); form.querySelector('[name=code]').focus(); return false; }
        location.href = `${location.pathname}?map=${code}`;
        return;
      }
      const title = String(fd.get('title') || '').trim(), nickname = String(fd.get('nickname') || '').trim();
      if (!title) { form.querySelector('#ttl').focus(); return false; }
      if (!nickname) { form.querySelector('#nick2').focus(); return false; }
      try {
        form.querySelector('[value=create]').textContent = '만드는 중…';
        const { map, member } = await call('POST', '/api/maps', { title, nickname });
        localStorage.setItem(meKey(map.code), JSON.stringify({ id: member.id, nickname: member.nickname }));
        if (fd.get('copy')) await copyMarkers(map.code, member.id);
        location.href = `${location.pathname}?map=${map.code}`;
      } catch (e) {
        toast(e.message);
        form.querySelector('[value=create]').textContent = '공유 지도 만들기';
        return false;
      }
    });
  }
  /** 내 지도의 마커·이동수단·숙소 왕복 설정을 새 공유 지도에 그대로 올림 (순서 유지) */
  async function copyMarkers(code, memberId) {
    for (const m of state.markers) {
      const { marker } = await call('POST', `/api/maps/${code}/markers`, { memberId, name: m.name, lat: m.lat, lng: m.lng, cat: m.cat });
      if (!m.on) await call('PATCH', `/api/maps/${code}/markers/${marker.id}`, { on: false });
    }
    await call('PATCH', `/api/maps/${code}`, { mode: state.mode, loop: state.loop });
  }

  async function rename() {
    const title = prompt('지도 제목', room.title)?.trim();
    if (!title || title === room.title) return;
    room.title = title; renderBar();
    await patchMap({ title });
  }
  function copyLink() {
    const url = roomLink(room.code);
    navigator.clipboard.writeText(url).then(() => toast(`공유 지도 링크를 복사했어요 (번호 ${room.code})`), () => prompt('아래 링크를 복사하세요', url));
  }

  // 위쪽 막대 버튼
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'roomStart') openStart();
    else if (act === 'roomCopy') copyLink();
    else if (act === 'roomRename') rename();
    else if (act === 'roomLeave') leave();
    else if (act === 'roomNickname') askNickname();
  });

  return {
    active: () => !!room,
    me: () => room?.me || null,
    code: () => room?.code,
    enter, canWrite, addMarker, patchMarker, deleteMarker, patchMap, pushOrder, refresh, copyLink, byBadge, byLine,
  };
})();
