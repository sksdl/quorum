// Exercises the real model path (AI_PROVIDER=azure-openai) against a local fake of the Azure OpenAI
// v1 Chat Completions endpoint, so request shape, parsing, refusals and the .env rules are tested
// without a key or network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-ai-test-'));
for (const k of ['AI_PROVIDER', 'AZURE_OPENAI_MODEL']) delete process.env[k];
Object.assign(process.env, {
  QUORUM_ENV_FILE: '/nonexistent',
  PAYPAL_MODE: 'mock',
  QUORUM_DATA_DIR: dataDir,
  // pasted the way the portal shows a full request URL; config turns it into the v1 base URL
  AZURE_OPENAI_ENDPOINT: 'http://127.0.0.1:8798/openai/v1/chat/completions',
  AZURE_OPENAI_API_KEY: 'test-key-not-real',
  AZURE_OPENAI_DEPLOYMENT: 'quorum-model',
});

const seen = [];
let reply = null;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const [status, out] = reply();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
});

const completion = (obj, { finish = 'stop', refusal = null } = {}) => [
  200,
  {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'test-model-2026-01-01',
    choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: refusal ? null : JSON.stringify(obj), refusal } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } },
  },
];

const { config, resolveConfig, azureBaseUrl } = await import('../server/config.js');
const { ai, validateCampaignDraft } = await import('../server/ai.js');

