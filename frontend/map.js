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

  async function init(el, { appKey, center, level, onClick, onAction }) {
    await loadSdk(appKey);
    map = new kakao.maps.Map(el, { center: LL(...center), level });
    map.addControl(new kakao.maps.ZoomControl(), kakao.maps.ControlPosition.RIGHT);
    kakao.maps.event.addListener(map, 'click', e => onClick(e.latLng.getLat(), e.latLng.getLng()));
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

  function line(layer, path, color, { dashed = false, weight = 5, opacity = 0.9 } = {}) {
    const pl = new kakao.maps.Polyline({ path: path.map(([lat, lng]) => LL(lat, lng)), strokeWeight: weight, strokeColor: color,
      strokeOpacity: opacity, strokeStyle: dashed ? 'shortdash' : 'solid' });
    show(pl, layer);
    layers[layer].push(pl);
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

  return { init, pin, line, clear, setVisible, openPopup, closePopup, setView, focus, fit, center, ready, onAction: () => {} };
})();
