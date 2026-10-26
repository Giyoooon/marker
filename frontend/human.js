// 사람 확인 (Cloudflare Turnstile): 공유 지도에서 바꾸는 요청·웹소켓 전에 한 번 확인하고 24시간짜리 통과증을 받아 둠
// - 대부분 아무것도 안 눌러도 자동으로 통과. 의심스러울 때만 화면 아래에 체크 상자가 뜸 (appearance: interaction-only)
// - 통과증은 이 기기에 기억 (localStorage: marker-human-pass). 서버가 거절하면(401) 지우고 다시 확인
// - TURNSTILE_SITE_KEY 가 없으면(config.js) 꺼짐 → 통과증 없이 보냄 (서버도 비밀키가 없으면 확인하지 않음)
const Human = (() => {
  const KEY = 'marker-human-pass';
  const SITE_KEY = window.MARKER_CONFIG?.TURNSTILE_SITE_KEY || '';
  const MARGIN_MS = 5 * 60 * 1000;   // 만료 5분 전이면 미리 새로 받음
  let inflight = null, scriptLoad = null;

  function saved() {
    try {
      const p = JSON.parse(localStorage.getItem(KEY));
      return p && p.exp - MARGIN_MS > Date.now() ? p.pass : null;
    } catch { return null; }
  }
  const clear = () => localStorage.removeItem(KEY);

  function loadScript() {
    scriptLoad ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => { scriptLoad = null; reject(new Error('사람 확인을 불러오지 못했어요. 잠시 뒤 다시 해 주세요')); };
      document.head.append(s);
    });
    return scriptLoad;
  }

  /** Turnstile 위젯을 띄워 토큰을 받음. 확인이 필요할 때만 화면 아래 상자가 보임 */
  async function challenge() {
    const ts = await loadScript();
    const box = document.createElement('div');
    box.className = 'human-check';
    box.innerHTML = '<p>사람인지 한 번만 확인할게요</p><div class="human-widget"></div>';
    document.body.append(box);
    try {
      return await new Promise((resolve, reject) => {
        const id = ts.render(box.querySelector('.human-widget'), {
          sitekey: SITE_KEY,
          appearance: 'interaction-only',
          language: 'ko',
          action: 'marker',
          'before-interactive-callback': () => box.classList.add('show'),
          'after-interactive-callback': () => box.classList.remove('show'),
          callback: token => { resolve(token); ts.remove(id); },
          'error-callback': () => { reject(new Error('사람 확인에 실패했어요. 새로고침한 뒤 다시 해 주세요')); ts.remove(id); },
          'timeout-callback': () => { reject(new Error('사람 확인 시간이 지났어요. 다시 해 주세요')); ts.remove(id); },
        });
      });
    } finally { box.remove(); }
  }

  /** 쓸 수 있는 통과증. 꺼져 있으면 null. 여러 요청이 동시에 불러도 확인은 한 번만 */
  async function pass() {
    if (!SITE_KEY) return null;
    const p = saved();
    if (p) return p;
    inflight ??= (async () => {
      const token = await challenge();
      const res = await fetch(`${API}/api/human`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }), signal: AbortSignal.timeout(10000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '사람 확인에 실패했어요');
      if (data.pass) localStorage.setItem(KEY, JSON.stringify({ pass: data.pass, exp: data.exp }));
      return data.pass ?? null;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  return { pass, clear, enabled: () => !!SITE_KEY };
})();
