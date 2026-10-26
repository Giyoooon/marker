// config.js 로 복사해서 사용 (config.js 는 git 에 올라가지 않음)
// 배포 시에는 GitHub Actions 가 저장소 변수(KAKAO_JS_KEY, API_BASE)로 config.js 를 만들어요.
window.MARKER_CONFIG = {
  // 카카오 개발자 > 내 애플리케이션 > 앱 키 > JavaScript 키
  KAKAO_JS_KEY: '',
  // 백엔드 주소 (로컬: npm run dev 로 띄운 wrangler)
  API_BASE: 'http://localhost:8787',
};
