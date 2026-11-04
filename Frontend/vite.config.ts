import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// In development the browser talks to the Vite server only; /api and /socket.io are proxied to the backend, so the
// session cookies are first-party and no CORS is involved. In production set VITE_API_URL / VITE_SOCKET_URL.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.DEV_PROXY_TARGET || 'http://localhost:4000';
  return {
    plugins: [react()],
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    server: {
      port: 5173,
      proxy: {
        '/api': { target, changeOrigin: false },
        '/socket.io': { target, ws: true, changeOrigin: false },
      },
    },
    build: { sourcemap: true, chunkSizeWarningLimit: 900 },
  };
});
