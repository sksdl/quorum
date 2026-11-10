import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.QUORUM_ENV_FILE = '/nonexistent';
process.env.PAYPAL_MODE = 'mock';
process.env.AI_PROVIDER = 'mock';

const { productionCost, optionEconomics, priceCart, planSettlement, guardPlan, normalizeDecisions, campaignEconomics } = await import('../server/engine.js');
const { checkTemplate, checkRecommendation, validateCampaignDraft, checkMatches } = await import('../server/ai.js');
const { toCents } = await import('../server/money.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const draft = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/ai-mock/campaign-draft.json'), 'utf8'));
const campaign = { ...draft, slug: 't', cost_basis: { ...draft.cost_basis, fx_krw_per_usd: 1380, fee_rate: 0.05 } };

function pledge(id, lines, region = 'asia', extra = {}) {
  const cart = priceCart(campaign, Object.entries(lines).map(([option_id, qty]) => ({ option_id, qty })), region);
  return {
    id,
    status: 'held',
    simulated: false,
    buyer: { name: id, locale: 'en' },
    lines: cart.items.map(({ option_id, qty, unit_cents }) => ({ option_id, qty, unit_cents })),
    region_id: region,
    item_cents: cart.item_cents,
    shipping_cents: cart.shipping_cents,
    total_cents: cart.total_cents,
    paypal: { authorized_cents: cart.total_cents, currency: 'USD', authorization_id: `AUTH${id}` },
    ...extra,
  };
}

test('money parsing is exact', () => {
  assert.equal(toCents('9.00'), 900);
  assert.equal(toCents('16.5'), 1650);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.throws(() => toCents('9.999'));
});

test('factory cost uses the right price break, VAT and one-time fees', () => {
  const [A, , C, D] = campaign.options;
  assert.equal(productionCost(A, 63, 0.1).cost_krw, Math.round(63 * 3800 * 1.1));
  assert.equal(productionCost(A, 100, 0).unit_cost_krw, 2900);
  assert.equal(productionCost(C, 300, 0).cost_krw, 210000);
  assert.equal(productionCost(D, 100, 0).cost_krw, 100 * 5200 + 180000);
  assert.throws(() => productionCost(A, 49, 0), /below the factory minimum/);
});

test('economics finds a bigger order that costs less', () => {
  const C = campaign.options[2];
  const e = optionEconomics(campaign, C, 212);
  assert.equal(e.status, 'met');
  assert.equal(e.cheaper_bigger_order.order_qty, 300);
  assert.ok(e.cheaper_bigger_order.cost_krw < e.scenarios[0].cost_krw);
  const B = optionEconomics(campaign, campaign.options[1], 27);
  assert.equal(B.status, 'short');
  assert.equal(B.shortfall, 3);
  assert.equal(B.scenarios[0].order_qty, 30);
  assert.equal(B.scenarios[0].leftover_units, 3);
});

test('cart pricing rejects bad input', () => {
  assert.throws(() => priceCart(campaign, [], 'asia'));
  assert.throws(() => priceCart(campaign, [{ option_id: 'A', qty: 0 }], 'asia'));
  assert.throws(() => priceCart(campaign, [{ option_id: 'A', qty: 1.5 }], 'asia'));
  assert.throws(() => priceCart(campaign, [{ option_id: 'A', qty: 1 }, { option_id: 'A', qty: 1 }], 'asia'));
  assert.throws(() => priceCart(campaign, [{ option_id: 'A', qty: 1 }], 'mars'));
  const c = priceCart(campaign, [{ option_id: 'A', qty: 2 }, { option_id: 'D', qty: 1 }], 'europe_other');
  assert.equal(c.total_cents, 2 * 900 + 1400 + 800);
});

