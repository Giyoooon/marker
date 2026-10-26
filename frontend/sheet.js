// 모바일 바텀시트: 지도는 화면 전체, 목록 패널(#side)은 아래에서 올라옴
// 높이는 접기(peek: 손잡이·제목·검색만) / 반(half) / 펼치기(full) 셋 중 하나.
// 손잡이를 누르면 차례로 바뀌고, 끌면 따라오다가 가장 가까운 높이에 붙음. 데스크톱(861px 이상)에선 아무것도 안 함
const Sheet = (() => {
  const side = $('#side'), handle = $('#sheetHandle'), header = $('#side > header');
  const mobile = matchMedia('(max-width: 860px)');
  const ORDER = ['peek', 'half', 'full'];
  let state = 'half';

  function heights() {
    const vh = window.innerHeight;
    const peek = Math.min(handle.offsetHeight + header.offsetHeight + 4, vh * 0.6);
    // 반: 지도를 절반쯤 남기면서 목록이 몇 줄은 보이게 (위쪽 영역이 크면 그만큼 더 올림)
    return { peek, half: Math.min(vh - 48, Math.max(peek + 240, Math.round(vh * 0.55))), full: vh - 48 };
  }
  function apply() {
    if (!mobile.matches) {
      side.style.removeProperty('--sheet-h');
      side.classList.remove('peek');
      return;
    }
    side.style.setProperty('--sheet-h', `${heights()[state]}px`);
    side.classList.toggle('peek', state === 'peek');
    handle.setAttribute('aria-label', state === 'full' ? '목록 접기' : '목록 펼치기');
  }
  function set(s) { state = s; apply(); }
  const next = () => set(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]);

  // 끌기: 손가락을 따라 높이를 바꾸고, 놓으면 가장 가까운 높이로. 거의 안 움직였으면 '누르기'로 보고 다음 높이로
  let startY = null, startH = 0, moved = false;
  handle.addEventListener('pointerdown', e => {
    if (!mobile.matches) return;
    startY = e.clientY; startH = side.getBoundingClientRect().height; moved = false;
    side.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', e => {
    if (startY == null) return;
    const dy = startY - e.clientY;
    if (Math.abs(dy) > 6) moved = true;
    const { peek, full } = heights();
    side.style.setProperty('--sheet-h', `${Math.max(peek, Math.min(full, startH + dy))}px`);
  });
  function end(tap) {
    if (startY == null) return;
    startY = null;
    side.classList.remove('dragging');
    if (tap && !moved) return next();
    const h = side.getBoundingClientRect().height, hs = heights();
    state = ORDER.reduce((a, b) => (Math.abs(hs[b] - h) < Math.abs(hs[a] - h) ? b : a));
    apply();
  }
  handle.addEventListener('pointerup', () => end(true));
  handle.addEventListener('pointercancel', () => end(false));
  // 키보드(Enter·Space)로 누른 경우엔 pointer 이벤트가 없음
  handle.addEventListener('click', e => { if (e.detail === 0) next(); });

  // 지도에서 무언가를 보여 줄 땐 시트가 화면을 거의 다 가리지 않게 반으로 내림 (app.js 보다 먼저 처리되게 capture)
  document.addEventListener('click', e => {
    if (!mobile.matches || state !== 'full') return;
    if (e.target.closest('[data-act=focus], [data-act=showResult]')) set('half');
  }, true);
  // 검색하면 결과가 보이게
  $('#searchForm').addEventListener('submit', () => { if (state === 'peek') set('half'); });

  // 위쪽 영역 높이가 바뀌면(공유 막대, 활동 펼침, 검색 결과) 접힌 높이도 다시 계산
  new ResizeObserver(apply).observe(header);
  window.addEventListener('resize', apply);
  mobile.addEventListener('change', apply);
  // 지도 쪽에 '아래가 이만큼 가려져 있다'고 알려 줌 → 마커로 이동·전체 보기 때 피해서 보여 줌
  KMap.setCoverBottom(() => (mobile.matches ? side.getBoundingClientRect().height : 0));
  apply();

  return { set, state: () => state };
})();
