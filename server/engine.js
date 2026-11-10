// Pricing, production economics and the settlement plan.
// Everything here is plain arithmetic so it can be tested and audited.
// The language model never produces a number that ends up in a PayPal call.
import { toCents } from './money.js';

export const MAX_QTY_PER_LINE = 20;
const COUNTED = new Set(['held', 'captured', 'partially_captured', 'voided', 'capture_failed']);

export function optionById(campaign, id) {
  const o = campaign.options.find((x) => x.id === id);
  if (!o) throw new Error(`Unknown option "${id}"`);
  return o;
}

export function regionForCountry(campaign, country) {
  const cc = String(country || '').toUpperCase();
  return (
    campaign.shipping_regions.find((r) => (r.countries || []).includes(cc)) ||
    campaign.shipping_regions.find((r) => (r.countries || []).length === 0) ||
    null
  );
}

// Server-side cart pricing. The browser only sends option ids and quantities.
export function priceCart(campaign, lines, regionId) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('Pick at least one item');
  const seen = new Set();
  const items = [];
  for (const line of lines) {
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_LINE) throw new Error(`Quantity must be 1-${MAX_QTY_PER_LINE}`);
    if (seen.has(line.option_id)) throw new Error('Duplicate item line');
    seen.add(line.option_id);
    const opt = optionById(campaign, line.option_id);
    items.push({ option_id: opt.id, name: opt.name_en, qty, unit_cents: toCents(opt.price_usd) });
  }
  const region = campaign.shipping_regions.find((r) => r.id === regionId);
  if (!region) throw new Error('Pick a shipping region');
  const item_cents = items.reduce((s, i) => s + i.unit_cents * i.qty, 0);
  const shipping_cents = toCents(region.price_usd);
  return { items, region_id: region.id, item_cents, shipping_cents, total_cents: item_cents + shipping_cents };
}

export function optionTotals(campaign, pledges) {
  const totals = Object.fromEntries(campaign.options.map((o) => [o.id, { qty: 0, pledges: 0, held_cents: 0 }]));
  for (const p of pledges) {
    if (!COUNTED.has(p.status)) continue;
    for (const l of p.lines) {
      const t = totals[l.option_id];
      if (!t) continue;
      t.qty += l.qty;
      t.pledges += 1;
      t.held_cents += l.unit_cents * l.qty;
    }
  }
  return totals;
}

export function sortedTiers(option) {
  return [...option.tiers].sort((a, b) => a.min_qty - b.min_qty);
}

export function moqOf(option) {
  return sortedTiers(option)[0].min_qty;
}

// Factory cost for producing orderQty units, VAT added if the quote excludes it.
export function productionCost(option, orderQty, vatRate = 0) {
  const tiers = sortedTiers(option);
  let tier = null;
  for (const t of tiers) if (orderQty >= t.min_qty) tier = t;
  if (!tier) throw new Error(`${option.id}: ${orderQty} is below the factory minimum of ${tiers[0].min_qty}`);
  const fixed = option.fixed_cost_krw || 0;
  const beforeVat = tier.unit_cost_krw * orderQty + fixed;
  return {
    tier_min_qty: tier.min_qty,
    unit_cost_krw: tier.unit_cost_krw,
    fixed_cost_krw: fixed,
    cost_krw: Math.round(beforeVat * (1 + vatRate)),
  };
}

// Numbers the creator (and the AI) look at before deciding go / no-go per option.
export function optionEconomics(campaign, option, pledgedQty) {
  const { fx_krw_per_usd: fx, vat_rate: vat = 0, fee_rate: fee = 0 } = campaign.cost_basis;
  const moq = moqOf(option);
  const price_cents = toCents(option.price_usd);
  const revenue_cents = price_cents * pledgedQty;
  const fee_cents = Math.round(revenue_cents * fee);
  const net_krw = Math.round(((revenue_cents - fee_cents) / 100) * fx);
  const scenario = (key, orderQty) => {
    const c = productionCost(option, orderQty, vat);
    return {
      key,
      order_qty: orderQty,
      ...c,
      leftover_units: orderQty - pledgedQty,
      profit_krw: net_krw - c.cost_krw,
    };
  };
  const scenarios = [];
  if (pledgedQty > 0) {
    const base = scenario('as_pledged', Math.max(pledgedQty, moq));
    scenarios.push(base);
    for (const t of sortedTiers(option)) {
      if (t.min_qty > base.order_qty) scenarios.push(scenario(`tier_${t.min_qty}`, t.min_qty));
    }
  }
  const base = scenarios[0] || null;
  const cheaperBigger = base ? scenarios.find((s) => s.order_qty > base.order_qty && s.cost_krw <= base.cost_krw) || null : null;
  return {
    option_id: option.id,
    name_en: option.name_en,
    moq,
    pledged_qty: pledgedQty,
    shortfall: Math.max(0, moq - pledgedQty),
    status: pledgedQty === 0 ? 'none' : pledgedQty >= moq ? 'met' : 'short',
    price_cents,
    revenue_cents,
    fee_cents,
    net_krw,
    scenarios,
    cheaper_bigger_order: cheaperBigger,
  };
}