test('settlement plan: full capture, partial capture with shipping once, void', () => {
  const pledges = [pledge('p1', { A: 1, C: 2 }), pledge('p2', { A: 1, D: 1 }, 'americas_oceania'), pledge('p3', { D: 2 })];
  const decisions = { A: { action: 'produce', order_qty: 50 }, C: { action: 'produce', order_qty: 100 }, D: { action: 'cancel', order_qty: 0 } };
  const plan = planSettlement(campaign, pledges, decisions);
  const [r1, r2, r3] = plan.rows;
  assert.equal(r1.action, 'capture_full');
  assert.equal(r1.capture_cents, 900 + 1000 + 500);
  assert.equal(r2.action, 'capture_partial');
  assert.equal(r2.capture_cents, 900 + 700);
  assert.equal(r2.release_cents, 1400);
  assert.equal(r3.action, 'void');
  assert.equal(r3.release_cents, 2800 + 500);
  assert.equal(plan.totals.capture_cents + plan.totals.release_cents, plan.totals.authorized_cents);
  assert.ok(guardPlan(campaign, pledges, decisions, plan).ok);
});

test('guard stops a capture that does not match campaign prices or exceeds the hold', () => {
  const p = pledge('p1', { A: 2 });
  p.lines[0].unit_cents = 1200; // stored line tampered with
  const decisions = { A: { action: 'produce', order_qty: 50 } };
  const plan = planSettlement(campaign, [p], decisions);
  const g = guardPlan(campaign, [p], decisions, plan);
  assert.equal(g.ok, false);
  assert.ok(g.checks.find((c) => c.name.startsWith('Capture amounts match')).ok === false);
  assert.ok(g.checks.find((c) => c.name.startsWith('No capture exceeds')).ok === false);
});

test('guard flags a PayPal authorization that differs from the priced cart', () => {
  const p = pledge('p1', { A: 1 });
  p.paypal.authorized_cents = 100;
  const decisions = { A: { action: 'produce', order_qty: 50 } };
  const plan = planSettlement(campaign, [p], decisions);
  assert.equal(guardPlan(campaign, [p], decisions, plan).ok, false);
});

test('decisions cannot order fewer units than pledged or skip an option', () => {
  const pledges = [pledge('p1', { A: 3, B: 1 })];
  const econ = campaignEconomics(campaign, pledges);
  assert.throws(() => normalizeDecisions(campaign, econ, { A: { action: 'produce', order_qty: 2 } }), /Missing decision for option B|at least/);
  assert.throws(() => normalizeDecisions(campaign, econ, { A: { action: 'produce', order_qty: 10 }, B: { action: 'cancel' } }), /at least 50/);
});

test('AI recommendation may only pick computed quantities', () => {
  const econ = [optionEconomics(campaign, campaign.options[2], 212)];
  const bad = checkRecommendation(econ, { options: [{ option_id: 'C', action: 'produce', order_qty: 250, headline: '', reasoning: '' }] });
  assert.equal(Object.keys(bad.decisions).length, 0);
  assert.match(bad.problems[0], /not one of the computed scenarios/);
  const good = checkRecommendation(econ, { options: [{ option_id: 'C', action: 'produce', order_qty: 300, headline: 'h', reasoning: 'r' }] });
  assert.equal(good.decisions.C.order_qty, 300);
});

test('note templates must use placeholders and never write an amount', () => {
  const ok = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/ai-mock/note-templates.json'), 'utf8')).templates;
  for (const t of ok) assert.deepEqual(checkTemplate(t), [], t.language);
  const bad = { ...ok[0], note_capture_partial: 'Charged $24.00 for {confirmed_items}. Released {released}. {cancelled_items}' };
  assert.ok(checkTemplate(bad).some((p) => /missing \{captured\}/.test(p)));
  assert.ok(checkTemplate(bad).some((p) => /written amount/.test(p)));
  const yen = { ...ok[1], message_void: '{cancelled_items} {released} 3300円' };
  assert.ok(checkTemplate(yen).some((p) => /written amount/.test(p)));
});

