import { api, esc, usd, header, timeLeft, aiTag, slugFromPath, busy } from '/js/common.js';

const slug = slugFromPath(2);
const status = await header({ slug, active: 'fan' });
const qty = {};
let campaign;

async function load() {
  const r = await api(`/api/campaigns/${slug}`);
  campaign = r.campaign;
  document.title = `${campaign.title} by ${campaign.creator_name}`;
  document.getElementById('by').textContent = `${campaign.creator_name} · pre-order`;
  document.getElementById('title').textContent = campaign.title;
  document.getElementById('summary').textContent = campaign.summary_en;
  document.getElementById('left').textContent = campaign.status === 'open' ? timeLeft(campaign.closes_at) : campaign.status === 'settled' ? 'Settled' : 'Closed';
  document.getElementById('backers').textContent = `${campaign.backers} backers`;
  renderOptions();
  renderRegions();
  renderSum();
  if (campaign.status !== 'open') {
    document.getElementById('pay-area').hidden = true;
    document.getElementById('region').disabled = true;
    if (!document.getElementById('pay-msg').textContent) msg(campaign.status === 'settled' ? 'Pre-orders are closed and settled.' : 'Pre-orders are closed.');
  }
}

function progress(o) {
  if (o.decision === 'produce') return { cls: '', pill: '<span class="pill go">Being made</span>' };
  if (o.decision === 'cancel') return { cls: 'cancel', pill: '<span class="pill stop">Not made, holds released</span>' };
  if (o.pledged_qty >= o.moq) return { cls: '', pill: `<span class="pill go">Minimum reached</span>` };
  return { cls: 'short', pill: `<span class="pill short">${o.moq - o.pledged_qty} more needed</span>` };
}

function renderOptions() {
  const open = campaign.status === 'open';
  document.getElementById('options').innerHTML = campaign.options
    .map((o) => {
      const p = progress(o);
      const pct = Math.min(100, Math.round((o.pledged_qty / o.moq) * 100));
      return `<div class="opt">
        <img src="${esc(o.image || '/img/item-a.svg')}" alt="">
        <div>
          <div class="spread"><h3>${esc(o.name_en)}</h3><b class="num">$${esc(o.price_usd)}</b></div>
          <div class="meta">${esc(o.description_en)}</div>
          <div class="bar ${p.cls}"><i style="width:${pct}%"></i></div>
          <div class="spread" style="font-size:13px;margin-top:4px"><span class="num">${o.pledged_qty} pledged · minimum ${o.moq}</span>${p.pill}</div>
        </div>
        <div class="qty" ${open ? '' : 'hidden'}>
          <button class="ghost" data-opt="${o.id}" data-d="-1" type="button" aria-label="Less">−</button>
          <output id="q-${o.id}">${qty[o.id] || 0}</output>
          <button class="ghost" data-opt="${o.id}" data-d="1" type="button" aria-label="More">+</button>
        </div>
      </div>`;
    })
    .join('');
}

document.getElementById('options').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-opt]');
  if (!b) return;
  const id = b.dataset.opt;
  qty[id] = Math.max(0, Math.min(20, (qty[id] || 0) + Number(b.dataset.d)));
  document.getElementById(`q-${id}`).textContent = qty[id];
  renderSum();
});

function renderRegions() {
  const sel = document.getElementById('region');
  if (sel.options.length) return;
  sel.innerHTML = `<option value="">Choose a region</option>` + campaign.shipping_regions.map((r) => `<option value="${esc(r.id)}">${esc(r.label_en)} · $${esc(r.price_usd)}</option>`).join('');
  sel.addEventListener('change', renderSum);
}

function cart() {
  const lines = campaign.options.filter((o) => qty[o.id] > 0).map((o) => ({ option_id: o.id, qty: qty[o.id] }));
  const region = campaign.shipping_regions.find((r) => r.id === document.getElementById('region').value);
  const items = lines.reduce((s, l) => s + Math.round(Number(campaign.options.find((o) => o.id === l.option_id).price_usd) * 100) * l.qty, 0);
  const ship = region && lines.length ? Math.round(Number(region.price_usd) * 100) : 0;
  return { lines, region, items, ship, total: items + ship };
}

function renderSum() {
  const c = cart();
  const rows = c.lines.map((l) => {
    const o = campaign.options.find((x) => x.id === l.option_id);
    return `<tr><td>${esc(o.name_en)} × ${l.qty}</td><td class="r">${usd(Math.round(Number(o.price_usd) * 100) * l.qty)}</td></tr>`;
  });
  if (!c.lines.length) rows.push('<tr><td class="muted">Pick items with + on the left</td><td></td></tr>');
  rows.push(`<tr><td>Shipping${c.region ? ` (${esc(c.region.label_en)})` : ''}</td><td class="r">${c.region && c.lines.length ? usd(c.ship) : '–'}</td></tr>`);
  rows.push(`<tr class="total"><td>Hold today</td><td class="r">${usd(c.total)}</td></tr>`);
  document.getElementById('sum').innerHTML = rows.join('');
}

function validate() {
  const c = cart();
  if (campaign.status !== 'open') return 'Pre-orders are closed.';
  if (!c.lines.length) return 'Pick at least one item.';
  if (!c.region) return 'Choose where to ship.';
  return null;
}

const msg = (html, cls = 'muted') => {
  const el = document.getElementById('pay-msg');
  el.className = cls;
  el.innerHTML = html;
};