export function campaignEconomics(campaign, pledges) {
  const totals = optionTotals(campaign, pledges.filter((p) => p.status === 'held'));
  return campaign.options.map((o) => optionEconomics(campaign, o, totals[o.id].qty));
}

// Rule-based starting point. The AI recommendation and the creator can change it.
export function defaultDecisions(economics) {
  const d = {};
  for (const e of economics) {
    if (e.pledged_qty === 0) continue;
    d[e.option_id] = e.status === 'met'
      ? { action: 'produce', order_qty: e.scenarios[0].order_qty }
      : { action: 'cancel', order_qty: 0 };
  }
  return d;
}

export function normalizeDecisions(campaign, economics, raw) {
  const out = {};
  for (const e of economics) {
    if (e.pledged_qty === 0) continue;
    const r = raw?.[e.option_id];
    if (!r || !['produce', 'cancel'].includes(r.action)) throw new Error(`Missing decision for option ${e.option_id}`);
    if (r.action === 'cancel') {
      out[e.option_id] = { action: 'cancel', order_qty: 0 };
      continue;
    }
    const minQty = Math.max(e.pledged_qty, e.moq);
    const q = r.order_qty == null ? minQty : Number(r.order_qty);
    if (!Number.isInteger(q) || q < minQty) throw new Error(`Option ${e.option_id}: order quantity must be at least ${minQty}`);
    out[e.option_id] = { action: 'produce', order_qty: q };
  }
  return out;
}

function pledgeAuthorizedCents(p) {
  return p.simulated ? p.total_cents : p.paypal?.authorized_cents;
}

// One row per held pledge: capture the confirmed items (+ shipping once), release the rest.
export function planSettlement(campaign, pledges, decisions) {
  const rows = [];
  for (const p of pledges) {
    if (p.status !== 'held') continue;
    const confirmed = p.lines.filter((l) => decisions[l.option_id]?.action === 'produce');
    const cancelled = p.lines.filter((l) => decisions[l.option_id]?.action !== 'produce');
    const item_cents = confirmed.reduce((s, l) => s + l.unit_cents * l.qty, 0);
    const shipping_cents = confirmed.length ? p.shipping_cents : 0;
    const capture_cents = item_cents + shipping_cents;
    const authorized_cents = pledgeAuthorizedCents(p);
    const action = capture_cents === 0 ? 'void' : capture_cents === authorized_cents ? 'capture_full' : 'capture_partial';
    rows.push({
      pledge_id: p.id,
      simulated: Boolean(p.simulated),
      buyer: p.buyer,
      action,
      confirmed: confirmed.map((l) => ({ option_id: l.option_id, qty: l.qty })),
      cancelled: cancelled.map((l) => ({ option_id: l.option_id, qty: l.qty })),
      authorized_cents,
      capture_cents,
      release_cents: authorized_cents - capture_cents,
    });
  }
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const count = (a) => rows.filter((r) => r.action === a).length;
  const production = Object.entries(decisions)
    .filter(([, d]) => d.action === 'produce')
    .map(([id, d]) => {
      const opt = optionById(campaign, id);
      const pledged = rows.reduce((s, r) => s + (r.confirmed.find((c) => c.option_id === id)?.qty || 0), 0);
      return { option_id: id, name_en: opt.name_en, pledged_qty: pledged, order_qty: d.order_qty, leftover_units: d.order_qty - pledged, ...productionCost(opt, d.order_qty, campaign.cost_basis.vat_rate || 0) };
    });
  return {
    rows,
    production,
    totals: {
      pledges: rows.length,
      capture_full: count('capture_full'),
      capture_partial: count('capture_partial'),
      void: count('void'),
      authorized_cents: sum('authorized_cents'),
      capture_cents: sum('capture_cents'),
      release_cents: sum('release_cents'),
      live_pledges: rows.filter((r) => !r.simulated).length,
    },
  };
}

