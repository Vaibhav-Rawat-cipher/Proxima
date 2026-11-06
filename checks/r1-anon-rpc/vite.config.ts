import { defineConfig } from 'vite';

// Local-only check page. The RPC URLs are injected by run.mjs from the local .env and only ever
// served to 127.0.0.1; this page is never built or deployed.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  define: {
    __R1__: JSON.stringify({
      network: process.env.R1_NETWORK ?? 'nox',
      targetRpc: process.env.R1_TARGET_RPC ?? '',
      bootstrapRpc: process.env.R1_BOOTSTRAP_RPC ?? '',
    }),
  },
});
