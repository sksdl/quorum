// MOCK PAYPAL
// A local stand-in for the PayPal REST endpoints Quorum calls, used until real sandbox
// credentials are added to .env. It follows the request/response shapes of Orders v2 and
// Payments v2 closely enough that the same client code runs against both.
// Nothing here talks to PayPal. Every page it serves says MOCK.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HONOR_MS = 3 * 86400000;
const VALID_MS = 29 * 86400000;

export class MockPayPal {
  constructor(file, publicUrl) {
    this.file = file;
    this.publicUrl = publicUrl;
    this.state = { orders: {}, authorizations: {}, captures: {}, idempotency: {} };
    if (fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1));
  }

  reset() {
    this.state = { orders: {}, authorizations: {}, captures: {}, idempotency: {} };
    this.save();
  }

  // Used by `npm run seed -- --keep-live`: drop everything except the given orders and their authorizations.
  resetKeeping(orderIds) {
    const keep = new Set(orderIds);
    const pickBy = (obj, ok) => Object.fromEntries(Object.entries(obj).filter(([, v]) => ok(v)));
    this.state = {
      orders: pickBy(this.state.orders, (o) => keep.has(o.id)),
      authorizations: pickBy(this.state.authorizations, (a) => keep.has(a._order_id)),
      captures: pickBy(this.state.captures, (c) => keep.has(c._order_id)),
      idempotency: {},
    };
    this.save();
  }

  static id() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    return Array.from(crypto.randomBytes(17), (b) => abc[b % abc.length]).join('');
  }

  // ---------- internal operations (also used by the demo seed) ----------

  createOrder(body, at = new Date()) {
    const err = validateOrder(body);
    if (err) throw err;
    const id = MockPayPal.id();
    const o = {
      id,
      intent: body.intent,
      status: 'PAYER_ACTION_REQUIRED',
      create_time: at.toISOString(),
      purchase_units: structuredClone(body.purchase_units),
      _experience: body.payment_source?.paypal?.experience_context || {},
    };
    this.state.orders[id] = o;
    this.save();
    return o;
  }

  approve(orderId, buyer, at = new Date()) {
    const o = this.state.orders[orderId];
    if (!o) throw apiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    if (o.status !== 'PAYER_ACTION_REQUIRED') throw apiError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_APPROVED');
    const [given, ...rest] = buyer.name.split(' ');
    o.status = 'APPROVED';
    o.payer = {
      name: { given_name: given, surname: rest.join(' ') },
      email_address: buyer.email,
      payer_id: buyer.payer_id || MockPayPal.id().slice(0, 13),
      address: { country_code: buyer.country },
    };
    o.payment_source = { paypal: { email_address: buyer.email, account_id: o.payer.payer_id, name: o.payer.name } };
    if (o._experience.shipping_preference !== 'NO_SHIPPING') {
      o.purchase_units[0].shipping = { name: { full_name: buyer.name }, address: buyer.address };
    }
    o.update_time = at.toISOString();
    this.save();
    return o;
  }

  authorize(orderId, at = new Date()) {
    const o = this.state.orders[orderId];
    if (!o) throw apiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    if (o.intent !== 'AUTHORIZE') throw apiError(422, 'UNPROCESSABLE_ENTITY', 'ACTION_DOES_NOT_MATCH_INTENT');
    if (o.status === 'COMPLETED') throw apiError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_AUTHORIZED');
    if (o.status !== 'APPROVED') throw apiError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED');
    const pu = o.purchase_units[0];
    const auth = this.newAuthorization(orderId, pu.amount, pu.custom_id, at);
    pu.payments = { authorizations: [auth.id] };
    o.status = 'COMPLETED';
    o.update_time = at.toISOString();
    this.save();
    return this.orderView(o);
  }

  newAuthorization(orderId, amount, customId, at) {
    const id = MockPayPal.id();
    const auth = {
      id,
      status: 'CREATED',
      amount: { currency_code: amount.currency_code, value: amount.value },
      custom_id: customId,
      seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
      expiration_time: new Date(at.getTime() + VALID_MS).toISOString(),
      create_time: at.toISOString(),
      update_time: at.toISOString(),
      _order_id: orderId,
      _captured_cents: 0,
      _captures: [],
    };
    this.state.authorizations[id] = auth;
    return auth;
  }

  capture(authId, body = {}, at = new Date()) {
    const a = this.state.authorizations[authId];
    if (!a) throw apiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    if (a.status === 'VOIDED') throw apiError(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_VOIDED');
    if (a.status === 'CAPTURED' || a._final) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_ALREADY_CAPTURED');
    if (at.getTime() > Date.parse(a.expiration_time)) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_EXPIRED');
    const authCents = cents(a.amount.value);
    const remaining = authCents - a._captured_cents;
    const want = body.amount ? cents(body.amount.value) : remaining;
    if (body.amount && body.amount.currency_code !== a.amount.currency_code) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'CURRENCY_MISMATCH');
    if (want <= 0) throw apiError(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE');
    if (want > remaining) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'MAX_CAPTURE_AMOUNT_EXCEEDED');
    const finalCapture = body.final_capture !== false;
    const id = MockPayPal.id();
    const cap = {
      id,
      status: 'COMPLETED',
      amount: { currency_code: a.amount.currency_code, value: (want / 100).toFixed(2) },
      final_capture: finalCapture,
      note_to_payer: body.note_to_payer,
      seller_protection: a.seller_protection,
      create_time: at.toISOString(),
      update_time: at.toISOString(),
      links: [
        { href: `${this.publicUrl}/mock-paypal/v2/payments/captures/${id}`, rel: 'self', method: 'GET' },
        { href: `${this.publicUrl}/mock-paypal/v2/payments/authorizations/${authId}`, rel: 'up', method: 'GET' },
      ],
      _authorization_id: authId,
      _order_id: a._order_id,
    };
    this.state.captures[id] = cap;
    a._captured_cents += want;
    a._captures.push(id);
    a._final = finalCapture;
    a.status = a._captured_cents === authCents ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
    a.update_time = at.toISOString();
    this.save();
    return publicView(cap);
  }

  void(authId, at = new Date()) {
    const a = this.state.authorizations[authId];
    if (!a) throw apiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    if (a._captured_cents > 0) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'PREVIOUSLY_CAPTURED');
    if (a.status === 'VOIDED') throw apiError(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_VOIDED');
    // Like the sandbox: a reauthorization cannot be voided by its own ID; voiding the original voids it too.
    if (a._parent) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'CANNOT_BE_VOIDED');
    for (let x = a; x; x = x._superseded_by && this.state.authorizations[x._superseded_by]) {
      x.status = 'VOIDED';
      x.update_time = at.toISOString();
    }
    this.save();
    return this.authView(a);
  }

  reauthorize(authId, body = {}, at = new Date()) {
    const a = this.state.authorizations[authId];
    if (!a) throw apiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    const age = at.getTime() - Date.parse(a.create_time);
    if (age < HONOR_MS) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'REAUTHORIZATION_TOO_SOON');
    if (age > VALID_MS) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_EXPIRED');
    if (a.status !== 'CREATED') throw apiError(422, 'UNPROCESSABLE_ENTITY', 'AUTHORIZATION_ALREADY_CAPTURED');
    const amount = body.amount || a.amount;
    if (amount.currency_code !== a.amount.currency_code) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'AUTH_CURRENCY_MISMATCH');
    const fresh = this.newAuthorization(a._order_id, amount, a.custom_id, at);
    fresh.expiration_time = a.expiration_time; // the 29-day window still runs from the original authorization
    a._superseded_by = fresh.id;
    fresh._parent = authId;
    this.save();
    return this.authView(fresh);
  }

  track(orderId, body, at = new Date()) {
    const o = this.state.orders[orderId];
    if (!o) throw apiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    const cap = this.state.captures[body.capture_id];
    if (!cap || cap._order_id !== orderId) throw apiError(422, 'UNPROCESSABLE_ENTITY', 'CAPTURE_ID_NOT_FOUND');
    if (!body.tracking_number || !body.carrier) throw apiError(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER');
    const pu = o.purchase_units[0];
    pu.shipping = pu.shipping || {};
    pu.shipping.trackers = pu.shipping.trackers || [];
    pu.shipping.trackers.push({
      id: `${body.capture_id}-${body.tracking_number}`,
      status: 'SHIPPED',
      items: body.items || [],
      carrier: body.carrier,
      tracking_number: body.tracking_number,
      notify_payer: Boolean(body.notify_payer),
      create_time: at.toISOString(),
    });
    o.update_time = at.toISOString();
    this.save();
    return this.orderView(o);
  }

  // ---------- views ----------

  authView(a) {
    return {
      ...publicView(a),
      links: [
        { href: `${this.publicUrl}/mock-paypal/v2/payments/authorizations/${a.id}`, rel: 'self', method: 'GET' },
        { href: `${this.publicUrl}/mock-paypal/v2/payments/authorizations/${a.id}/capture`, rel: 'capture', method: 'POST' },
        { href: `${this.publicUrl}/mock-paypal/v2/payments/authorizations/${a.id}/void`, rel: 'void', method: 'POST' },
        { href: `${this.publicUrl}/mock-paypal/v2/payments/authorizations/${a.id}/reauthorize`, rel: 'reauthorize', method: 'POST' },
        { href: `${this.publicUrl}/mock-paypal/v2/checkout/orders/${a._order_id}`, rel: 'up', method: 'GET' },
      ],
    };
  }

  orderView(o) {
    const out = publicView(o);
    out.purchase_units = o.purchase_units.map((pu) => {
      const p = structuredClone(pu);
      if (pu.payments) {
        p.payments = {
          authorizations: (pu.payments.authorizations || []).map((id) => this.authView(this.state.authorizations[id])),
          captures: (pu.payments.authorizations || [])
            .flatMap((id) => this.state.authorizations[id]._captures)
            .map((cid) => publicView(this.state.captures[cid])),
        };
      }
      return p;
    });
    out.links = [
      { href: `${this.publicUrl}/mock-paypal/v2/checkout/orders/${o.id}`, rel: 'self', method: 'GET' },
      ...(o.status === 'PAYER_ACTION_REQUIRED'
        ? [{ href: `${this.publicUrl}/mock-paypal/checkoutnow?token=${o.id}`, rel: 'payer-action', method: 'GET' }]
        : []),
    ];
    return out;
  }

  ledger() {
    const auths = Object.values(this.state.authorizations).filter((a) => !a._superseded_by);
    const caps = Object.values(this.state.captures);
    const sum = (arr) => arr.reduce((s, x) => s + cents(x.amount.value), 0);
    return {
      orders: Object.keys(this.state.orders).length,
      authorizations: {
        created: auths.filter((a) => a.status === 'CREATED').length,
        captured: auths.filter((a) => a.status === 'CAPTURED').length,
        partially_captured: auths.filter((a) => a.status === 'PARTIALLY_CAPTURED').length,
        voided: auths.filter((a) => a.status === 'VOIDED').length,
      },
      captures: caps.length,
      captured_usd: (sum(caps) / 100).toFixed(2),
      recent: caps.slice(-8).reverse().map(publicView),
    };
  }

  // ---------- HTTP ----------

  async handle(req, res, url, readBody) {
    const p = url.pathname.replace(/^\/mock-paypal/, '');
    const method = req.method;
    try {
      if (method === 'GET' && p === '/checkoutnow') return this.serveCheckout(res, url.searchParams.get('token'));
      if (method === 'POST' && p === '/_approve') {
        const body = await readBody();
        const buyer = MOCK_BUYERS[Number(body.buyer) || 0];
        this.approve(body.order_id, buyer);
        return send(res, 200, { ok: true });
      }
      if (method === 'GET' && p === '/_ledger') return send(res, 200, this.ledger());
      if (method === 'POST' && p === '/v1/oauth2/token') {
        if (!String(req.headers.authorization || '').startsWith('Basic ')) throw apiError(401, 'AUTHENTICATION_FAILURE', 'MISSING_CREDENTIALS');
        return send(res, 200, { scope: 'mock', access_token: `MOCK-${MockPayPal.id()}`, token_type: 'Bearer', app_id: 'APP-MOCK', expires_in: 32400, nonce: 'mock' });
      }
      if (!String(req.headers.authorization || '').startsWith('Bearer MOCK-')) throw apiError(401, 'AUTHENTICATION_FAILURE', 'INVALID_ACCESS_TOKEN');

      const body = method === 'POST' ? await readBody() : undefined;
      const reqId = req.headers['paypal-request-id'];
      const key = reqId ? `${method} ${p} ${reqId}` : null;
      if (key && this.state.idempotency[key]) {
        const hit = this.state.idempotency[key];
        return send(res, hit.status, hit.body);
      }
      const reply = (status, out) => {
        if (key) {
          this.state.idempotency[key] = { status, body: out };
          this.save();
        }
        return send(res, status, out);
      };

      let m;
      if (method === 'POST' && p === '/v2/checkout/orders') return reply(201, this.orderView(this.createOrder(body)));
      if ((m = p.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)$/)) && method === 'GET') {
        const o = this.state.orders[m[1]];
        if (!o) throw apiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
        return send(res, 200, this.orderView(o));
      }
      if ((m = p.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/authorize$/)) && method === 'POST') return reply(201, this.authorize(m[1]));
      if ((m = p.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/track$/)) && method === 'POST') return reply(201, this.track(m[1], body));
      if ((m = p.match(/^\/v2\/payments\/authorizations\/([A-Z0-9]+)$/)) && method === 'GET') {
        const a = this.state.authorizations[m[1]];
        if (!a) throw apiError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
        return send(res, 200, this.authView(a));
      }
      if ((m = p.match(/^\/v2\/payments\/authorizations\/([A-Z0-9]+)\/capture$/)) && method === 'POST') return reply(201, this.capture(m[1], body));
      if ((m = p.match(/^\/v2\/payments\/authorizations\/([A-Z0-9]+)\/void$/)) && method === 'POST') {
        const out = this.void(m[1]);
        return String(req.headers.prefer || '').includes('representation') ? reply(200, out) : reply(204, null);
      }
      if ((m = p.match(/^\/v2\/payments\/authorizations\/([A-Z0-9]+)\/reauthorize$/)) && method === 'POST') return reply(201, this.reauthorize(m[1], body));
      throw apiError(404, 'RESOURCE_NOT_FOUND', 'NOT_IMPLEMENTED_IN_MOCK');
    } catch (e) {
      if (e.mockStatus) return send(res, e.mockStatus, e.mockBody);
      return send(res, 500, { name: 'INTERNAL_SERVER_ERROR', message: String(e.message), debug_id: 'mock' });
    }
  }

  serveCheckout(res, orderId) {
    const o = this.state.orders[orderId];
    const pu = o?.purchase_units?.[0];
    const rows = pu
      ? pu.items.map((i) => `<tr><td>${esc(i.name)} × ${esc(i.quantity)}</td><td>$${esc(i.unit_amount.value)}</td></tr>`).join('') +
        `<tr><td>Shipping</td><td>$${esc(pu.amount.breakdown?.shipping?.value || '0.00')}</td></tr>`
      : '';
    const buyers = MOCK_BUYERS.map((b, i) => `<label class="b"><input type="radio" name="buyer" value="${i}" ${i === 0 ? 'checked' : ''}> <span><b>${esc(b.name)}</b><br><small>${esc(b.email)} · ${esc(b.address.admin_area_2)}, ${esc(b.country)}</small></span></label>`).join('');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MOCK PayPal approval</title>
<style>
body{font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f3f1ec;color:#1d1d1f}
.bar{background:#7a2e0e;color:#fff;padding:10px 16px;font-weight:600;letter-spacing:.02em}
main{max-width:440px;margin:18px auto;background:#fff;border-radius:12px;padding:18px 20px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h1{font-size:18px;margin:0 0 4px} p{margin:6px 0;color:#555} table{width:100%;border-collapse:collapse;margin:10px 0}
td{padding:5px 0;border-bottom:1px solid #eee} td:last-child{text-align:right} .tot td{font-weight:700;border-bottom:none}
.b{display:flex;gap:10px;align-items:flex-start;padding:8px;border:1px solid #ddd;border-radius:8px;margin:6px 0;cursor:pointer}
button{width:100%;padding:12px;border:0;border-radius:999px;font-size:16px;font-weight:600;cursor:pointer;margin-top:8px}
.ok{background:#1d1d1f;color:#fff}.no{background:#eee;color:#333}
</style></head><body>
<div class="bar">MOCK PAYPAL · local stand-in, sandbox credentials not set · no real account or money</div>
<main>
${o ? `<h1>Approve a payment hold</h1>
<p>${esc(o._experience.brand_name || 'Merchant')} is asking to <b>authorize</b> this amount. It is not charged now.</p>
<table>${rows}<tr class="tot"><td>Authorize</td><td>$${esc(pu.amount.value)} ${esc(pu.amount.currency_code)}</td></tr></table>
<p>Pick a demo buyer (their shipping address goes back to the merchant):</p>
<form id="f">${buyers}
<button class="ok" type="submit">Agree and continue</button>
<button class="no" type="button" id="cancel">Cancel</button></form>` : '<h1>Unknown order</h1>'}
</main>
<script>
const orderId=${JSON.stringify(orderId || '')};
const f=document.getElementById('f');
function done(type){ if(window.opener){window.opener.postMessage({source:'mock-paypal',type,orderId},location.origin);} window.close(); }
if(f){f.addEventListener('submit',async e=>{e.preventDefault();
 const buyer=new FormData(f).get('buyer');
 const r=await fetch('/mock-paypal/_approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({order_id:orderId,buyer})});
 if(r.ok) done('approved'); else alert('Mock approval failed');});
 document.getElementById('cancel').onclick=()=>done('cancelled');}
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
}

// Demo buyers offered on the mock approval page. Fictional people.
export const MOCK_BUYERS = [
  { name: 'Hannah Becker', email: 'hannah.becker@example.com', country: 'DE', address: { address_line_1: 'Lindenstrasse 12', admin_area_2: 'Leipzig', postal_code: '04103', country_code: 'DE' } },
  { name: 'Marcus Reid', email: 'marcus.reid@example.com', country: 'US', address: { address_line_1: '418 Alder St', admin_area_2: 'Portland', admin_area_1: 'OR', postal_code: '97204', country_code: 'US' } },
  { name: 'Aiko Mori', email: 'aiko.mori@example.com', country: 'JP', address: { address_line_1: '2-14-3 Kichijoji Honcho', admin_area_2: 'Musashino', admin_area_1: 'Tokyo', postal_code: '180-0004', country_code: 'JP' } },
];

function validateOrder(body) {
  if (!body || !['CAPTURE', 'AUTHORIZE'].includes(body.intent)) return apiError(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE', 'intent');
  const pu = body.purchase_units?.[0];
  if (!pu?.amount?.value) return apiError(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER', 'purchase_units[0].amount');
  const items = pu.items || [];
  const itemTotal = items.reduce((s, i) => s + cents(i.unit_amount.value) * Number(i.quantity), 0);
  const bd = pu.amount.breakdown || {};
  if (bd.item_total && cents(bd.item_total.value) !== itemTotal) return apiError(422, 'UNPROCESSABLE_ENTITY', 'ITEM_TOTAL_MISMATCH');
  const expected = (bd.item_total ? cents(bd.item_total.value) : 0) + (bd.shipping ? cents(bd.shipping.value) : 0);
  if (bd.item_total && cents(pu.amount.value) !== expected) return apiError(422, 'UNPROCESSABLE_ENTITY', 'AMOUNT_MISMATCH');
  return null;
}

function cents(v) {
  const [w, f = ''] = String(v).split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

function apiError(status, name, issue, field) {
  const e = new Error(`${name}/${issue}`);
  e.mockStatus = status;
  e.mockBody = {
    name,
    message: 'MOCK PayPal error',
    debug_id: `mock${crypto.randomBytes(4).toString('hex')}`,
    details: [{ issue, ...(field ? { field } : {}), description: `MOCK: ${issue}` }],
  };
  return e;
}

function publicView(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith('_')));
}

function send(res, status, body) {
  if (status === 204 || body == null) {
    res.writeHead(status);
    return res.end();
  }
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
