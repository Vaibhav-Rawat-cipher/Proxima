import { defineConfig } from 'vite';

// Blindspot wallet. Locally (presenter mode, 127.0.0.1) serve.mjs injects the Sepolia RPC URL (the Nox target and the
// one declared bootstrap read) from the local .env. On Vercel (VERCEL=1 at build time) the same RPC comes from the
// project's SEPOLIA_RPC_URL and the public URLs default to the standard project names below; every value can still be
// overridden with the WALLET_* variables. No private key is ever injected: the agent key is pasted once in the browser
// and stored encrypted with the owner's passphrase.
const onVercel = process.env.VERCEL === '1';
export default defineConfig({
  server: { host: '127.0.0.1', port: 5181, strictPort: true },
  define: {
    __WALLET__: JSON.stringify({
      sepoliaRpc: process.env.WALLET_SEPOLIA_RPC ?? process.env.SEPOLIA_RPC_URL ?? '',
      mainnetBootstrap: process.env.WALLET_MAINNET_BOOTSTRAP ?? process.env.MAINNET_BOOTSTRAP_RPC_URL ?? '',
      // Gas-only trial relayer: the local server, or "/api" on the hosted wallet (same origin, no CORS).
      relayerUrl: process.env.WALLET_RELAYER_URL ?? (onVercel ? '/api' : 'http://127.0.0.1:8788'),
      // The example agent app (only used for the "open the agent app" link).
      agentUrl: process.env.WALLET_AGENT_URL ?? (onVercel ? 'https://blindspot-agent.vercel.app/' : 'http://127.0.0.1:5180/'),
    }),
  },
});
