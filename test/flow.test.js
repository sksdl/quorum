// End-to-end against the local MOCK PayPal: seed, pledge, close, settle, ship.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-test-'));
const env = { QUORUM_ENV_FILE: '/nonexistent', PAYPAL_MODE: 'mock', AI_PROVIDER: 'mock', PORT: '8799', QUORUM_DATA_DIR: dataDir };
Object.assign(process.env, env);
execFileSync(process.execPath, [path.join(here, '../scripts/seed.js')], { env: { ...process.env, ...env } });

const { createServer, mockPayPal, paypal } = await import('../server/index.js');
const BASE = 'http://127.0.0.1:8799';
const SLUG = 'studio-haneul-night-market';
let server;

async function call(p, body, method) {
  const res = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, data: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(8799, r));
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('seeded campaign has the demo totals', async () => {
  const { data } = await call(`/api/campaigns/${SLUG}`);
  assert.deepEqual(data.campaign.options.map((o) => o.pledged_qty), [63, 27, 212, 41]);
});

let liveOrder;
let livePledge;
test('a fan pledge creates an AUTHORIZE order and a hold', async () => {
  const r = await call(`/api/campaigns/${SLUG}/pledges`, { lines: [{ option_id: 'B', qty: 1 }, { option_id: 'D', qty: 1 }], region_id: 'europe_other', locale: 'de-DE' });
  assert.equal(r.status, 201);
  liveOrder = r.data.order_id;
  livePledge = r.data.pledge_id;
  const early = await call(`/api/campaigns/${SLUG}/pledges/${liveOrder}/authorize`, {}, 'POST');
  assert.equal(early.status, 422, 'authorize before approval fails with PayPal\'s own status');
  assert.equal(early.data.paypal_issue, 'ORDER_NOT_APPROVED');
  await call('/mock-paypal/_approve', { order_id: liveOrder, buyer: 0 });
  const a = await call(`/api/campaigns/${SLUG}/pledges/${liveOrder}/authorize`, {}, 'POST');
  assert.equal(a.data.status, 'held');
  assert.equal(a.data.total, '$38.00');
  const again = await call(`/api/campaigns/${SLUG}/pledges/${liveOrder}/authorize`, {}, 'POST');
  assert.equal(again.data.status, 'held');
});

test('mock PayPal enforces capture and void rules like the real API', async () => {
  const o = mockPayPal.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: '10.00' } }] });
  mockPayPal.approve(o.id, { name: 'Test Buyer', email: 't@example.com', country: 'US', address: { country_code: 'US' } });
  const auth = mockPayPal.authorize(o.id).purchase_units[0].payments.authorizations[0];
  await assert.rejects(paypal.captureAuthorization(auth.id, { cents: 1100 }), (e) => e.issue === 'MAX_CAPTURE_AMOUNT_EXCEEDED');
  await assert.rejects(paypal.reauthorize(auth.id, 1000), (e) => e.issue === 'REAUTHORIZATION_TOO_SOON');
  const c1 = await paypal.captureAuthorization(auth.id, { cents: 600 }, 'same-key');
  const c2 = await paypal.captureAuthorization(auth.id, { cents: 600 }, 'same-key');
  assert.equal(c1.id, c2.id, 'PayPal-Request-Id makes the retry return the first capture');
  await assert.rejects(paypal.voidAuthorization(auth.id), (e) => e.issue === 'PREVIOUSLY_CAPTURED');
  const bad = await fetch(`${BASE}/mock-paypal/v2/checkout/orders`, { method: 'POST', headers: { Authorization: 'Bearer MOCK-x', 'Content-Type': 'application/json' }, body: JSON.stringify({ intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: '9.00', breakdown: { item_total: { currency_code: 'USD', value: '8.00' } } }, items: [{ name: 'x', quantity: '1', unit_amount: { currency_code: 'USD', value: '8.00' } }] }] }) });
  assert.equal((await bad.json()).details[0].issue, 'AMOUNT_MISMATCH');
});

