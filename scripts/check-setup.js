// Quick check after adding keys to .env (npm run check):
//   PayPal: gets a sandbox OAuth token and creates one AUTHORIZE order (no buyer needed, nothing is charged).
//   AI:     sends one small structured-output request to the Azure OpenAI deployment.
import { config } from '../server/config.js';
import { createPayPal } from '../server/paypal.js';

console.log(`PayPal: ${config.paypalMode}`);
console.log(`AI:     ${config.aiMode === 'azure-openai' ? `Azure OpenAI, deployment "${config.azure.deployment}" at ${config.azure.baseUrl}` : 'mock'}`);

if (config.paypalMode === 'sandbox') {
  const pp = createPayPal({ base: config.paypalBase, clientId: config.paypalClientId, clientSecret: config.paypalClientSecret });
  try {
    const order = await pp.createOrder({
      intent: 'AUTHORIZE',
      purchase_units: [{ custom_id: 'setup-check', amount: { currency_code: 'USD', value: '1.00', breakdown: { item_total: { currency_code: 'USD', value: '1.00' } } }, items: [{ name: 'Setup check', quantity: '1', unit_amount: { currency_code: 'USD', value: '1.00' }, category: 'PHYSICAL_GOODS' }] }],
      payment_source: { paypal: { experience_context: { shipping_preference: 'GET_FROM_FILE', user_action: 'CONTINUE', return_url: `${config.publicUrl}/`, cancel_url: `${config.publicUrl}/` } } },
    });
    console.log(`PayPal sandbox OK: order ${order.id} (${order.status}). Nothing was charged; the order expires on its own.`);
  } catch (e) {
    console.log(`PayPal sandbox FAILED: ${e.message}${e.debugId ? ` (debug_id ${e.debugId})` : ''}`);
    if (e.status === 401) console.log('  Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET: they must be the Sandbox credentials of the app, not Live.');
    if (e.body?.details) console.log(JSON.stringify(e.body.details, null, 2));
    process.exitCode = 1;
  }
} else {
  console.log('PayPal: mock mode (add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env for the sandbox)');
}

if (config.aiMode === 'azure-openai') {
  const { ai } = await import('../server/ai.js');
  try {
    const r = await ai.answerFan({
      campaign: { title: 'Setup check', creator_name: 'Quorum', summary_en: 'Test campaign', closes_at: new Date().toISOString(), ship_estimate_en: 'Next week', options: [], shipping_regions: [] },
      totals: {},
      question: 'Is this a test?',
    });
    console.log(`AI OK: ${r.meta.model}, ${r.meta.ms} ms, ${r.meta.input_tokens} in / ${r.meta.output_tokens} out tokens, answer: "${r.data.answer.slice(0, 80)}"`);
  } catch (e) {
    console.log(`AI FAILED: ${e.message}`);
    for (const hint of aiHints(e)) console.log(`  ${hint}`);
    process.exitCode = 1;
  }
} else {
  console.log('AI: mock mode (add AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY and AZURE_OPENAI_DEPLOYMENT to .env)');
}

function aiHints(e) {
  if (e.status === 401 || e.status === 403) return ['The key was rejected. AZURE_OPENAI_API_KEY must be a key of the resource in AZURE_OPENAI_ENDPOINT.'];
  if (e.status === 404) return [`Not found. Check that AZURE_OPENAI_DEPLOYMENT ("${config.azure.deployment}") is the deployment name, and that the endpoint is the resource's /openai/v1/ URL.`];
  if (e.status === 400) return ['The request was refused as invalid. The message above names the field; the deployed model must support structured outputs (json_schema) and reasoning_effort.'];
  if (e.status === 429) return ['Rate limited or out of quota. Wait a minute, and check the deployment quota (tokens per minute).'];
  return [];
}