// ?lang=ja on the URL overrides the browser language (used for receipt notes, messages and the PayPal button).
const fanLang = () => new URLSearchParams(location.search).get('lang') || navigator.language || 'en';
// Same table as server/paypal.js.
const PAYPAL_LOCALES = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-ES', it: 'it-IT', nl: 'nl-NL', pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', 'zh-tw': 'zh-TW', 'zh-hk': 'zh-HK', zh: 'zh-CN', id: 'id-ID', th: 'th-TH' };
const paypalLocale = (lang) => PAYPAL_LOCALES[String(lang).toLowerCase()] || PAYPAL_LOCALES[String(lang).toLowerCase().split('-')[0]] || null;

async function createPledge() {
  const c = cart();
  const lang = fanLang();
  return api(`/api/campaigns/${slug}/pledges`, { body: { lines: c.lines, region_id: c.region.id, locale: lang } });
}

async function authorize(orderId) {
  msg('<span class="spinner dark"></span> Placing the hold with PayPal');
  const r = await api(`/api/campaigns/${slug}/pledges/${orderId}/authorize`, { method: 'POST' });
  const exp = r.expires ? new Date(r.expires).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  msg(`<span class="ok">Hold placed: ${esc(r.total)}.</span> Nothing is charged until pre-orders close${exp ? `; the hold expires ${esc(exp)} at the latest` : ''}. <a href="${esc(r.pledge_url)}">Your pre-order page</a>${r.flags?.includes('shipping_region_mismatch') ? '<br><span class="err">The PayPal shipping address is in a different region than the one picked here. The creator will check the shipping cost.</span>' : ''}${r.flags?.includes('no_shipping_address') ? '<br><span class="err">PayPal did not share a shipping address for this order. The creator will ask you for one before shipping.</span>' : ''}`, '');
  for (const k of Object.keys(qty)) qty[k] = 0;
  await load();
}

// ----- PayPal: JS SDK v6 in sandbox mode, a local popup in mock mode -----
async function setupSandboxButton() {
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
    s.async = true;
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load the PayPal SDK'));
    document.head.appendChild(s);
  });
  // Button language from the fan's language; without it PayPal picks one from the connection (Korean, seen in the sandbox).
  const locale = paypalLocale(fanLang());
  const sdk = await window.paypal.createInstance({ clientId: status.paypal_client_id, components: ['paypal-payments'], pageType: 'checkout', ...(locale ? { locale } : {}) });
  const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
  if (!methods.isEligible('paypal')) return msg('PayPal is not available for this browser or region.', 'err');
  const session = sdk.createPayPalOneTimePaymentSession({
    async onApprove(data) {
      try {
        await authorize(data.orderId);
      } catch (e) {
        msg(esc(e.message), 'err');
      }
    },
    onCancel() {
      msg('Cancelled. No hold was placed.');
    },
    onError(e) {
      msg(`PayPal error: ${esc(e?.message || e)}`, 'err');
    },
  });
  const btn = document.getElementById('paypal-button');
  btn.removeAttribute('hidden');
  btn.addEventListener('click', async () => {
    const problem = validate();
    if (problem) return msg(problem, 'err');
    msg('');
    try {
      // Pass the promise without awaiting it first, as PayPal's v6 sample does, so the popup keeps its user activation.
      const orderPromise = createPledge().then((r) => ({ orderId: r.order_id }));
      await session.start({ presentationMode: 'auto' }, orderPromise);
    } catch (e) {
      msg(esc(e.message), 'err');
    }
  });
}

function setupMockButton() {
  const btn = document.getElementById('mock-button');
  btn.classList.remove('hidden');
  let pendingOrder = null;
  window.addEventListener('message', async (e) => {
    if (e.origin !== location.origin || e.data?.source !== 'mock-paypal' || e.data.orderId !== pendingOrder) return;
    if (e.data.type === 'approved') {
      try {
        await authorize(e.data.orderId);
      } catch (err) {
        msg(esc(err.message), 'err');
      }
    } else msg('Cancelled. No hold was placed.');
    pendingOrder = null;
  });
  btn.addEventListener('click', async () => {
    const problem = validate();
    if (problem) return msg(problem, 'err');
    const w = window.open('about:blank', 'mockpaypal', 'width=480,height=760');
    busy(btn, true, 'Opening');
    try {
      const r = await createPledge();
      pendingOrder = r.order_id;
      if (w) w.location = r.approve_url;
      else msg(`Popup blocked. <a href="${esc(r.approve_url)}" target="mockpaypal">Open the mock PayPal page</a>.`);
      msg('Approve the hold in the MOCK PayPal window.');
    } catch (e) {
      if (w) w.close();
      msg(esc(e.message), 'err');
    } finally {
      busy(btn, false);
    }
  });
}

document.getElementById('ask').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if (!q) return;
  const out = document.getElementById('answer');
  out.innerHTML = '<span class="spinner dark"></span>';
  try {
    const r = await api(`/api/campaigns/${slug}/ask`, { body: { question: q } });
    document.getElementById('ask-tag').innerHTML = aiTag(r.ai, 'Answered by AI');
    out.innerHTML = `${esc(r.answer)}${r.forward_to_creator ? '<br><small>Sent to the creator.</small>' : ''}`;
  } catch (err) {
    out.innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
});

await load();
if (status.paypal_mode === 'sandbox') setupSandboxButton().catch((e) => msg(esc(e.message), 'err'));
else setupMockButton();
