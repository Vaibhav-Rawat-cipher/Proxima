import { defineConfig } from 'vite';

// Local-only check page. serve.mjs injects the Sepolia RPC URL (the Nox target and the one bootstrap read)
// from the local .env; the page is only ever served to 127.0.0.1 and is never built or deployed.
// No private keys are injected: keys are pasted into the page and stored encrypted with the user's passphrase.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5175, strictPort: true },
  define: {
    __E2E__: JSON.stringify({ sepoliaRpc: process.env.E2E_SEPOLIA_RPC ?? '', llmProxy: 'http://127.0.0.1:8787/v1/chat/completions' }),
  },
});
