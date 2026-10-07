import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// `npm run ui:dev` proxies API and WebSocket traffic to the local daemon,
// so the UI can hot-reload against real sessions.
const daemon = process.env.PI_COMPANION_HTTP ?? 'http://127.0.0.1:43721';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      '/api': daemon,
      '/ws': { target: daemon.replace(/^http/, 'ws'), ws: true }
    }
  },
  build: {
    target: 'es2022'
  }
});