test('campaign draft validation catches unusable AI output', () => {
  assert.deepEqual(validateCampaignDraft(structuredClone(draft)), []);
  const d = structuredClone(draft);
  d.options[0].price_usd = '$9';
  d.duration_days = 45;
  d.shipping_regions[2].countries = ['FR'];
  const errs = validateCampaignDraft(d);
  assert.ok(errs.some((e) => /price_usd/.test(e)));
  assert.ok(errs.some((e) => /29 days/.test(e)));
  assert.ok(errs.some((e) => /catch-all/.test(e)));
});

test('shipment matches are checked for country and duplicates', () => {
  const rows = [{ row: 1, country: 'JP' }, { row: 2, country: 'JP' }, { row: 3, country: 'US' }];
  const cands = [{ pledge_id: 'a', country: 'JP' }, { pledge_id: 'b', country: 'DE' }];
  const out = checkMatches(rows, cands, { matches: [{ row: 1, pledge_id: 'a', confidence: 'high', reason: '' }, { row: 2, pledge_id: 'a', confidence: 'high', reason: '' }, { row: 3, pledge_id: 'b', confidence: 'high', reason: '' }] });
  assert.equal(out[0].pledge_id, 'a');
  assert.equal(out[1].pledge_id, null);
  assert.equal(out[2].pledge_id, null);
});

test('a fan answer may only quote amounts the campaign has', async () => {
  const { checkFanAnswer, fanAnswerAmounts } = await import('../server/ai.js');
  const c = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/ai-mock/campaign-draft.json'), 'utf8'));
  assert.deepEqual(fanAnswerAmounts('キーホルダー代9米ドル、バッジ代14米ドル'), [900, 1400]);
  assert.deepEqual(fanAnswerAmounts('Total ＄３１.00 (US$9 + $14 + 8 dollars)'), [3100, 900, 1400, 800]);
  assert.equal(checkFanAnswer(c, 'キーホルダー代9米ドル、バッジ代14米ドル、送料8ドル').ok, true);
  assert.equal(checkFanAnswer(c, 'A keyring and a pin shipped to Europe is $31.00.').ok, true, '9 + 14 + 8');
  assert.deepEqual(checkFanAnswer(c, 'The pin is on sale for $6.50 this week.').unknown, ['6.50']);
  assert.equal(checkFanAnswer(c, 'Pre-orders close on November 12; 41 pledged so far.').ok, true, 'numbers that are not money are left alone');
  assert.deepEqual(fanAnswerAmounts('14 US-Dollar, 14,00 $, USD 99, 99달러'), [1400, 1400, 9900, 9900]);
  const { cartAmounts } = await import('../server/ai.js');
  const many = { options: Array.from({ length: 14 }, (_, i) => ({ price_usd: `${(i + 3) * 1.5}` })), shipping_regions: [{ price_usd: '5.00' }] };
  const t = Date.now();
  cartAmounts(many);
  assert.ok(Date.now() - t < 500, 'stays fast with many items');
});

test('a model-written shipping list never offers countries PayPal does not serve', () => {
  const c = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/ai-mock/campaign-draft.json'), 'utf8'));
  c.shipping_regions[0].countries.push('KP', 'IR', 'sy', 'CU');
  assert.deepEqual(validateCampaignDraft(c), []);
  assert.ok(!c.shipping_regions[0].countries.some((x) => ['KP', 'IR', 'SY', 'CU'].includes(x)));
});

test('a pledge whose PayPal order has no shipping address stays out of shipment matching without breaking it', async () => {
  const { candidatesFor, demoExport } = await import('../server/ship.js');
  const base = { status: 'captured', settlement: { confirmed: [{ option_id: 'A', qty: 1 }] } };
  const pledges = [
    { ...base, id: 'p1', buyer: { name: 'John Doe', country: null }, paypal: { shipping: null } },
    { ...base, id: 'p2', buyer: { name: 'John Doe', country: 'DE' }, paypal: { shipping: { name: 'John Doe', address: { country_code: 'DE', postal_code: '10715', admin_area_2: 'Berlin' } } } },
  ];
  const c = candidatesFor(pledges);
  assert.equal(c[0].country, '');
  assert.equal(c[1].country, 'DE');
  const campaign = { options: [{ id: 'A', name_en: 'Keyring' }] };
  assert.equal(demoExport(campaign, pledges).split('\n').length, 3);
});

