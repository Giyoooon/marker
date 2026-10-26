// 카카오맵 JS SDK 래퍼 — app.js 는 이 객체만 사용
const KMap = (() => {
  let map = null, popup = null;
  const layers = { base: [], route: [], manual: [] };
  const visible = { base: true, route: true, manual: true };
  const show = (o, layer) => o.setMap(visible[layer] ? map : null);
  const LL = (lat, lng) => new kakao.maps.LatLng(lat, lng);

  function loadSdk(appKey) {
    return new Promise((resolve, reject) => {
      if (!appKey) return reject(new Error('config.js 에 KAKAO_JS_KEY 가 비어 있어요'));
      const s = document.createElement('script');
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(appKey)}&autoload=false`;
      s.onload = () => (window.kakao?.maps ? kakao.maps.load(resolve) : reject(new Error('SDK 응답이 올바르지 않아요')));
      s.onerror = () => reject(new Error('카카오맵 SDK를 불러오지 못했어요'));
      document.head.appendChild(s);
    });
  }

  // 선을 누르면 지도 클릭(마킹 팝업)도 같이 일어나므로, 같은 클릭이면 지도 클릭은 무시
  let lineClicked = false;

  async function init(el, { appKey, center, level, onClick, onAction, onIdle }) {
    await loadSdk(appKey);
    map = new kakao.maps.Map(el, { center: LL(...center), level });
    map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
    kakao.maps.event.addListener(map, 'click', e => {
      const lat = e.latLng.getLat(), lng = e.latLng.getLng();
      setTimeout(() => { if (lineClicked) lineClicked = false; else onClick(lat, lng); }, 0);
    });
    // 이동·확대가 끝나면 (화면 간격으로 놓는 화살표를 다시 배치하도록) 알림
    if (onIdle) kakao.maps.event.addListener(map, 'idle', onIdle);
    KMap.onAction = onAction;
    window.addEventListener('resize', () => map.relayout());
  }

  /**
   * drop: 끝이 좌표를 가리키는 물방울 핀 (회전한 정사각형이라 끝이 높이의 약 1.21배 지점에 옴)
   * 아니면 좌표 중심에 놓이는 동그라미
   */
  function pin(layer, { lat, lng, color, label = '', size = 22, title = '', z = 1, onClick, drop = false, cls = '' }) {
    const el = document.createElement('div');
    el.className = (drop ? 'drop' : 'pin') + (cls ? ' ' + cls : '');
    el.style.setProperty('--c', color);
    Object.assign(el.style, { width: size + 'px', height: size + 'px', cursor: onClick ? 'pointer' : 'default' });
    const text = document.createElement('span');
    text.textContent = label;
    el.appendChild(text);
    el.title = title;
    if (onClick) el.addEventListener('click', e => { e.stopPropagation(); onClick(); });
    const ov = new kakao.maps.CustomOverlay({ position: LL(lat, lng), content: el, xAnchor: 0.5, yAnchor: drop ? 1.21 : 0.5, zIndex: z, clickable: true });
    show(ov, layer);
    layers[layer].push(ov);
  }

  function line(layer, path, color, { dashed = false, weight = 5, opacity = 0.9, z = 1, onClick, onOver, onOut } = {}) {
    const pl = new kakao.maps.Polyline({ path: path.map(([lat, lng]) => LL(lat, lng)), strokeWeight: weight, strokeColor: color,
      strokeOpacity: opacity, strokeStyle: dashed ? 'shortdash' : 'solid', zIndex: z });
    if (onClick) kakao.maps.event.addListener(pl, 'click', () => { lineClicked = true; onClick(); });
    if (onOver) kakao.maps.event.addListener(pl, 'mouseover', onOver);
    if (onOut) kakao.maps.event.addListener(pl, 'mouseout', onOut);
    show(pl, layer);
    layers[layer].push(pl);
  }

  /**
   * 경로 위 진행 방향 화살표. 화면에서 spacing(px)마다 하나씩, 지금 보이는 범위 안에만 놓음
   * (확대 수준에 따라 간격이 달라지므로 지도 idle 때마다 다시 그려야 함)
   */
  function arrows(layer, path, { spacing = 90, offset = 45, z = 5 } = {}) {
    if (path.length < 2) return;
    const proj = map.getProjection(), bounds = map.getBounds();
    const px = path.map(([lat, lng]) => proj.containerPointFromCoords(LL(lat, lng)));
    const total = px.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - px[i].x, p.y - px[i].y), 0);
    let acc = 0, next = Math.min(offset, total / 2), placed = 0;
    for (let i = 0; i + 1 < px.length && placed < 200; i++) {
      const a = px[i], b = px[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
      while (len > 0 && acc + len >= next && next <= total - 20 && placed < 200) {
        const t = (next - acc) / len;
        const at = proj.coordsFromContainerPoint(new kakao.maps.Point(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
        if (bounds.contain(at)) {
          const el = document.createElement('div');
          el.className = 'arrow';
          el.style.transform = `rotate(${Math.atan2(b.y - a.y, b.x - a.x)}rad)`;
          const ov = new kakao.maps.CustomOverlay({ position: at, content: el, xAnchor: 0.5, yAnchor: 0.5, zIndex: z });
          show(ov, layer);
          layers[layer].push(ov);
        }
        next += spacing;
        placed++;
      }
      acc += len;
    }
  }

  function setVisible(layer, on) { visible[layer] = on; layers[layer].forEach(o => o.setMap(on ? map : null)); }
  function clear(layer) { layers[layer].forEach(o => o.setMap(null)); layers[layer].length = 0; }

  function openPopup(lat, lng, html) {
    closePopup();
    const el = document.createElement('div');
    el.className = 'popup';
    el.innerHTML = `<button class="x close" data-act="closePopup">✕</button>${html}`;
    // 팝업 안 클릭이 지도 클릭으로 번지지 않게 막고, 버튼 동작은 app.js 로 넘김
    el.addEventListener('click', e => { e.stopPropagation(); KMap.onAction(e); });
    el.addEventListener('mousedown', e => e.stopPropagation());
    popup = new kakao.maps.CustomOverlay({ position: LL(lat, lng), content: el, xAnchor: 0.5, yAnchor: 1.12, zIndex: 3000, clickable: true });
    popup.setMap(map);
    return el;
  }
  function closePopup() { if (popup) { popup.setMap(null); popup = null; } }

  const center = () => { const c = map.getCenter(); return { lat: c.getLat(), lng: c.getLng() }; };
  function setView(lat, lng, level) { if (level) map.setLevel(level); map.setCenter(LL(lat, lng)); }
  function focus(lat, lng) { if (map.getLevel() > 4) map.setLevel(4); map.panTo(LL(lat, lng)); }
  function fit(points) {
    if (!points.length) return;
    const b = new kakao.maps.LatLngBounds();
    points.forEach(([lat, lng]) => b.extend(LL(lat, lng)));
    map.setBounds(b, 40, 40, 40, 40);
  }
  const ready = () => !!map;

  return { init, pin, line, arrows, clear, setVisible, openPopup, closePopup, setView, focus, fit, center, ready, onAction: () => {} };
})();
