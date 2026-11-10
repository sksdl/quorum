import { api, esc, usd, krw, header, timeLeft, ago, slugFromPath, busy } from '/js/common.js';

const slug = slugFromPath(2);
await header({ slug, active: 'studio' });
let showAll = false;
let view;

const STATUS = {
  held: '<span class="pill brand">Held</span>',
  captured: '<span class="pill go">Captured</span>',
  partially_captured: '<span class="pill go">Partly captured</span>',
  voided: '<span class="pill">Released</span>',
  capture_failed: '<span class="pill stop">Failed</span>',
};

function ageBadge(p) {
  const a = p.auth_age;
  if (!a || p.status !== 'held') return '';
  if (a.in_honor_period) return `<span class="age pill go">day ${a.days + 1} · honored</span>`;
  return `<span class="age pill short">day ${a.days + 1} · ${a.days_to_expiry} d to expiry</span>`;
}

async function load() {
  view = await api(`/api/studio/${slug}`);
  const c = view.campaign;
  document.getElementById('by').textContent = `${c.creator_name} · creator studio`;
  document.getElementById('title').textContent = c.title;
  const k = view.counts;
  document.getElementById('kpis').innerHTML = `
    <div class="card kpi"><div class="v">${usd(k.held_cents)}</div><div class="l">held in ${k.held} PayPal authorizations</div></div>
    <div class="card kpi"><div class="v">${c.status === 'open' ? esc(timeLeft(c.closes_at)) : esc(c.status)}</div><div class="l">${c.status === 'open' ? 'until pre-orders close' : 'campaign status'}</div></div>
    <div class="card kpi"><div class="v">${k.past_honor_period}</div><div class="l">holds past PayPal's 3-day honor period${k.live_past_honor_period && c.status !== 'settled' ? ` <button class="ghost small" id="reauth-all">Reauthorize ${k.live_past_honor_period} live</button>` : ''}</div></div>
    <div class="card kpi"><div class="v">${k.live}${k.simulated ? ` <small style="font-size:14px">+ ${k.simulated} sim</small>` : ''}</div><div class="l">${k.simulated ? 'live sandbox holds (+ simulated demo pledges)' : 'live holds in PayPal (' + esc(view.modes.paypal) + ')'}</div></div>`;

  const opts = c.options;
  document.getElementById('opts').innerHTML = view.economics
    .map((e, i) => {
      const o = opts[i];
      const pct = Math.min(100, Math.round((e.pledged_qty / e.moq) * 100));
      const base = e.scenarios[0];
      const pill = e.status === 'met' ? '<span class="pill go">met</span>' : e.status === 'short' ? `<span class="pill short">${e.shortfall} short</span>` : '<span class="pill">no pledges</span>';
      return `<div class="card optcard">
        <img src="${esc(o.image)}" alt="">
        <div>
          <div class="spread"><b>${esc(o.id)} · ${esc(o.name_en)}</b></div>
          <div class="spread num" style="margin:4px 0"><span>${e.pledged_qty} / ${e.moq}</span>${pill}</div>
          <div class="bar ${e.status === 'short' ? 'short' : ''}"><i style="width:${pct}%"></i></div>
          ${base ? `<div class="l num" style="margin-top:6px">Make ${base.order_qty}: cost ${krw(base.cost_krw)}, est. profit ${krw(base.profit_krw)}</div>` : ''}
          ${e.cheaper_bigger_order ? `<div class="l num" style="color:var(--go)">Ordering ${e.cheaper_bigger_order.order_qty} costs less (${krw(e.cheaper_bigger_order.cost_krw)})</div>` : ''}
        </div>
      </div>`;
    })
    .join('');

  const actions = [];
  actions.push(`<a class="btn ghost" href="/c/${slug}" target="_blank">Open fan page</a>`);
  if (c.status === 'open') actions.push('<button class="ghost" id="close">Close pre-orders now</button>');
  if (c.status !== 'settled') actions.push(`<a class="btn brand" href="/studio/${slug}/settle">Plan settlement</a>`);
  else actions.push(`<a class="btn ghost" href="/api/studio/${slug}/messages.csv">Fan messages (CSV)</a>`, `<a class="btn brand" href="/studio/${slug}/ship">Add tracking</a>`);
  document.getElementById('actions').innerHTML = actions.join('');
  document.getElementById('reauth-all')?.addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'Reauthorizing');
    const r = await api(`/api/studio/${slug}/reauthorize-due`, { method: 'POST' });
    alert(`Reauthorized ${r.reauthorized} of ${r.due} holds${r.failed.length ? `, ${r.failed.length} failed` : ''}.`);
    load();
  });
  document.getElementById('close')?.addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'Closing');
    await api(`/api/studio/${slug}/close`, { method: 'POST' });
    load();
  });

  const list = showAll ? view.pledges : view.pledges.slice(0, 14);
  document.getElementById('pl-count').textContent = `${view.pledges.length} pledges`;
  document.getElementById('more').classList.toggle('hidden', showAll || view.pledges.length <= 14);
  document.getElementById('pledges').innerHTML = list
    .map((p) => {
      const items = p.lines.map((l) => `${l.option_id}×${l.qty}`).join(' ');
      const reauth = !p.simulated && p.status === 'held' && p.auth_age && !p.auth_age.in_honor_period ? ` <button class="ghost small" data-reauth="${p.id}">Reauthorize</button>` : '';
      return `<tr>
        <td>${esc(p.buyer.name || 'pending')}<div class="sub">${esc(p.buyer.country || '')} · ${esc(p.buyer.locale || '')}${p.simulated ? ' · simulated' : ''}${p.flags?.length ? ` · <span class="err">${esc(p.flags.join(', '))}</span>` : ''}</div></td>
        <td class="num">${esc(items)}</td>
        <td class="r num">${usd(p.total_cents)}${p.settlement ? `<div class="sub">charged ${usd(p.settlement.capture_cents)}</div>` : ''}</td>
        <td>${ageBadge(p)}${reauth}</td>
        <td>${STATUS[p.status] || esc(p.status)}</td></tr>`;
    })
    .join('');

  document.getElementById('feed').innerHTML = view.events.map((ev) => `<li><time>${esc(ago(ev.at))}</time>${esc(ev.text)}</li>`).join('');
  if (view.mock_ledger) {
    const L = view.mock_ledger;
    document.getElementById('ledger-card').classList.remove('hidden');
    document.getElementById('ledger').innerHTML = `<table class="num"><tbody>
      <tr><td>Orders</td><td class="r">${L.orders}</td></tr>
      <tr><td>Authorizations open</td><td class="r">${L.authorizations.created}</td></tr>
      <tr><td>Captured / partly captured</td><td class="r">${L.authorizations.captured} / ${L.authorizations.partially_captured}</td></tr>
      <tr><td>Voided</td><td class="r">${L.authorizations.voided}</td></tr>
      <tr><td>Captured total</td><td class="r">$${esc(L.captured_usd)}</td></tr></tbody></table>`;
  }
}

document.getElementById('more').addEventListener('click', () => {
  showAll = true;
  load();
});
document.getElementById('pledges').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-reauth]');
  if (!b) return;
  busy(b, true, '');
  try {
    await api(`/api/studio/${slug}/pledges/${b.dataset.reauth}/reauthorize`, { method: 'POST' });
  } catch (err) {
    alert(err.message);
  }
  load();
});

await load();