test('settlement cannot run while open, then captures and voids exactly the plan', async () => {
  assert.equal((await call(`/api/studio/${SLUG}/settlement/execute`, { decisions: {} })).status, 409);
  const re = await call(`/api/studio/${SLUG}/reauthorize-due`, {}, 'POST');
  assert.ok(re.data.reauthorized > 50, `reauthorized ${re.data.reauthorized}`);
  assert.equal(re.data.failed.length, 0);
  const { data: after } = await call(`/api/studio/${SLUG}`);
  assert.equal(after.counts.live_past_honor_period, 0, 'every live hold is back inside its honor period');
  await call(`/api/studio/${SLUG}/close`, {}, 'POST');
  const d = await call(`/api/studio/${SLUG}/settlement/draft`, {}, 'POST');
  assert.equal(d.status, 200);
  assert.deepEqual(d.data.decisions.B, { action: 'produce', order_qty: 30 }, 'B is 2 short but cheap to finish');
  assert.deepEqual(d.data.decisions.C, { action: 'produce', order_qty: 300 }, '300 stickers cost less than 212');
  assert.equal(d.data.decisions.D.action, 'cancel');
  assert.ok(d.data.preview.guard.ok);
  const plan = d.data.preview.plan.totals;
  // Someone voids one hold on the PayPal side after the plan was made: pre-flight must catch it.
  const victim = d.data.preview.plan.rows.find((r) => r.action === 'capture_full' && r.pledge_id !== livePledge);
  const { data: studio } = await call(`/api/studio/${SLUG}`);
  const victimPaypal = studio.pledges.find((p) => p.id === victim.pledge_id).paypal;
  mockPayPal.void(victimPaypal.previous_authorization_ids?.[0] || victimPaypal.authorization_id);
  const before = mockPayPal.ledger();
  const s = await call(`/api/studio/${SLUG}/settlement/execute`, { decisions: d.data.decisions });
  assert.equal(s.status, 200);
  assert.equal(s.data.results.filter((r) => r.status === 'failed').length, 0);
  const skipped = s.data.results.filter((r) => r.status === 'skipped');
  assert.deepEqual(skipped.map((r) => r.pledge_id), [victim.pledge_id]);
  assert.equal(s.data.preflight.checked, plan.pledges);
  const L = mockPayPal.ledger();
  assert.equal(Math.round(Number(L.captured_usd) * 100) - Math.round(Number(before.captured_usd) * 100), plan.capture_cents - victim.capture_cents);
  assert.equal(L.authorizations.voided, plan.void + 1);
  assert.equal(L.authorizations.created, 0, 'no hold left open');
  const live = s.data.results.find((r) => r.pledge_id === livePledge);
  assert.equal(live.action, 'capture_partial');
  assert.equal(live.capture_cents, 1600 + 800, 'stand + Europe shipping; the pin is released');
  assert.equal(live.release_cents, 1400);
  assert.equal((await call(`/api/studio/${SLUG}/settlement/execute`, { decisions: d.data.decisions })).status, 409);
});

test('captured pledges carry a note in the fan language and no number written by the model', async () => {
  const { data } = await call(`/api/studio/${SLUG}/settlement`);
  const de = data.samples.find((x) => x.pledge_id === livePledge);
  assert.equal(de.language, 'de');
  assert.match(de.note_to_payer, /^Vorbestellung bei Studio Haneul/);
  assert.match(de.note_to_payer, /US\$24\.00/);
  assert.ok(data.samples.every((x) => !x.note_to_payer || x.note_to_payer.length <= 255));
});

test('tracking upload attaches numbers to captures', async () => {
  const csv = (await call(`/api/studio/${SLUG}/shipping/demo-export`)).data;
  const m = await call(`/api/studio/${SLUG}/shipping/match`, { csv_text: csv });
  const matched = m.data.matches.filter((x) => x.pledge_id);
  assert.ok(matched.length / m.data.matches.length > 0.9, `matched ${matched.length}/${m.data.matches.length}`);
  const up = await call(`/api/studio/${SLUG}/shipping/upload`, { matches: matched });
  assert.equal(up.data.results.filter((r) => r.status === 'uploaded').length, matched.length);
});

test('fans get a pledge page and the creator gets a CSV of messages', async () => {
  const pg = await call(`/api/campaigns/${SLUG}/pledge/${livePledge}`);
  assert.equal(pg.data.pledge.status, 'partially_captured');
  assert.equal(pg.data.pledge.settlement.capture_cents, 2400);
  assert.deepEqual(pg.data.pledge.lines.map((l) => l.decision), ['produce', 'cancel']);
  const csv = (await call(`/api/studio/${SLUG}/messages.csv`)).data;
  assert.match(csv, /hannah\.becker@example\.com/);
  assert.ok(csv.split('\n').length > 100);
});

test('pre-flight reads retry a dropped connection or a 5xx, but not a 404', async () => {
  const { withRetry } = await import('../server/settle.js');
  let n = 0;
  const flaky = async () => {
    n++;
    if (n < 3) throw Object.assign(new Error('PayPal GET failed (503)'), { status: 503 });
    return { status: 'CREATED' };
  };
  assert.deepEqual(await withRetry(flaky, [1, 1]), { status: 'CREATED' });
  assert.equal(n, 3);
  let m = 0;
  await assert.rejects(withRetry(async () => { m++; throw Object.assign(new Error('not found'), { status: 404 }); }, [1, 1]), /not found/);
  assert.equal(m, 1);
  let k = 0;
  await assert.rejects(withRetry(async () => { k++; throw new TypeError('fetch failed'); }, [1, 1]), /fetch failed/);
  assert.equal(k, 3);
});

test('a reauthorized hold is voided through the original authorization, as in the sandbox', async () => {
  const o = mockPayPal.createOrder({ intent: 'AUTHORIZE', purchase_units: [{ amount: { currency_code: 'USD', value: '22.00' } }] });
  mockPayPal.approve(o.id, { name: 'Test Buyer', email: 't@example.com', country: 'DE', address: { country_code: 'DE' } });
  const orig = mockPayPal.authorize(o.id).purchase_units[0].payments.authorizations[0];
  const fresh = mockPayPal.reauthorize(orig.id, {}, new Date(Date.now() + 4 * 86400000));
  await assert.rejects(paypal.voidAuthorization(fresh.id), (e) => e.issue === 'CANNOT_BE_VOIDED');
  await paypal.voidAuthorization(orig.id);
  assert.equal((await paypal.getAuthorization(fresh.id)).status, 'VOIDED');
});
