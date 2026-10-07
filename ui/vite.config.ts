import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// `npm run ui:dev` proxies API and WebSocket traffic to the local daemon,
// so the UI can hot-reload against real sessions.
const daemon = process.env.PI_COMPANION_HTTP ?? 'http://127.0.0.1:43721';

export default defineConfig({
  plugins: [
    sveltekit({
      // Single-page app: every route falls back to 200.html, which the daemon serves
      // for unknown paths. Hashed assets live under /_app/immutable and are cached
      // forever; the shell and version.json are revalidated on every load.
      adapter: adapter({
        pages: '../server/web-dist',
        assets: '../server/web-dist',
        fallback: '200.html',
        precompress: false,
        strict: true
      }),
      // Absolute asset URLs: the shell is served from nested routes like /sessions/abc.
      paths: { relative: false },
      // A new build gets a new version; open tabs notice and reload on next navigation.
      version: { pollInterval: 60_000 }
    })
  ],
  server: {
    // The daemon only accepts its own origin, so present proxied requests as coming from it.
    proxy: {
      '/api': {
        target: daemon,
        configure: (proxy) => proxy.on('proxyReq', (request) => request.setHeader('origin', daemon))
      },
      '/ws': {
        target: daemon.replace(/^http/, 'ws'),
        ws: true,
        configure: (proxy) => proxy.on('proxyReqWs', (request) => request.setHeader('origin', daemon))
      }
    }
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0
  }
});