// Independent checks run right before any money moves. If one fails, nothing is sent to PayPal.
export function guardPlan(campaign, pledges, decisions, plan) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
  const held = pledges.filter((p) => p.status === 'held');
  const byId = new Map(held.map((p) => [p.id, p]));

  const pledgedOptions = new Set(held.flatMap((p) => p.lines.map((l) => l.option_id)));
  const missing = [...pledgedOptions].filter((id) => !decisions[id]);
  add('Every pledged option has a decision', missing.length === 0, missing.join(', '));

  const ids = plan.rows.map((r) => r.pledge_id);
  add('One plan row per held pledge', ids.length === held.length && new Set(ids).size === ids.length && ids.every((id) => byId.has(id)), `${ids.length} rows / ${held.length} held`);

  const badRange = plan.rows.filter((r) => r.capture_cents < 0 || r.capture_cents > r.authorized_cents);
  add('No capture exceeds its authorization', badRange.length === 0, badRange.map((r) => r.pledge_id).join(', '));

  // Recompute every capture from campaign prices, not from the stored pledge lines.
  const priceOf = Object.fromEntries(campaign.options.map((o) => [o.id, toCents(o.price_usd)]));
  const shipOf = Object.fromEntries(campaign.shipping_regions.map((r) => [r.id, toCents(r.price_usd)]));
  const mismatch = plan.rows.filter((r) => {
    const p = byId.get(r.pledge_id);
    const items = r.confirmed.reduce((s, c) => s + priceOf[c.option_id] * c.qty, 0);
    const expect = items + (r.confirmed.length ? shipOf[p.region_id] : 0);
    return expect !== r.capture_cents;
  });
  add('Capture amounts match campaign prices', mismatch.length === 0, mismatch.map((r) => r.pledge_id).join(', '));

  const authMismatch = held.filter((p) => !p.simulated && p.paypal?.authorized_cents !== p.total_cents);
  add('PayPal authorized amounts match priced carts', authMismatch.length === 0, authMismatch.map((p) => p.id).join(', '));

  const notUsd = held.filter((p) => !p.simulated && p.paypal?.currency !== 'USD');
  add('All authorizations are USD', notUsd.length === 0, notUsd.map((p) => p.id).join(', '));

  // Rebuild what each fan gets back from their own lines and campaign prices, then check
  // that charged + released adds up to the hold PayPal actually placed.
  const releaseMismatch = plan.rows.filter((r) => {
    const p = byId.get(r.pledge_id);
    const cancelled = p.lines.filter((l) => decisions[l.option_id]?.action !== 'produce');
    const expectRelease = cancelled.reduce((s, l) => s + priceOf[l.option_id] * l.qty, 0) + (cancelled.length === p.lines.length ? shipOf[p.region_id] : 0);
    return expectRelease !== r.release_cents || r.capture_cents + expectRelease !== r.authorized_cents;
  });
  add('Each hold = charged part + released part, at campaign prices', releaseMismatch.length === 0, releaseMismatch.map((r) => r.pledge_id).join(', '));

  // Compare units charged per item with the decisions and with what fans pledged.
  const charged = {};
  for (const r of plan.rows) for (const c of r.confirmed) charged[c.option_id] = (charged[c.option_id] || 0) + c.qty;
  const pledged = {};
  for (const p of held) for (const l of p.lines) pledged[l.option_id] = (pledged[l.option_id] || 0) + l.qty;
  const unitProblems = [];
  for (const [id, q] of Object.entries(charged)) {
    if (decisions[id]?.action !== 'produce') unitProblems.push(`${id}: ${q} charged but cancelled`);
    else if (decisions[id].order_qty < q) unitProblems.push(`${id}: ${q} charged, factory order ${decisions[id].order_qty}`);
  }
  for (const [id, d] of Object.entries(decisions)) {
    if (d.action === 'produce' && (charged[id] || 0) !== (pledged[id] || 0)) unitProblems.push(`${id}: ${charged[id] || 0} charged of ${pledged[id] || 0} pledged`);
  }
  add('Every unit charged is in the factory order, and every pledge for a made item is charged', unitProblems.length === 0, unitProblems.join('; '));

  return { ok: checks.every((c) => c.ok), checks };
}

export function authAge(p, now = Date.now()) {
  if (!p.paypal?.authorized_at && !p.authorized_at) return null;
  const at = Date.parse(p.paypal?.authorized_at || p.authorized_at);
  const days = Math.floor((now - at) / 86400000);
  const expires = p.paypal?.expiration_time ? Date.parse(p.paypal.expiration_time) : at + 29 * 86400000;
  return {
    days,
    in_honor_period: now - at < 3 * 86400000,
    days_to_expiry: Math.ceil((expires - now) / 86400000),
  };
}
