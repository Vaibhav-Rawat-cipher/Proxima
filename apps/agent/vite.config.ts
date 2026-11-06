import { defineConfig } from 'vite';

// Outside agent app. It holds no wallet keys and no funds; it only knows where the wallet is and, when hosted, where
// the rate-limited LLM proxy is. Locally both default to the presenter setup (127.0.0.1, own AI key, no proxy).
export default defineConfig({
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  define: {
    __AGENT__: JSON.stringify({
      walletUrl: process.env.AGENT_WALLET_URL ?? 'http://127.0.0.1:5181/',
      // Path of the hosted LLM proxy on this app's own origin (e.g. "/api/chat"); empty = no hosted model offered.
      llmProxyPath: process.env.AGENT_LLM_PROXY_PATH ?? '',
    }),
  },
});
