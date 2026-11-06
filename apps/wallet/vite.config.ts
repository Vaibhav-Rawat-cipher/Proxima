import { defineConfig } from 'vite';

// Blindspot wallet, local presenter mode (127.0.0.1 only). serve.mjs injects the Sepolia RPC URL (the Nox target
// and the one declared bootstrap read) from the local .env. No private key is ever injected: the agent key is
// pasted once in the browser and stored encrypted with the owner's passphrase.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5181, strictPort: true },
  define: { __WALLET__: JSON.stringify({ sepoliaRpc: process.env.WALLET_SEPOLIA_RPC ?? '', mainnetBootstrap: process.env.WALLET_MAINNET_BOOTSTRAP ?? '', relayerUrl: 'http://127.0.0.1:8788' }) },
});