test('the shipping list is read with English or Korean (Korea Post) column names', async () => {
  const { readExport } = await import('../server/ship.js');
  const en = readExport('Tracking number,Recipient,Country code,Postal code\nLK1KR,Yuki Tanaka,jp,530-0001');
  const ko = readExport('등기번호,수취인명,국가코드,우편번호\nLK1KR,田中 由紀,JP,5300001');
  assert.deepEqual([en[0].tracking_number, en[0].country, en[0].postal_code], ['LK1KR', 'JP', '530-0001']);
  assert.deepEqual([ko[0].tracking_number, ko[0].recipient, ko[0].country], ['LK1KR', '田中 由紀', 'JP']);
});

test('two parcels for the same fan at the same address are told apart by their contents', async () => {
  const { demoExport, matchExport } = await import('../server/ship.js');
  const ship = { name: 'John Doe', address: { country_code: 'DE', postal_code: '10715', admin_area_2: 'Berlin', address_line_1: 'Badensche Str. 24' } };
  const pledges = [
    { id: 'p1', status: 'captured', buyer: { name: 'John Doe', country: 'DE' }, paypal: { shipping: ship }, settlement: { confirmed: [{ option_id: 'A', qty: 1 }] } },
    { id: 'p2', status: 'partially_captured', buyer: { name: 'John Doe', country: 'DE' }, paypal: { shipping: ship }, settlement: { confirmed: [{ option_id: 'B', qty: 1 }] } },
  ];
  const r = await matchExport({ pledges, csvText: demoExport({ options: [] }, pledges) });
  assert.deepEqual(r.matches.map((m) => m.pledge_id), ['p1', 'p2']);
  assert.deepEqual(r.unmatched_pledges, []);
});

test('the PayPal page opens in the fan language when PayPal supports it', async () => {
  const { paypalLocale, buildOrderBody } = await import('../server/paypal.js');
  assert.equal(paypalLocale('de'), 'de-DE');
  assert.equal(paypalLocale('zh-TW'), 'zh-TW');
  assert.equal(paypalLocale('en-GB'), 'en-US');
  assert.equal(paypalLocale('xx'), null);
  const campaign = { slug: 's', creator_name: 'Studio', options: [{ id: 'A', name_en: 'Keyring' }] };
  const pledge = { id: 'p', buyer: { locale: 'ja' }, total_cents: 1700, item_cents: 900, shipping_cents: 800, lines: [{ option_id: 'A', qty: 1, unit_cents: 900 }] };
  const ctx = (b) => b.payment_source.paypal.experience_context;
  assert.equal(ctx(buildOrderBody({ campaign, pledge, returnUrl: 'r', cancelUrl: 'c' })).locale, 'ja-JP');
  assert.equal('locale' in ctx(buildOrderBody({ campaign, pledge: { ...pledge, buyer: { locale: 'xx' } }, returnUrl: 'r', cancelUrl: 'c' })), false);
});

test('--with-walkthrough seeds the README numbers: 136 pledges, $3,533.00 held', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quorum-walk-'));
  try {
    const env = { ...process.env, QUORUM_ENV_FILE: '/nonexistent', PAYPAL_MODE: 'mock', AI_PROVIDER: 'mock', QUORUM_DATA_DIR: dir, PORT: '8797' };
    const outText = execFileSync(process.execPath, [path.join(here, '../scripts/seed.js'), '--with-walkthrough'], { env }).toString();
    assert.match(outText, /136 pledges, \$3,533\.00 held/);
    assert.match(outText, /Totals: A=64 B=28 C=212 D=43/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
