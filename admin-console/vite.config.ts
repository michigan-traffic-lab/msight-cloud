import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  // amazon-cognito-identity-js depends on `buffer`, which references Node's
  // `global`. Browsers have no such binding, so map it to globalThis. This has
  // to be declared twice: `define` covers app source, and the optimizeDeps
  // block covers the prebundled dependency where the reference actually lives.
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Must match adminConsole.allowedOrigins in deploy.config.yaml.
    port: 5173,
    strictPort: true,
  },
});
