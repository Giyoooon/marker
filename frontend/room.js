// 공유 지도: 4자리 번호로 여럿이 같은 지도를 같이 씀 (백엔드 /api/maps, Cloudflare D1 + 지도 방 Durable Object)
// app.js 의 상태(state)·화면 함수를 그대로 쓰고, 바뀐 내용을 서버에 보내거나 서버 내용을 받아 와서 맞춤.
// - 로그인 없이 닉네임만 정하고 그 기기에 기억함 (localStorage: marker-me-<번호>, 이 기기에서 쓴 이름들: marker-nicknames)
// - 웹소켓으로 지금 접속한 사람(presence)과 다른 사람의 변경을 바로 받음. 끊기면 8초마다 확인으로 대신함
const Room = (() => {
  const POLL_MS = 8000;           // 웹소켓이 끊겼을 때 확인 간격
  const POLL_WITH_WS_MS = 300000; // 웹소켓이 붙어 있으면 알림으로 충분. 혹시 놓친 알림 대비로 5분에 한 번만 맞춤
  // 이 화면(탭) id. 변경 요청에 붙여 보내고, 웹소켓으로 돌아온 내 변경 알림은 무시 (응답 뒤 이미 맞췄으니까)
  const CLIENT_ID = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  const AVATAR_COLORS = ['#1864AB', '#C2255C', '#0B7285', '#5F3DC4', '#E67700', '#2B8A3E', '#862E9C', '#495057'];
  let room = null;        // { code, title, members, me, updatedAt, online, viewers }
  let pending = 0;        // 서버에 보내는 중인 요청 수 (그동안은 받아 오지 않음)
  let lastSync = 0;
  const activity = [];    // 이 화면을 연 뒤 다른 사람들이 한 일 (최신이 앞)
  let unseen = 0;
  const flashUntil = new Map();   // 마커 id → 반짝임 끝나는 시각

  const meKey = code => `marker-me-${code}`;
  const roomLink = code => `${location.origin}${location.pathname}?map=${code}`;
  const avatarColor = id => AVATAR_COLORS[Math.abs(Number(id) || 0) % AVATAR_COLORS.length];
  const initial = name => [...(name || '?')][0];
  /** 받침 있으면 a, 없으면 b (예: 을/를, 이/가, 으로/로) */
  function josa(word, a, b) {
    const ch = String(word).trim().slice(-1).charCodeAt(0);
    if (ch < 0xAC00 || ch > 0xD7A3) return a.length > b.length ? a : `${a}(${b})`;   // 한글이 아니면 둘 다 보여 줌
    const jong = (ch - 0xAC00) % 28;
    if (a === '으로') return jong === 0 || jong === 8 ? b : a;   // ㄹ 받침은 '로'
    return jong ? a : b;
  }
  const quoted = (name, a, b) => `'${name}'${josa(name, a, b)}`;

  async function call(method, path, body, retried = false) {
    pending++;
    try {
      // 바꾸는 요청엔 화면 id 와 사람 확인 통과증을 붙임 (GET 에 붙이면 매번 사전 요청(OPTIONS)이 하나 더 생김)
      const pass = method === 'GET' ? null : await Human.pass();
      // 서버가 응답하지 않으면 10초 뒤 포기 (버튼이 "찾는 중…"에 멈춰 있지 않게)
      const res = await fetch(API + path, {
        signal: AbortSignal.timeout(10000),
        method,
        headers: method === 'GET' ? undefined : {
          ...(body ? { 'Content-Type': 'application/json' } : {}), 'X-Client-Id': CLIENT_ID, ...(pass ? { 'X-Human-Pass': pass } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      // 통과증이 만료·무효면 다시 확인하고 한 번만 다시 보냄
      if (res.status === 401 && data.needHuman && !retried) { Human.clear(); return call(method, path, body, true); }
      if (!res.ok) { const err = new Error(data.error || `서버 응답 ${res.status}`); err.status = res.status; throw err; }
      return data;
    } catch (e) {
      if (e.name === 'TimeoutError') throw new Error('서버가 응답하지 않아요. 잠시 뒤 다시 해 주세요');
      throw e;
    } finally { pending--; }
  }

  // ───────── 서버 → 화면 ─────────
  const fromServer = m => ({ id: m.id, name: m.name, lat: m.lat, lng: m.lng, cat: m.cat, on: m.on, by: m.markedBy, updatedBy: m.updatedBy });
  function apply(data) {
    room.title = data.map.title;
    room.members = data.members;
    room.updatedAt = data.map.updatedAt;
    if (room.me && !room.members.some(x => x.id === room.me.id)) forgetMe();
    state = { mode: data.map.mode, loop: data.map.loop, legModes: cleanLegModes(data.map.legModes), markers: partition(data.markers.map(fromServer)) };
    renderBar();
    changed();   // 목록·지도·경로 다시 그림 (공유 지도에선 브라우저에 저장하지 않음)
  }
  /** 서버의 최신 상태로 맞춤. force 가 아니면 지도 수정일이 바뀌었을 때만 */
  async function refresh(force = false) {
    if (!room) return;
    if (!force && (pending || dragFrom != null || document.hidden)) return;
    try {
      const data = await call('GET', `/api/maps/${room.code}`);
      lastSync = Date.now();
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

  // ───────── 웹소켓: 접속자와 바로바로 변경 알림 ─────────
  // 접속 중 표시가 늦게 꺼지지 않게: 페이지를 떠나면 바로 닫고, 안 보고 있으면 잠시 뒤 닫고,
  // 살아 있다는 신호(ping)를 자주 보냄 → 신호가 끊긴 연결은 서버(room.ts)가 40초 안에 정리
  const PING_MS = 15000;          // backend/src/room.ts PING_MS 와 맞출 것
  const HIDDEN_CLOSE_MS = 10000;  // 다른 앱·탭으로 가서 이만큼 안 보면 연결을 닫음 (돌아오면 다시 연결)
  let ws = null, wsOpen = false, retry = 0, retryTimer = null, pingTimer = null, hiddenTimer = null, leaving = false;
  function disconnect(code = 1000) {
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    if (ws) { ws.onclose = null; try { ws.close(code); } catch {} ws = null; }
    wsOpen = false;
  }
  let wsFails = 0;   // 열리기 전에 끊긴 횟수 (통과증이 거절됐을 수 있음 → 두 번째부터 새로 확인)
  async function connect() {
    if (!room || leaving) return;
    disconnect();
    if (wsFails >= 2) { Human.clear(); wsFails = 0; }
    let pass;
    try { pass = await Human.pass(); }
    catch (e) { toast(e.message); retryTimer = setTimeout(connect, 30000); return; }
    if (!room || leaving) return;
    const q = new URLSearchParams({ ...(room.me ? { memberId: room.me.id } : {}), ...(pass ? { pass } : {}) });
    const url = `${API.replace(/^http/, 'ws')}/api/maps/${room.code}/ws${q.size ? `?${q}` : ''}`;
    const sock = ws = new WebSocket(url);
    let opened = false;
    sock.onopen = () => {
      wsOpen = true; retry = 0; opened = true; wsFails = 0;
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sock.readyState === 1 && sock.send('ping'), PING_MS);
      // 끊겨 있던 동안 바뀐 것 맞추기. 들어오자마자 처음 연결할 땐 방금 불러왔으니 건너뜀
      if (Date.now() - lastSync > 3000) refresh(true);
    };
    sock.onmessage = e => {
      if (e.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'presence') onPresence(msg);
      else if (msg.type === 'change') onChange(msg);
    };
    sock.onclose = () => {
      wsOpen = false;
      if (!opened) wsFails++;
      clearInterval(pingTimer);
      room.online = null;   // 모르면 표시하지 않음
      renderBar();
      // 1, 2, 4, 8 … 최대 30초 뒤 다시 연결. 안 보고 있는 동안엔 연결하지 않음 (돌아오면 바로 연결)
      if (!document.hidden && !leaving) retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    };
  }
  // 페이지를 떠날 땐(탭 닫기, 다른 주소로 이동) 바로 닫아서 다른 사람 화면에서 곧장 나감으로 보이게
  window.addEventListener('pagehide', () => { leaving = true; disconnect(); });
  window.addEventListener('pageshow', e => { if (e.persisted && room) { leaving = false; connect(); } });   // 뒤로 가기로 돌아온 경우
  document.addEventListener('visibilitychange', () => {
    if (!room) return;
    clearTimeout(hiddenTimer);
    if (document.hidden) hiddenTimer = setTimeout(() => disconnect(), HIDDEN_CLOSE_MS);
    else if (!wsOpen) connect();   // 연결하면서 서버 상태도 맞춤 (onopen → refresh)
  });

  const leftAt = new Map();   // 사람 id → 마지막으로 나간 시각
  function onPresence(p) {
    const before = room.online ? new Set(room.online.map(o => o.id)) : null;
    room.online = p.online;
    room.viewers = p.viewers;
    if (before) {   // 처음 받은 목록은 알리지 않음
      for (const o of p.online) {
        // 잠깐 다른 앱을 보다 돌아온 경우(나간 지 15초 안)는 '들어왔어요'를 알리지 않음
        const quickReturn = Date.now() - (leftAt.get(o.id) ?? 0) < 15000;
        if (!before.has(o.id) && o.id !== room.me?.id && !quickReturn) note(`${o.nickname} 님이 들어왔어요`, o);
      }
      const now = new Set(p.online.map(o => o.id));
      for (const id of before) {
        if (!now.has(id) && id !== room.me?.id) {
          leftAt.set(id, Date.now());
          const m = room.members.find(x => x.id === id);
          if (m) note(`${m.nickname} 님이 나갔어요`, m, { quiet: true });
        }
      }
    }
    renderBar();
  }

  /** 변경 알림 → 다른 사람이 한 일이면 토스트·활동 기록·반짝임, 그리고 서버 상태로 맞춤 */
  let refreshSoon = null;
  function onChange(ev) {
    if (ev.client === CLIENT_ID) return;   // 내 화면이 보낸 변경: 응답 뒤 이미 서버 상태로 맞춤
    // 새 닉네임 알림(member.join)은 곧이어 오는 접속 알림('들어왔어요')과 겹쳐서 따로 알리지 않음
    if (ev.by?.id !== room.me?.id && ev.action !== 'member.join') {
      note(describe(ev), ev.by);
      if (ev.marker && ev.action !== 'marker.delete') flashUntil.set(ev.marker.id, Date.now() + 2200);
    }
    clearTimeout(refreshSoon);   // 여러 알림이 몰리면 한 번만 맞춤
    refreshSoon = setTimeout(() => refresh(true), 150);
  }
  function describe(ev) {
    const n = ev.by?.nickname ?? '누군가', name = ev.marker?.name, c = ev.changes || {};
    switch (ev.action) {
      case 'marker.add': return `${n} 님이 ${CATS[c.cat]?.icon ?? '📍'} ${quoted(name, '을', '를')} 마킹했어요`;
      case 'marker.delete': return `${n} 님이 ${quoted(name, '을', '를')} 지웠어요`;
      case 'marker.update': {
        const did = [];
        if ('name' in c) did.push(`이름을 ${quoted(c.name, '으로', '로')}`);
        if ('cat' in c) { const k = CATS[c.cat]?.name ?? c.cat; did.push(`분류를 ${CATS[c.cat]?.icon ?? ''} ${k}${josa(k, '으로', '로')}`); }
        if (did.length) return `${n} 님이 '${name}'의 ${did.join(', ')} 바꿨어요`;
        if (c.on === false) return `${n} 님이 ${quoted(name, '을', '를')} 경로에서 뺐어요`;
        if (c.on === true) return `${n} 님이 ${quoted(name, '을', '를')} 경로 맨 끝에 넣었어요`;
        return `${n} 님이 ${quoted(name, '을', '를')} 바꿨어요`;
      }
      case 'order': return `${n} 님이 경로 순서를 바꿨어요`;
      case 'map.update':
        if ('title' in c) return `${n} 님이 지도 제목을 ${quoted(c.title, '으로', '로')} 바꿨어요`;
        if ('mode' in c) return `${n} 님이 이동수단을 ${{ car: '🚗 자동차로', transit: '🚌 대중교통으로', walk: '🚶 도보로' }[c.mode]} 바꿨어요`;
        if ('loop' in c) return `${n} 님이 숙소 왕복을 ${c.loop ? '켰어요' : '껐어요'}`;
        if ('legModes' in c) return describeLegModes(n, c.legModes);
        return `${n} 님이 지도 설정을 바꿨어요`;
      case 'member.join': return `${n} 님이 처음 들어왔어요`;
      default: return `${n} 님이 지도를 바꿨어요`;
    }
  }
  /** 구간 이동수단 변경: 지금 화면 상태(바뀌기 전)와 비교해서 어느 구간이 무엇으로 바뀌었는지 */
  function describeLegModes(n, next) {
    const name = key => state.markers.find(m => posKey(m) === key)?.name ?? '?';
    const keys = new Set([...Object.keys(next || {}), ...Object.keys(state.legModes)]);
    const diff = [...keys].filter(k => (next?.[k] || state.mode) !== (state.legModes[k] || state.mode));
    if (diff.length !== 1) return `${n} 님이 구간 이동수단을 바꿨어요`;
    const [from, to] = diff[0].split('>').map(name), mode = next?.[diff[0]] || state.mode;
    return `${n} 님이 '${from} → ${to}' 구간을 ${MODES[mode][0]} ${MODE_TO[mode]} 바꿨어요`;
  }
  /** 활동 기록에 남기고, quiet 가 아니면 토스트로도 알림 */
  function note(text, by, { quiet = false } = {}) {
    activity.unshift({ text, by, at: Date.now() });
    activity.length = Math.min(activity.length, 50);
    if (!$('#activity')?.open) unseen++;
    if (!quiet) toast(text);
    renderBar();
  }
  /** app.js 목록에서: 방금 다른 사람이 바꾼 마커면 반짝임 */
  const isFlashing = id => (flashUntil.get(id) ?? 0) > Date.now();

  // ───────── 들어가기 ─────────
  async function enter(rawCode) {
    const code = String(rawCode).trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { toast('지도 코드는 영문·숫자 4자리예요'); return false; }
    let data;
    try { data = await call('GET', `/api/maps/${code}`); }
    catch (e) { toast(e.status === 404 ? `${code} 지도가 없어요` : `공유 지도를 열지 못했어요: ${e.message}`); return false; }
    let me = null;
    try { me = JSON.parse(localStorage.getItem(meKey(code)) || 'null'); } catch {}
    room = { code, title: '', members: [], me, updatedAt: '', online: null, viewers: 0 };
    document.body.classList.add('in-room');
    apply(data);
    lastSync = Date.now();
    connect();
    setInterval(() => { if (Date.now() - lastSync >= (wsOpen ? POLL_WITH_WS_MS : POLL_MS) - 500) refresh(); }, POLL_MS);
    // 화면으로 돌아왔을 때의 다시 연결·맞추기는 위 visibilitychange 처리에서
    // 방금 만든 지도면 번호부터 보여 줌, 닉네임이 없으면 닉네임부터
    if (sessionStorage.getItem('marker-created') === code) { sessionStorage.removeItem('marker-created'); openShare(true); }
    else if (!room.me) askNickname();
    return true;
  }
  function leave() { location.href = location.pathname; }

  // 이 기기에서 쓴 닉네임들 (최근 것이 앞, 5개까지) — 다른 지도에 들어갈 때 '전에 쓰던 이름'으로 보여 줌
  const deviceNames = () => { try { return JSON.parse(localStorage.getItem('marker-nicknames') || '[]'); } catch { return []; } };
  function rememberName(nickname) {
    localStorage.setItem('marker-nicknames', JSON.stringify([nickname, ...deviceNames().filter(n => n !== nickname)].slice(0, 5)));
  }
  function rememberMe(member) {
    room.me = { id: member.id, nickname: member.nickname };
    localStorage.setItem(meKey(room.code), JSON.stringify(room.me));
    rememberName(member.nickname);
    renderBar();
    connect();   // 닉네임이 생겼으니 '구경'이 아니라 그 이름으로 다시 접속
  }
  function forgetMe() { room.me = null; localStorage.removeItem(meKey(room.code)); }

  // ───────── app.js 가 부르는 변경 (모두 누가 했는지 memberId 를 붙임) ─────────
  /** 마킹 전에 닉네임이 있어야 함. 없으면 닉네임 창을 띄우고 false */
  function canWrite() {
    if (!room || room.me) return true;
    askNickname();
    return false;
  }
  const me = () => room.me?.id;
  const addMarker = m => write('POST', `/api/maps/${room.code}/markers`, { memberId: me(), name: m.name, lat: m.lat, lng: m.lng, cat: m.cat });
  const patchMarker = (m, body) => typeof m.id === 'number' && write('PATCH', `/api/maps/${room.code}/markers/${m.id}`, { memberId: me(), ...body });
  const deleteMarker = m => typeof m.id === 'number' && write('DELETE', `/api/maps/${room.code}/markers/${m.id}?memberId=${me()}`);
  const patchMap = body => write('PATCH', `/api/maps/${room.code}`, { memberId: me(), ...body });
  /** 경로에 든 마커 순서를 서버에 반영. 아직 서버 id 가 없는(방금 마킹 중인) 마커가 있으면 다음 동기화에 맡김 */
  function pushOrder() {
    const ids = state.markers.filter(m => m.on).map(m => m.id);
    if (ids.every(id => typeof id === 'number')) write('PUT', `/api/maps/${room.code}/order`, { memberId: me(), ids });
  }

  // ───────── 화면: 위쪽 공유 막대 ─────────
  const isOnline = id => !!room.online?.some(o => o.id === id);
  function avatar(member, extra = '') {
    if (!member) return '';
    return `<span class="avatar ${extra}" style="--a:${avatarColor(member.id)}" title="${esc(member.nickname)}">${esc(initial(member.nickname))}</span>`;
  }
  /** 목록 행에 붙는 '누가 마킹했는지' */
  function byBadge(m) {
    if (!room || !m.by) return '';
    return `<span class="avatar by" style="--a:${avatarColor(m.by.id)}" title="${esc(m.by.nickname)} 님이 마킹">${esc(initial(m.by.nickname))}</span>`;
  }
  /** 팝업에 붙는 마킹한 사람과 마지막으로 바꾼 사람 */
  function byLine(m) {
    if (!room) return '';
    const marked = m.by ? `<div class="by-line">${avatar(m.by)} <b>${esc(m.by.nickname)}</b> 님이 마킹</div>` : '<div class="by-line">마킹한 사람 정보 없음</div>';
    const edited = m.updatedBy ? `<div class="by-line sub">${avatar(m.updatedBy)} <b>${esc(m.updatedBy.nickname)}</b> 님이 마지막으로 바꿈</div>` : '';
    return marked + edited;
  }
  function renderBar() {
    const bar = $('#roomBar');
    if (!room) { bar.innerHTML = ''; return; }
    // 접속 중인 사람이 앞, 그다음 나머지
    const others = room.members.filter(x => x.id !== room.me?.id).sort((a, b) => isOnline(b.id) - isOnline(a.id));
    const onlineOthers = others.filter(o => isOnline(o.id));
    const known = room.online != null;
    // 구경 수에서 나는 뺌 (닉네임을 아직 안 정했으면 내 연결도 '구경'으로 세어짐)
    const viewers = Math.max(0, (room.viewers || 0) - (room.me || !wsOpen ? 0 : 1));
    const viewing = viewers ? `, 구경 ${viewers}명` : '';
    // 나 말고 아무도 없으면 코드 공유를 권하고 바로 공유 창을 여는 버튼
    const status = !others.length
      ? `<span class="muted">친구에게 코드를 공유해봐요${viewing}</span><button class="chip share-chip" data-act="roomShare">코드 공유</button>`
      : !known ? '<span class="muted">연결하는 중…</span>'
      : onlineOthers.length ? `<span class="muted"><b class="live">${onlineOthers.map(o => esc(o.nickname)).join(', ')}</b> 접속 중${viewing}</span>`
      : `<span class="muted">지금은 나만 있어요${viewing}</span>`;
    bar.innerHTML = `
      <div class="room-top">
        <button class="room-code" data-act="roomShare" title="코드·링크 공유">${room.code}</button>
        <button class="room-title" data-act="roomRename" title="제목 바꾸기">${esc(room.title)}</button>
        <button class="link-btn activity-btn" data-act="roomActivity" aria-expanded="${!!$('#activity')?.open}">활동${unseen ? `<span class="dot-n">${unseen}</span>` : ''}</button>
        <button class="link-btn" data-act="roomLeave">내 지도로</button>
      </div>
      <div class="room-people">
        ${room.me ? `<button class="me" data-act="roomNickname" title="닉네임 바꾸기">${avatar(room.me, 'mine')}<b>${esc(room.me.nickname)}</b></button>`
                  : '<button class="me" data-act="roomNickname"><b>닉네임 정하기</b></button>'}
        ${others.length ? `<span class="others">${others.slice(0, 7).map(o => `<span class="who ${known && !isOnline(o.id) ? 'away' : ''}" title="${esc(o.nickname)}${isOnline(o.id) ? ' (접속 중)' : ''}">${avatar(o)}${isOnline(o.id) ? '<i class="on-dot"></i>' : ''}</span>`).join('')}${others.length > 7 ? `<span class="more">+${others.length - 7}</span>` : ''}</span>` : ''}
        ${status}
      </div>
      <details id="activity" ${$('#activity')?.open ? 'open' : ''}>
        <summary class="sr-only">최근 활동</summary>
        ${activity.length ? `<ol class="activity">${activity.map(a => `<li>${avatar(a.by)}<span>${esc(a.text)}</span><time>${ago(a.at)}</time></li>`).join('')}</ol>`
          : '<p class="hint">아직 다른 사람의 활동이 없어요. 누가 마킹하거나 바꾸면 여기에 쌓여요.</p>'}
      </details>`;
  }
  function ago(t) {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return '방금';
    if (s < 3600) return `${Math.floor(s / 60)}분 전`;
    return `${Math.floor(s / 3600)}시간 전`;
  }
  setInterval(() => { if ($('#activity')?.open) renderBar(); }, 30000);   // 'n분 전' 갱신

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
    // 입력 칸에서 Enter 는 그 창의 주 버튼([data-enter], 없으면 .primary). 폼 기본 동작이면 맨 앞 버튼(뒤로·그냥할래요)이 눌림
    // 한글 조합 중 Enter(isComposing)는 글자 확정용이라 무시
    form.addEventListener('keydown', e => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      if (!e.target.matches('input:not([type=checkbox]):not([type=radio])')) return;
      e.preventDefault();
      (form.querySelector('[data-enter]') || form.querySelector('button.primary'))?.click();
    });
    if (!d.open) d.showModal();   // 단계만 바꿀 땐 열린 창 그대로
    d.querySelector('input:not([type=checkbox]):not([type=radio])')?.focus();
  }

  /**
   * 닉네임 정하기. 이 기기에서 전에 쓰던 이름이 이 지도에 있으면 맨 위에 '계속하기'로,
   * 이 지도의 다른 이름들은 골라서 그 사람으로 들어가기, 아니면 새 이름 (이 기기의 최근 이름을 미리 채움)
   */
  function askNickname() {
    const mine = deviceNames();
    const known = room.members.filter(x => mine.includes(x.nickname))
      .sort((a, b) => mine.indexOf(a.nickname) - mine.indexOf(b.nickname));
    const rest = room.members.filter(x => !known.includes(x));
    const suggest = mine.find(n => !room.members.some(x => x.nickname === n)) ?? '';
    const chip = x => `<button class="chip pick" name="pick" value="${esc(x.nickname)}">${avatar(x)} ${esc(x.nickname)}${isOnline(x.id) ? '<i class="on-dot inline" title="지금 접속 중"></i>' : ''}</button>`;
    openDialog(`
      <h2>이 지도에서 쓸 닉네임</h2>
      <p class="hint"><b>${esc(room.title)}</b> (${room.code}). 마킹하면 다른 사람들에게 닉네임이 보여요.</p>
      ${known.length ? `<p class="dlg-label">이 기기에서 쓰던 이름</p>
        <div class="continue-list">${known.map(x => `<button class="btn primary continue" name="pick" value="${esc(x.nickname)}">${avatar(x)} ${esc(x.nickname)}${josa(x.nickname, '으로', '로')} 계속하기</button>`).join('')}</div>` : ''}
      ${rest.length ? `<p class="dlg-label">${known.length ? '다른 이름' : '전에 들어온 적 있다면 내 이름을 누르세요'}</p>
        <div class="chips-row">${rest.map(chip).join('')}</div>
        ${rest.some(x => isOnline(x.id)) ? '<p class="hint small"><i class="on-dot inline"></i> 표시는 지금 접속 중인 이름이에요</p>' : ''}` : ''}
      <label class="dlg-label" for="nick">새 이름</label>
      <input id="nick" name="nickname" maxlength="20" placeholder="예: 지윤" value="${esc(suggest)}" autocomplete="nickname">
      <div class="dlg-actions">
        <button class="btn" value="cancel">구경만 할게요</button>
        <button class="btn ${known.length ? '' : 'primary'}" value="new" data-enter>새 이름으로 들어가기</button>
      </div>`,
    async (fd, value, form) => {
      const nickname = value === 'new' ? String(fd.get('nickname') || '').trim() : value;
      if (!nickname) { form.querySelector('#nick').focus(); return false; }
      const taken = room.members.find(x => x.nickname === nickname);
      if (value === 'new' && taken && !mine.includes(nickname) &&
          !confirm(`'${nickname}'${josa(nickname, '은', '는')} 이미 있는 이름이에요. 그 사람으로 들어갈까요?`)) return false;
      try {
        const { member } = await call('POST', `/api/maps/${room.code}/members`, { nickname });
        rememberMe(member);
        toast(`${member.nickname}${josa(member.nickname, '으로', '로')} 들어왔어요`);
        refresh(true);
      } catch (e) { toast(e.message); return false; }
    });   // 이름 버튼은 submit 버튼이라 그 value(닉네임)로 들어감
    // 이 기기 이름으로 계속하기가 있으면 그 버튼에, 없으면 새 이름 칸에 초점
    (dlg().querySelector('.continue') || dlg().querySelector('#nick'))?.focus();
  }

  /** 번호·링크 공유 창. 방금 만든 지도면 축하 문구로 */
  function openShare(justCreated = false) {
    const url = roomLink(room.code);
    openDialog(`
      <div class="landing">
        <span class="landing-pin" aria-hidden="true"></span>
        <h2>${justCreated ? '공유 지도를 만들었어요' : '같이 새길 사람에게 알려 주세요'}</h2>
        <p class="hint">${esc(room.title)}. 친구가 첫 화면에서 이 코드를 넣거나 링크를 열면 같이 마킹할 수 있어요.</p>
        <div class="code-show" aria-label="지도 코드">${[...room.code].map(ch => `<span>${ch}</span>`).join('')}</div>
        <p class="share-link" title="${esc(url)}">${esc(url.replace(/^https?:\/\//, ''))}</p>
      </div>
      <div class="landing-actions">
        <button class="btn" value="copyCode">코드 복사</button>
        <button class="btn" value="copyLink">링크 복사</button>
        <button class="btn primary" value="close">${justCreated ? '시작하기' : '닫기'}</button>
      </div>
      ${justCreated ? '<button class="link-btn redo" value="redo" title="이 공유 지도에서 나가 첫 화면으로">다시할래요</button>' : ''}`,
    async (fd, value, form) => {
      if (value === 'close') return;
      if (value === 'redo') { leave(); return false; }   // 첫 화면(번호 입력)으로. 만든 지도는 서버에 남음
      const text = value === 'copyCode' ? room.code : url;
      try {
        await navigator.clipboard.writeText(text);
        const btn = form.querySelector(`[value=${value}]`);
        btn.textContent = '복사했어요';
        setTimeout(() => { btn.textContent = value === 'copyCode' ? '코드 복사' : '링크 복사'; }, 1500);
      } catch { prompt('아래 내용을 복사하세요', text); }
      return false;
    });
    dlg().querySelector('[value=close]').focus();
  }

  /**
   * 첫 화면: 뒤를 어둡게 가리고 지도 번호 입력 상자 + [그냥할래요] [새로 만들기] [같이하기]
   * 그냥할래요(또는 Esc)는 닫고 내 지도로, 새로 만들기는 같은 창에서 제목·닉네임 입력으로 넘어감
   */
  function openLanding() {
    openDialog(`
      <div class="landing">
        <span class="landing-pin" aria-hidden="true"></span>
        <h2>같이 새겨요</h2>
        <p class="hint">친구에게 받은 지도 코드를 넣으면 같은 지도에 같이 마킹할 수 있어요.</p>
        <input class="code-box" name="code" maxlength="4" placeholder="A1B2" autocomplete="off" autocapitalize="characters"
          spellcheck="false" aria-label="지도 코드 4자리" aria-describedby="codeMsg">
        <p class="code-msg" id="codeMsg" role="alert"></p>
      </div>
      <div class="landing-actions">
        <button class="btn" value="cancel">그냥할래요</button>
        <button class="btn" value="create">새로 만들기</button>
        <button class="btn primary" value="join">같이하기</button>
      </div>`,
    async (fd, value, form) => {
      if (value === 'create') { openCreate(); return false; }
      const msg = form.querySelector('#codeMsg'), box = form.querySelector('[name=code]');
      const code = String(fd.get('code') || '').trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) { msg.textContent = '영문과 숫자 4자리를 넣어 주세요'; box.focus(); return false; }
      msg.textContent = '';
      const btn = form.querySelector('[value=join]');
      btn.disabled = true; btn.textContent = '찾는 중…';
      try {
        await call('GET', `/api/maps/${code}`);
        location.href = `${location.pathname}?map=${code}`;
        return false;   // 이동할 때까지 창 유지
      } catch (e) {
        msg.textContent = e.status === 404 ? `${code} 지도는 없어요. 코드를 다시 확인해 주세요` : `지도를 열지 못했어요 (${e.message})`;
        btn.disabled = false; btn.textContent = '같이하기';
        box.select();
        return false;
      }
    });
    const box = dlg().querySelector('[name=code]');
    // 입력은 영문 대문자·숫자만 (Enter 는 openDialog 가 주 버튼인 같이하기로 보냄)
    box.addEventListener('input', () => {
      box.value = box.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
      dlg().querySelector('#codeMsg').textContent = '';
    });
  }

  /** 새 공유 지도 만들기 (첫 화면의 '새로 만들기' 다음 단계) */
  function openCreate() {
    const n = state.markers.length;
    openDialog(`
      <h2>새 공유 지도</h2>
      <p class="hint">만들면 4자리 코드가 생겨요. 코드를 아는 사람은 누구나 같이 마킹할 수 있어요.</p>
      <label class="dlg-label" for="ttl">지도 제목</label>
      <input id="ttl" name="title" maxlength="60" placeholder="예: 대구 1박 2일">
      <label class="dlg-label" for="nick2">내 닉네임</label>
      <input id="nick2" name="nickname" maxlength="20" placeholder="예: 지윤" value="${esc(deviceNames()[0] ?? '')}">
      ${n ? `<label class="check"><input type="checkbox" name="copy" checked> 지금 내 마커 ${n}개도 같이 올리기</label>` : ''}
      <div class="landing-actions">
        <button class="btn" value="back">뒤로</button>
        <button class="btn primary" value="create">만들기</button>
      </div>`,
    async (fd, value, form) => {
      if (value === 'back') { openLanding(); return false; }
      const title = String(fd.get('title') || '').trim(), nickname = String(fd.get('nickname') || '').trim();
      if (!title) { form.querySelector('#ttl').focus(); return false; }
      if (!nickname) { form.querySelector('#nick2').focus(); return false; }
      try {
        form.querySelector('[value=create]').textContent = '만드는 중…';
        const { map, member } = await call('POST', '/api/maps', { title, nickname });
        localStorage.setItem(meKey(map.code), JSON.stringify({ id: member.id, nickname: member.nickname }));
        rememberName(member.nickname);
        if (fd.get('copy')) await copyMarkers(map.code, member.id);
        sessionStorage.setItem('marker-created', map.code);   // 들어가자마자 번호 창을 띄우도록
        location.href = `${location.pathname}?map=${map.code}`;
      } catch (e) {
        toast(e.message);
        form.querySelector('[value=create]').textContent = '만들기';
        return false;
      }
    });
  }
  /** 내 지도의 마커·이동수단·숙소 왕복 설정을 새 공유 지도에 그대로 올림 (순서 유지) */
  async function copyMarkers(code, memberId) {
    for (const m of state.markers) {
      const { marker } = await call('POST', `/api/maps/${code}/markers`, { memberId, name: m.name, lat: m.lat, lng: m.lng, cat: m.cat });
      if (!m.on) await call('PATCH', `/api/maps/${code}/markers/${marker.id}`, { memberId, on: false });
    }
    await call('PATCH', `/api/maps/${code}`, { memberId, mode: state.mode, loop: state.loop, legModes: liveLegModes() });
  }

  async function rename() {
    if (!canWrite()) return;
    const title = prompt('지도 제목', room.title)?.trim();
    if (!title || title === room.title) return;
    room.title = title; renderBar();
    await patchMap({ title });
  }
  function toggleActivity() {
    const d = $('#activity');
    if (!d) return;
    d.open = !d.open;
    if (d.open) unseen = 0;
    renderBar();
  }

  // 위쪽 막대 버튼
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'roomStart') openLanding();
    else if (act === 'roomShare') openShare();
    else if (act === 'roomRename') rename();
    else if (act === 'roomLeave') leave();
    else if (act === 'roomNickname') askNickname();
    else if (act === 'roomActivity') toggleActivity();
  });

  return {
    active: () => !!room,
    me: () => room?.me || null,
    code: () => room?.code,
    enter, openLanding, openShare, canWrite, addMarker, patchMarker, deleteMarker, patchMap, pushOrder, refresh,
    byBadge, byLine, isFlashing,
  };
})();