before(() => new Promise((r) => fake.listen(8798, r)));
after(() => {
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const emptyCampaign = { title: 't', creator_name: 'c', summary_en: '', closes_at: '', ship_estimate_en: '', options: [], shipping_regions: [] };

test('draftCampaign sends a strict json_schema request to the deployment and parses the reply', async () => {
  assert.equal(config.aiMode, 'azure-openai');
  const draft = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/ai-mock/campaign-draft.json'), 'utf8'));
  reply = () => completion(draft);
  const r = await ai.draftCampaign({ postText: '게시글', quoteText: '견적' });
  assert.equal(r.meta.mode, 'azure-openai');
  assert.equal(r.meta.model, 'test-model-2026-01-01');
  assert.deepEqual([r.meta.input_tokens, r.meta.output_tokens, r.meta.reasoning_tokens], [10, 20, 5]);
  assert.deepEqual(validateCampaignDraft(r.data), []);
  const req = seen.at(-1);
  assert.equal(req.url, '/openai/v1/chat/completions');
  assert.equal(req.headers['api-key'], 'test-key-not-real');
  assert.equal(req.body.model, 'quorum-model');
  assert.equal(req.body.response_format.type, 'json_schema');
  assert.equal(req.body.response_format.json_schema.strict, true);
  assert.equal(req.body.response_format.json_schema.name, 'campaign_draft');
  assert.equal(req.body.reasoning_effort, 'medium');
  assert.equal(req.body.max_completion_tokens, 16000);
  assert.deepEqual(req.body.messages.map((m) => m.role), ['system', 'user']);
  assert.match(req.body.messages[1].content, /<creator_post>\n게시글/);
});

test('every schema object is closed and lists all keys as required (strict mode needs both)', () => {
  const walk = (s, where) => {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, where);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort(), where);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${where}.${k}`);
    }
    if (s.type === 'array') walk(s.items, `${where}[]`);
    for (const alt of s.anyOf || []) walk(alt, where);
  };
  for (const req of seen) walk(req.body.response_format.json_schema.schema, 'schema');
});

test('note templates come back keyed by option id', async () => {
  reply = () =>
    completion({
      templates: [
        {
          language: 'ja',
          item_names: [{ option_id: 'A', name: 'キーホルダー' }],
          note_capture_full: '{creator} {captured} {confirmed_items}',
          note_capture_partial: '{creator} {captured} {released} {cancelled_items} {confirmed_items}',
          message_capture_full: '{captured} {confirmed_items}',
          message_capture_partial: '{captured} {released} {cancelled_items} {confirmed_items}',
          message_void: '{released} {cancelled_items}',
        },
      ],
    });
  const r = await ai.noteTemplates({ campaign: { creator_name: 'S', ship_estimate_en: 'x', options: [{ id: 'A', name_en: 'Keyring' }] }, languages: ['ja'] });
  assert.equal(r.data.templates[0].item_names.A, 'キーホルダー');
});

test('a refusal, a cut-off reply, a content filter and an HTTP error each become an AiError', async () => {
  const ask = () => ai.answerFan({ campaign: emptyCampaign, totals: {}, question: 'q' });
  reply = () => completion(null, { refusal: 'I cannot help with that.' });
  await assert.rejects(ask(), /declined/);
  reply = () => completion({ language: 'en' }, { finish: 'length' });
  await assert.rejects(ask(), /cut off/);
  reply = () => completion({ language: 'en' }, { finish: 'content_filter' });
  await assert.rejects(ask(), /content filtering/);
  reply = () => [404, { error: { code: 'DeploymentNotFound', message: 'The API deployment for this resource does not exist.' } }];
  await assert.rejects(ask(), (e) => e.status === 404 && /DeploymentNotFound/.test(e.message));
  assert.equal(seen.at(-1).body.reasoning_effort, 'low');
  assert.equal(seen.at(-1).body.max_completion_tokens, 4000);
});

test('every call is logged with its tokens for the usage report', () => {
  const lines = fs.readFileSync(path.join(dataDir, 'ai-calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 6);
  assert.deepEqual(Object.keys(lines[0]).slice(0, 3), ['at', 'job', 'ok']);
  assert.equal(lines[0].job, 'campaign_draft');
  assert.equal(lines[0].input_tokens, 10);
  assert.ok(lines.some((l) => !l.ok && /declined/.test(l.error)));
  assert.ok(!JSON.stringify(lines).includes('test-key-not-real'), 'the key is never written to the log');
});

test('shipment matching is split into chunks of 40 rows, each with only its countries', async () => {
  reply = () => completion({ matches: [] });
  const before = seen.length;
  const rows = Array.from({ length: 90 }, (_, i) => ({ row: i + 1, recipient: `R${i}`, country: i < 40 ? 'JP' : 'US', postal_code: '', address: '' }));
  const candidates = [{ pledge_id: 'a', country: 'JP' }, { pledge_id: 'b', country: 'US' }];
  const r = await ai.matchShipments({ rows, candidates });
  assert.equal(seen.length - before, 3);
  assert.equal(r.meta.calls, 3);
  const firstChunk = seen[before].body.messages[1].content;
  assert.match(firstChunk, /"pledge_id":"a"/);
  assert.doesNotMatch(firstChunk, /"pledge_id":"b"/);
});

test('.env rules: which AI is used, and what a half-filled setup does', () => {
  const base = { QUORUM_ENV_FILE: '/nonexistent' };
  assert.equal(resolveConfig(base).aiMode, 'mock');
  const full = { ...base, AZURE_OPENAI_ENDPOINT: 'https://r.openai.azure.com/', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_DEPLOYMENT: 'd' };
  const c = resolveConfig(full);
  assert.deepEqual([c.aiMode, c.azure.baseUrl, c.azure.deployment, c.modelLabel], ['azure-openai', 'https://r.openai.azure.com/openai/v1/', 'd', 'd']);
  assert.equal(resolveConfig({ ...full, AZURE_OPENAI_MODEL: 'gpt-x' }).modelLabel, 'gpt-x');
  assert.equal(resolveConfig({ ...full, AI_PROVIDER: 'mock' }).aiMode, 'mock');
  assert.throws(() => resolveConfig({ ...base, AZURE_OPENAI_API_KEY: 'k' }), /AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT/);
  assert.throws(() => resolveConfig({ ...base, AI_PROVIDER: 'azure-openai' }), /AZURE_OPENAI_API_KEY/);
  assert.throws(() => resolveConfig({ ...base, AI_PROVIDER: 'claude' }), /AI_PROVIDER/);
});

test('the endpoint can be pasted as the resource URL, the v1 URL or a full request URL', () => {
  for (const raw of [
    'https://r.openai.azure.com',
    'https://r.openai.azure.com/',
    'https://r.openai.azure.com/openai',
    'https://r.openai.azure.com/openai/v1',
    'https://r.openai.azure.com/openai/v1/',
    ' https://r.openai.azure.com/openai/v1/chat/completions ',
  ]) assert.equal(azureBaseUrl(raw), 'https://r.openai.azure.com/openai/v1/', raw);
  assert.throws(() => azureBaseUrl('http://r.openai.azure.com/openai/v1/'), /https/);
  assert.throws(() => azureBaseUrl('r.openai.azure.com'), /not a URL/);
});
