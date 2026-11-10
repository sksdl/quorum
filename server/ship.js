// Shipping: match a Korea Post bulk export to pledges, then add tracking to each PayPal capture.
// PayPal shows the tracking number to the buyer, and tracking on file helps with
// "item not received" claims under Seller Protection.
import { ai, checkMatches } from './ai.js';

const HEADER_MAP = {
  등기번호: 'tracking_number',
  수취인명: 'recipient',
  국가코드: 'country',
  우편번호: 'postal_code',
  주소: 'address',
  내용품: 'contents',
  '중량(g)': 'weight_g',
  'Tracking number': 'tracking_number',
  Recipient: 'recipient',
  'Country code': 'country',
  'Postal code': 'postal_code',
  Address: 'address',
  Contents: 'contents',
  'Weight (g)': 'weight_g',
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let q = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export function readExport(text) {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new Error('Empty file');
  const keys = header.map((h) => HEADER_MAP[h.trim()] || h.trim());
  for (const need of ['tracking_number', 'recipient', 'country']) {
    if (!keys.includes(need)) throw new Error(`Missing column for ${need} (expected Korea Post export headers)`);
  }
  return body.map((cells, i) => {
    const r = { row: i + 1 };
    keys.forEach((k, j) => (r[k] = (cells[j] || '').trim()));
    r.country = r.country.toUpperCase();
    return r;
  });
}

export function shippable(pledges) {
  return pledges.filter((p) => ['captured', 'partially_captured'].includes(p.status));
}

export function candidatesFor(pledges) {
  return shippable(pledges).map((p) => ({
    pledge_id: p.id,
    name: p.buyer.name,
    shipping_name: p.paypal?.shipping?.name || p.buyer.name,
    // PayPal can return an order without a shipping address (seen in the sandbox); such a pledge stays unmatched.
    country: (p.paypal?.shipping?.address?.country_code || p.buyer.country || '').toUpperCase(),
    postal_code: p.paypal?.shipping?.address?.postal_code || p.buyer.postal_code || '',
    city: p.paypal?.shipping?.address?.admin_area_2 || p.buyer.city || '',
    // What goes in the parcel, written like the export's contents column; it tells apart two pledges of one fan.
    items: (p.settlement?.confirmed || []).map((c) => `${c.option_id}x${c.qty}`).join(' '),
  }));
}

export async function matchExport({ pledges, csvText }) {
  const rows = readExport(csvText);
  const candidates = candidatesFor(pledges);
  const r = await ai.matchShipments({
    rows: rows.map(({ row, recipient, country, postal_code, address, contents }) => ({ row, recipient, country, postal_code, address, contents })),
    candidates,
  });
  const matches = checkMatches(rows, candidates, r.data).map((m) => ({ ...m, ...pick(rows.find((x) => x.row === m.row)) }));
  return { matches, ai: r.meta, unmatched_pledges: candidates.filter((c) => !matches.some((m) => m.pledge_id === c.pledge_id)).map((c) => c.pledge_id) };
}

function pick(r) {
  return { tracking_number: r.tracking_number, recipient: r.recipient, country: r.country, postal_code: r.postal_code };
}

export async function uploadTracking({ store, paypal, campaign, matches }) {
  const results = [];
  for (const m of matches) {
    if (!m.pledge_id || !m.tracking_number) continue;
    const p = store.pledge(m.pledge_id);
    if (!p || p.campaign_slug !== campaign.slug || !['captured', 'partially_captured'].includes(p.status)) {
      results.push({ pledge_id: m.pledge_id, status: 'skipped', reason: 'Not a captured pledge in this campaign' });
      continue;
    }
    const items = (p.settlement?.confirmed || []).map((c) => {
      const o = campaign.options.find((x) => x.id === c.option_id);
      return { name: o.name_en.slice(0, 127), quantity: String(c.qty), sku: `${campaign.slug}-${o.id}` };
    });
    try {
      if (p.simulated) {
        results.push({ pledge_id: p.id, status: 'simulated', tracking_number: m.tracking_number });
      } else {
        await paypal.addTracking(
          p.paypal.order_id,
          { capture_id: p.paypal.capture_id, tracking_number: m.tracking_number, carrier: 'KR_KOREA_POST', notify_payer: true, items },
          `qrm-trk-${p.id}-${m.tracking_number}`,
        );
        results.push({ pledge_id: p.id, status: 'uploaded', tracking_number: m.tracking_number });
      }
      p.tracking = { number: m.tracking_number, carrier: 'KR_KOREA_POST', added_at: new Date().toISOString(), simulated: Boolean(p.simulated) };
      store.putPledge(p);
    } catch (e) {
      results.push({ pledge_id: p.id, status: 'failed', error: e.message });
    }
  }
  store.log(campaign.slug, 'tracking', `Tracking added for ${results.filter((r) => r.status !== 'failed' && r.status !== 'skipped').length} orders`);
  return results;
}

// Demo only: build a Korea Post-style export from this campaign's captured pledges,
// with the kinds of differences a real export has (name order, case, native script, postal format).
export function demoExport(campaign, pledges) {
  const rows = [['Tracking number', 'Recipient', 'Country code', 'Postal code', 'Address', 'Contents', 'Weight (g)']];
  shippable(pledges).forEach((p, i) => {
    const addr = p.paypal?.shipping?.address || {};
    const name = p.paypal?.shipping?.name || p.buyer.name;
    let recipient = name;
    if (p.buyer.native_name && i % 2 === 0) recipient = p.buyer.native_name;
    else if (i % 4 === 1) recipient = name.split(' ').reverse().join(' ').toUpperCase();
    else if (i % 7 === 3) recipient = name.toUpperCase();
    let postal = addr.postal_code || p.buyer.postal_code || '';
    if (i % 5 === 2) postal = postal.replace(/[-\s]/g, '');
    const tracking = `LK${String(482100000 + i * 37).padStart(9, '0')}KR`;
    const contents = (p.settlement?.confirmed || []).map((c) => `${c.option_id}x${c.qty}`).join(' ');
    rows.push([tracking, recipient, addr.country_code || p.buyer.country, postal, `${addr.address_line_1 || ''} ${addr.admin_area_2 || ''}`.trim(), `Acrylic goods ${contents}`, String(60 + i % 5 * 15)]);
  });
  return rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n');
}
