import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = process.env.QUORUM_ENV_FILE || path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// Accepts the endpoint the way the Azure portal shows it (resource URL, .../openai/v1/ or a full
// .../chat/completions URL) and returns the v1 base URL: https://<resource>.openai.azure.com/openai/v1/
export function azureBaseUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error(`AZURE_OPENAI_ENDPOINT is not a URL: "${raw}"`);
  }
  if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) {
    throw new Error('AZURE_OPENAI_ENDPOINT must start with https://');
  }
  let p = u.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  if (!/\/openai\/v1$/.test(p)) p = `${p.replace(/\/openai$/, '')}/openai/v1`;
  return `${u.origin}${p}/`;
}

export function resolveConfig(env) {
  const port = Number(env.PORT || 8790);

  // PayPal: "mock" runs a local imitation of the REST endpoints Quorum uses,
  // "sandbox" talks to api-m.sandbox.paypal.com. Live mode is deliberately not wired up.
  const hasPayPalKeys = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  const paypalMode = (env.PAYPAL_MODE || (hasPayPalKeys ? 'sandbox' : 'mock')).toLowerCase();
  if (!['mock', 'sandbox'].includes(paypalMode)) {
    throw new Error(`PAYPAL_MODE must be "mock" or "sandbox" (got "${paypalMode}")`);
  }
  if (paypalMode === 'sandbox' && !hasPayPalKeys) {
    throw new Error('PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
  }

  // AI: "azure-openai" calls a model deployment in Azure OpenAI, "mock" returns hand-written sample
  // outputs for the demo data. A key or an explicit AI_PROVIDER turns the model on; a half-filled
  // setup is an error rather than a silent fallback to mock.
  const aiMode = (env.AI_PROVIDER || (env.AZURE_OPENAI_API_KEY ? 'azure-openai' : 'mock')).toLowerCase();
  if (!['mock', 'azure-openai'].includes(aiMode)) {
    throw new Error(`AI_PROVIDER must be "azure-openai" or "mock" (got "${aiMode}")`);
  }
  let azure = null;
  if (aiMode === 'azure-openai') {
    const missing = ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_DEPLOYMENT'].filter((k) => !env[k]);
    if (missing.length) throw new Error(`AI_PROVIDER=azure-openai needs ${missing.join(', ')} in .env`);
    azure = {
      baseUrl: azureBaseUrl(env.AZURE_OPENAI_ENDPOINT),
      apiKey: env.AZURE_OPENAI_API_KEY,
      // Azure OpenAI takes the deployment name in the "model" field of a v1 request.
      deployment: env.AZURE_OPENAI_DEPLOYMENT,
    };
  }

  return {
    port,
    publicUrl: env.PUBLIC_URL || `http://localhost:${port}`,
    dataDir: env.QUORUM_DATA_DIR || path.join(ROOT, 'data'),
    paypalMode,
    paypalBase: paypalMode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : `http://127.0.0.1:${port}/mock-paypal`,
    paypalClientId: paypalMode === 'sandbox' ? env.PAYPAL_CLIENT_ID : 'mock-client-id',
    paypalClientSecret: paypalMode === 'sandbox' ? env.PAYPAL_CLIENT_SECRET : 'mock-client-secret',
    aiMode,
    azure,
    // Shown in the header badge; the API reports the underlying model on each reply.
    modelLabel: aiMode === 'azure-openai' ? env.AZURE_OPENAI_MODEL || env.AZURE_OPENAI_DEPLOYMENT : null,
  };
}

export const config = resolveConfig(process.env);
