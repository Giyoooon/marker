// config.js 로 복사해서 사용 (config.js 는 git 에 올라가지 않음)
// 배포 시에는 GitHub Actions 가 저장소 변수(KAKAO_JS_KEY, API_BASE, TURNSTILE_SITE_KEY)로 config.js 를 만들어요.
window.MARKER_CONFIG = {
  // 카카오 개발자 > 내 애플리케이션 > 앱 키 > JavaScript 키
  KAKAO_JS_KEY: '',
  // 백엔드 주소 (로컬: npm run dev 로 띄운 wrangler)
  API_BASE: 'http://localhost:8787',
  // Cloudflare Turnstile 사이트 키 (사람 확인). 비우면 끔. 로컬 시험용 '항상 통과' 키: 1x00000000000000000000AA
  TURNSTILE_SITE_KEY: '',
};
