export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const krw = (won) => `${won < 0 ? '-' : ''}₩${Math.abs(Math.round(won)).toLocaleString('en-US')}`;
export const $ = (sel, root = document) => root.querySelector(sel);

export function slugFromPath(index = 2) {
  return location.pathname.split('/')[index];
}

export function timeLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'closed';
  const h = Math.floor(ms / 3600000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h} h left`;
  return `${Math.max(1, Math.floor(ms / 60000))} min left`;
}

export function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#2b2d6e"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export async function header({ slug, active } = {}) {
  const status = await api('/api/status');
  const s = slug || status.campaigns[0]?.slug;
  const nav = s
    ? `<a href="/c/${s}" class="${active === 'fan' ? 'on' : ''}">Fan page</a>
       <a href="/studio/${s}" class="${active === 'studio' ? 'on' : ''}">Studio</a>
       <a href="/studio/${s}/settle" class="${active === 'settle' ? 'on' : ''}">Settle</a>
       <a href="/studio/${s}/ship" class="${active === 'ship' ? 'on' : ''}">Ship</a>`
    : '';
  const pp = status.paypal_mode === 'sandbox' ? '<span class="mode live">PayPal: Sandbox</span>' : '<span class="mode mock" title="Local stand-in for the PayPal REST API. Add sandbox keys to .env">PayPal: MOCK</span>';
  const aiB = status.ai_mode === 'azure-openai'
    ? `<span class="mode live" title="Model deployment in Azure OpenAI">AI: Azure OpenAI (${esc(status.model)})</span>`
    : '<span class="mode mock" title="Sample outputs written for the demo. Add Azure OpenAI settings to .env">AI: MOCK</span>';
  const el = document.createElement('header');
  el.className = 'top';
  el.innerHTML = `<a class="logo" href="/">${LOGO}Quorum</a><nav>${nav}<a href="/studio/new" class="${active === 'new' ? 'on' : ''}">New campaign</a></nav><div class="modes">${pp}${aiB}</div>`;
  document.body.prepend(el);
  return status;
}

export function aiTag(meta, label = 'AI') {
  if (!meta) return '';
  const mock = meta.mode === 'mock';
  return `<span class="ai-tag ${mock ? 'mock' : ''}" title="${esc(meta.note || meta.model || '')}">${esc(label)} · ${mock ? 'MOCK' : esc(meta.model)}</span>`;
}

export function busy(btn, on, text) {
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner ${btn.classList.contains('ghost') ? 'dark' : ''}"></span> ${esc(text || 'Working')}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

export const COUNTRY_NAMES = { JP: 'Japan', US: 'United States', TW: 'Taiwan', ID: 'Indonesia', PH: 'Philippines', DE: 'Germany', CA: 'Canada', MX: 'Mexico', AU: 'Australia', FR: 'France', GB: 'United Kingdom', SG: 'Singapore', TH: 'Thailand', HK: 'Hong Kong', MY: 'Malaysia', ES: 'Spain', NL: 'Netherlands' };
