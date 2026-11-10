// The recording plan: place live holds days before the demo, rebuild the seeded data on the day
// with `npm run seed -- --keep-live`, then pledge, reauthorize and settle. Runs against MOCK PayPal,
// with the server in a child process so the seed script and the server never share stale memory.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;
const SLUG = 'studio-haneul-night-market';
const DAY = 86400000;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-keep-live-'));
const env = { ...process.env, QUORUM_ENV_FILE: '/nonexistent', PAYPAL_MODE: 'mock', AI_PROVIDER: 'mock', PORT: String(PORT), QUORUM_DATA_DIR: dataDir };
const seed = (...args) => execFileSync(process.execPath, [path.join(ROOT, 'scripts/seed.js'), ...args], { env, encoding: 'utf8' });

let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], { env, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/status`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
}
async function stopServer() {
  if (!server) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill();
  await done;
  server = null;
}
async function call(p, body, method) {
  const res = await fetch(BASE + p, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json() };
}
async function livePledge(lines) {
  const r = await call(`/api/campaigns/${SLUG}/pledges`, { lines, region_id: 'europe_other', locale: 'de-DE' });
  if (r.status !== 201) return r;
  await call('/mock-paypal/_approve', { order_id: r.data.order_id, buyer: 0 });
  return call(`/api/campaigns/${SLUG}/pledges/${r.data.order_id}/authorize`, {}, 'POST');
}
// Moves a live hold back in time in both data files, as if it had been placed `days` ago.
function backdate(dir, pledgeIds, days) {
  const dbFile = path.join(dir, 'quorum-db.json');
  const ppFile = path.join(dir, 'mock-paypal.json');
  const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const pp = JSON.parse(fs.readFileSync(ppFile, 'utf8'));
  const at = new Date(Date.now() - days * DAY).toISOString();
  const exp = new Date(Date.now() - days * DAY + 29 * DAY).toISOString();
  for (const id of pledgeIds) {
    const p = db.pledges[id];
    p.created_at = at;
    p.paypal.authorized_at = at;
    p.paypal.expiration_time = exp;
    Object.assign(pp.authorizations[p.paypal.authorization_id], { create_time: at, expiration_time: exp });
    pp.orders[p.paypal.order_id].create_time = at;
  }
  fs.writeFileSync(dbFile, JSON.stringify(db));
  fs.writeFileSync(ppFile, JSON.stringify(pp));
}

after(async () => {
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('holds placed days earlier survive a --keep-live reseed, and the demo can be recorded the same day', async () => {
  // Days before the recording: seed and place two live holds (keyring only, pin only).
  seed();
  await startServer();
  const early = [];
  for (const lines of [[{ option_id: 'A', qty: 1 }], [{ option_id: 'D', qty: 1 }]]) {
    const a = await livePledge(lines);
    assert.equal(a.data.status, 'held');
    early.push(a.data.pledge_id);
  }
  await stopServer();
  backdate(dataDir, early, 5);

  // A hold older than the rebuilt campaign window is refused with a clear message.
  const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-keep-live-old-'));
  fs.cpSync(dataDir, oldDir, { recursive: true });
  backdate(oldDir, [early[0]], 9.8);
  const refused = spawnSync(process.execPath, [path.join(ROOT, 'scripts/seed.js'), '--keep-live'], { env: { ...env, QUORUM_DATA_DIR: oldDir }, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /placed more than/);
  fs.rmSync(oldDir, { recursive: true, force: true });

  // Recording day: rebuild the seeded fans around now, keep the two live holds.
  const out = seed('--keep-live');
  assert.match(out, /133 pledges, \$3,456\.00 held/);
  assert.match(out, /Kept 2 live hold\(s\)/);
  await startServer();

  const { data: s0 } = await call(`/api/studio/${SLUG}`);
  assert.equal(s0.campaign.status, 'open');
  assert.equal(s0.counts.held, 135);
  assert.deepEqual(early.map((id) => s0.pledges.find((p) => p.id === id)?.auth_age.in_honor_period), [false, false]);

  // The pledge made on camera goes through (it failed with 409 "This campaign is closed" before --keep-live).
  const onCamera = await livePledge([{ option_id: 'B', qty: 1 }, { option_id: 'D', qty: 1 }]);
  assert.equal(onCamera.data.status, 'held');
  assert.equal(onCamera.data.total, '$38.00');

  // Reauthorize: the two early holds get new authorization ids; the one placed today is not due.
  const before = Object.fromEntries(early.map((id) => [id, s0.pledges.find((p) => p.id === id).paypal.authorization_id]));
  const re = await call(`/api/studio/${SLUG}/reauthorize-due`, {}, 'POST');
  assert.equal(re.data.failed.length, 0);
  assert.equal(re.data.reauthorized, re.data.due);
  const { data: s1 } = await call(`/api/studio/${SLUG}`);
  for (const id of early) assert.notEqual(s1.pledges.find((p) => p.id === id).paypal.authorization_id, before[id]);
  assert.equal(s1.counts.live_past_honor_period, 0);

  // Settle: the same numbers as the submission text.
  await call(`/api/studio/${SLUG}/close`, {}, 'POST');
  const d = await call(`/api/studio/${SLUG}/settlement/draft`, {}, 'POST');
  const r = await call(`/api/studio/${SLUG}/settlement/execute`, { decisions: d.data.decisions });
  assert.equal(r.status, 200);
  const t = r.data.totals;
  assert.deepEqual([t.pledges, t.authorized_cents, t.capture_cents, t.release_cents, t.capture_full, t.capture_partial, t.void], [136, 353300, 284100, 69200, 99, 22, 15]);
  assert.equal(r.data.results.filter((x) => x.status === 'failed' || x.status === 'skipped').length, 0);
  const byId = Object.fromEntries(r.data.results.map((x) => [x.pledge_id, x]));
  assert.deepEqual([byId[early[0]].action, byId[early[1]].action, byId[onCamera.data.pledge_id].action], ['capture_full', 'void', 'capture_partial']);
  const ledger = (await call('/mock-paypal/_ledger')).data;
  assert.equal(ledger.authorizations.created, 0, 'no hold left open');
});
