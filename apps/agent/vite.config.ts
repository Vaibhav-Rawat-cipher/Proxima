import { defineConfig } from 'vite';

// Outside agent app. It holds no wallet keys and no funds; it only knows where the wallet is and, when hosted, where
// the rate-limited LLM proxy is. Locally: presenter setup (127.0.0.1, own AI key, no proxy). On Vercel (VERCEL=1 at
// build time): the wallet at the standard project name and the hosted proxy on /api/chat; both can be overridden.
const onVercel = process.env.VERCEL === '1';
export default defineConfig({
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  define: {
    __AGENT__: JSON.stringify({
      walletUrl: process.env.AGENT_WALLET_URL ?? (onVercel ? 'https://blindspot-wallet.vercel.app/' : 'http://127.0.0.1:5181/'),
      // Path of the hosted LLM proxy on this app's own origin; empty = no hosted model offered.
      llmProxyPath: process.env.AGENT_LLM_PROXY_PATH ?? (onVercel ? '/api/chat' : ''),
    }),
  },
});
