// Thin client for the PayPal REST endpoints Quorum uses.
// The same code talks to the sandbox (api-m.sandbox.paypal.com) or to the local mock;
// only the base URL and credentials change.
import { usdAmount } from './money.js';

export class PayPalError extends Error {
  constructor(status, body, where) {
    const issue = body?.details?.[0]?.issue;
    super(`PayPal ${where} failed (${status}${body?.name ? ` ${body.name}` : ''}${issue ? ` / ${issue}` : ''})`);
    this.name = 'PayPalError';
    this.status = status;
    this.paypalName = body?.name || null;
    this.issue = issue || null;
    this.debugId = body?.debug_id || null;
    this.body = body;
  }
}

export function createPayPal({ base, clientId, clientSecret }) {
  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpiresAt - 60_000) return token;
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new PayPalError(res.status, body, 'oauth2/token');
    token = body.access_token;
    tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return token;
  }

  async function call(method, path, body, { requestId } = {}) {
    const headers = {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    };
    // PayPal-Request-Id makes POSTs idempotent: a retried capture with the same id
    // returns the first result instead of capturing twice.
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { name: 'NON_JSON_RESPONSE', message: text.slice(0, 300) };
      }
    }
    if (!res.ok) throw new PayPalError(res.status, json, `${method} ${path.replace(/\/[A-Z0-9]{12,}/g, '/{id}')}`);
    return json;
  }

  return {
    base,
    createOrder: (body, requestId) => call('POST', '/v2/checkout/orders', body, { requestId }),
    getOrder: (orderId) => call('GET', `/v2/checkout/orders/${orderId}`),
    authorizeOrder: (orderId, requestId) => call('POST', `/v2/checkout/orders/${orderId}/authorize`, undefined, { requestId }),
    getAuthorization: (authId) => call('GET', `/v2/payments/authorizations/${authId}`),
    captureAuthorization: (authId, { cents, finalCapture = true, noteToPayer }, requestId) =>
      call(
        'POST',
        `/v2/payments/authorizations/${authId}/capture`,
        {
          amount: usdAmount(cents),
          final_capture: finalCapture,
          ...(noteToPayer ? { note_to_payer: noteToPayer.slice(0, 255) } : {}),
        },
        { requestId },
      ),
    voidAuthorization: (authId, requestId) => call('POST', `/v2/payments/authorizations/${authId}/void`, undefined, { requestId }),
    reauthorize: (authId, cents, requestId) =>
      call('POST', `/v2/payments/authorizations/${authId}/reauthorize`, { amount: usdAmount(cents) }, { requestId }),
    addTracking: (orderId, body, requestId) => call('POST', `/v2/checkout/orders/${orderId}/track`, body, { requestId }),
  };
}

// Order body for a pledge. intent=AUTHORIZE: the fan approves a hold, nothing is charged yet.
// PayPal page language from the fan's language. Without it PayPal guesses from the connection,
// which showed a Korean sign-in page to a German fan in the sandbox.
const PAYPAL_LOCALES = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', 'zh-tw': 'zh-TW', 'zh-hk': 'zh-HK', zh: 'zh-CN', id: 'id-ID', th: 'th-TH' };
export function paypalLocale(lang) {
  const l = String(lang || '').toLowerCase();
  return PAYPAL_LOCALES[l] || PAYPAL_LOCALES[l.split('-')[0]] || null;
}

export function buildOrderBody({ campaign, pledge, returnUrl, cancelUrl }) {
  const locale = paypalLocale(pledge.buyer?.locale);
  return {
    intent: 'AUTHORIZE',
    purchase_units: [
      {
        reference_id: pledge.id,
        custom_id: pledge.id,
        description: `Pre-order hold: ${campaign.title}`.slice(0, 127),
        amount: {
          ...usdAmount(pledge.total_cents),
          breakdown: {
            item_total: usdAmount(pledge.item_cents),
            shipping: usdAmount(pledge.shipping_cents),
          },
        },
        items: pledge.lines.map((l) => {
          const opt = campaign.options.find((o) => o.id === l.option_id);
          return {
            name: opt.name_en.slice(0, 127),
            quantity: String(l.qty),
            unit_amount: usdAmount(l.unit_cents),
            sku: `${campaign.slug}-${opt.id}`.slice(0, 127),
            category: 'PHYSICAL_GOODS',
          };
        }),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: campaign.creator_name.slice(0, 127),
          ...(locale ? { locale } : {}),
          shipping_preference: 'GET_FROM_FILE',
          user_action: 'CONTINUE',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  };
}

// Pull what Quorum stores from an authorize response.
export function readAuthorization(order) {
  const pu = order.purchase_units?.[0] || {};
  const auth = pu.payments?.authorizations?.[0];
  if (!auth) throw new Error('Authorize response has no authorization');
  const [whole, frac = ''] = String(auth.amount.value).split('.');
  return {
    authorization_id: auth.id,
    authorization_status: auth.status,
    authorized_cents: Number(whole) * 100 + Number((frac + '00').slice(0, 2)),
    currency: auth.amount.currency_code,
    expiration_time: auth.expiration_time || null,
    authorized_at: auth.create_time || new Date().toISOString(),
    seller_protection: auth.seller_protection?.status || null,
    payer: {
      name: [order.payer?.name?.given_name, order.payer?.name?.surname].filter(Boolean).join(' ') || null,
      email: order.payer?.email_address || order.payment_source?.paypal?.email_address || null,
      payer_id: order.payer?.payer_id || order.payment_source?.paypal?.account_id || null,
    },
    shipping: pu.shipping
      ? { name: pu.shipping.name?.full_name || null, address: pu.shipping.address || null }
      : null,
  };
}
