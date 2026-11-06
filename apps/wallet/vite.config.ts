import { defineConfig } from 'vite';

// Blindspot wallet. Locally (presenter mode, 127.0.0.1) serve.mjs injects the Sepolia RPC URL (the Nox target and the
// one declared bootstrap read) from the local .env. For a hosted build, deploy/deploy.mjs sets the same variables plus
// the public URLs below. No private key is ever injected: the agent key is pasted once in the browser and stored
// encrypted with the owner's passphrase.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5181, strictPort: true },
  define: {
    __WALLET__: JSON.stringify({
      sepoliaRpc: process.env.WALLET_SEPOLIA_RPC ?? '',
      mainnetBootstrap: process.env.WALLET_MAINNET_BOOTSTRAP ?? '',
      // Gas-only trial relayer: the local server, or "/api" on the hosted wallet (same origin, no CORS).
      relayerUrl: process.env.WALLET_RELAYER_URL ?? 'http://127.0.0.1:8788',
      // The example agent app (only used for the "open the agent app" link).
      agentUrl: process.env.WALLET_AGENT_URL ?? 'http://127.0.0.1:5180/',
    }),
  },
});
