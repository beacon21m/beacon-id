import { getEnv } from './types';
import { startCvmServer } from './identity/cvm';
import { startIdentityWorker } from './identity/worker';
import { startIdentityCvmDispatcher } from './identity/cvm-dispatcher';

function main() {
  const npub = getEnv('GATEWAY_NPUB', '');
  if (!npub) {
    console.warn('[identity_start] GATEWAY_NPUB is not set; WhatsApp adapter will still run but outbound filtering may be broad');
  }
  // Identity: CVM-only; do not start any local gateway adapters
  console.log('[identity_start] CVM-only mode enabled (no local gateways)');

  // Start CVM server
  startCvmServer().catch(err => {
    console.error('[CVM] Failed to start CVM server:', err);
    process.exit(1);
  });

  // Start identity worker
  startIdentityWorker();
  // Start CVM dispatcher for Identity outbound -> remote gateways
  startIdentityCvmDispatcher();

  // Minimal HTTP server for health
  // Prefer standard PORT, but accept legacy PORTID for compatibility
  const port = parseInt(getEnv('PORT', getEnv('PORTID', '3011')) || '3011', 10);

  const json = (data: any, code = 200) => new Response(JSON.stringify(data), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });

  Bun.serve({
    port,
    fetch: async (req) => {
      const { pathname } = new URL(req.url);

      if (pathname === '/' || pathname === '/health') {
        return json({ ok: true, service: 'beacon-identity', npub });
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  console.log(`[identity_start] Identity service started; HTTP on :${port}`);
}

main();
