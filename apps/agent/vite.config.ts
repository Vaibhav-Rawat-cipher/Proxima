import { defineConfig } from 'vite';

// Outside agent app (127.0.0.1 only). It holds no wallet keys and no funds; it only knows where the wallet is.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5180, strictPort: true },
  define: { __AGENT__: JSON.stringify({ walletUrl: 'http://127.0.0.1:5181/' }) },
});
