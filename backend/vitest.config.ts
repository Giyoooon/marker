import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Node 에서 테스트할 때 Workers 전용 모듈을 대신할 stub
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers-stub.ts', import.meta.url).href) },
  },
});
