import { api, esc, usd, krw, header, timeLeft, aiTag, slugFromPath, busy } from '/js/common.js';

const slug = slugFromPath(2);
const status = await header({ slug, active: 'settle' });
let view;
let draft;
let decisions = {};

const ACTION = { capture_full: 'Full capture', capture_partial: 'Partial capture', void: 'Hold released' };
const step = (n, cls) => (document.getElementById(`st${n}`).className = cls);

async function load() {
  view = await api(`/api/studio/${slug}`);
  const c = view.campaign;
  document.getElementById('by').textContent = `${c.creator_name} · ${c.title}`;
  if (c.status === 'open') {
    step(1, 'on');
    document.getElementById('open-card').classList.remove('hidden');
    document.getElementById('open-left').textContent = `${timeLeft(c.closes_at)}. ${view.counts.held} holds totalling ${usd(view.counts.held_cents)}. Closing stops new pledges; nothing is charged until you approve the plan.`;
    return;
  }
  step(1, 'done');
  if (c.status === 'settled') return showSettled(c);
  await runDraft();
}

document.getElementById('close').addEventListener('click', async (e) => {
  busy(e.currentTarget, true, 'Closing');
  await api(`/api/studio/${slug}/close`, { method: 'POST' });
  document.getElementById('open-card').classList.add('hidden');
  load();
});

async function runDraft() {
  step(2, 'on');
  const sec = document.getElementById('decide');
  sec.classList.remove('hidden');
  document.getElementById('decisions').innerHTML = '<div class="card"><span class="spinner dark"></span> Computing costs and asking AI for a recommendation</div>';
  draft = await api(`/api/studio/${slug}/settlement/draft`, { method: 'POST' });
  decisions = structuredClone(draft.decisions);
  document.getElementById('rec-tag').innerHTML = aiTag(draft.ai, 'Recommended by AI');
  document.getElementById('rec-summary').textContent = draft.recommendation?.summary || '';
  document.getElementById('rec-problems').innerHTML = draft.problems.length ? `<div class="note warn">${draft.problems.map(esc).join('<br>')}<br>Rule-based defaults are used for these.</div>` : '';
  document.getElementById('notes-tag').innerHTML = aiTag(draft.notes_ai, 'Written by AI');
  renderDecisions();
  showPreview(draft.preview);
}

function renderDecisions() {
  const opts = view.campaign.options;
  document.getElementById('decisions').innerHTML = draft.economics
    .filter((e) => e.pledged_qty > 0)
    .map((e) => {
      const o = opts.find((x) => x.id === e.option_id);
      const rec = draft.recommendation?.options?.[e.option_id];
      const rule = draft.rules[e.option_id];
      const d = decisions[e.option_id];
      const ruleTxt = rule.action === 'produce' ? `make ${rule.order_qty}` : 'cancel';
      const recTxt = rec ? (rec.action === 'produce' ? `make ${rec.order_qty}` : 'cancel') : null;
      const pill = e.status === 'met' ? '<span class="pill go">minimum met</span>' : `<span class="pill short">${e.shortfall} short of ${e.moq}</span>`;
      const rows = e.scenarios
        .map((s) => `<tr class="${d.action === 'produce' && d.order_qty === s.order_qty ? 'pick' : ''}"><td>${s.order_qty}</td><td class="r">${krw(s.cost_krw)}</td><td class="r">${krw(s.profit_krw)}</td><td class="r">${s.leftover_units}</td></tr>`)
        .join('');
      const choices = e.scenarios
        .map((s) => `<label class="${d.action === 'produce' && d.order_qty === s.order_qty ? 'on' : ''}"><input type="radio" name="d-${e.option_id}" value="produce:${s.order_qty}" ${d.action === 'produce' && d.order_qty === s.order_qty ? 'checked' : ''}>Make ${s.order_qty}</label>`)
        .join('') + `<label class="cancel ${d.action === 'cancel' ? 'on' : ''}"><input type="radio" name="d-${e.option_id}" value="cancel" ${d.action === 'cancel' ? 'checked' : ''}>Cancel, release holds</label>`;
      return `<div class="card dec">
        <img src="${esc(o.image)}" alt="">
        <div>
          <div class="spread"><b>${esc(o.id)} · ${esc(o.name_en)}</b>${pill}</div>
          <div class="muted num" style="font-size:13px">${e.pledged_qty} pledged × $${(e.price_cents / 100).toFixed(2)} = ${usd(e.revenue_cents)} · factory minimum ${e.moq}${o.fixed_cost_krw ? ` · one-time fee ${krw(o.fixed_cost_krw)}` : ''}</div>
          <table class="scen num" style="margin-top:6px"><thead><tr><th>Order</th><th class="r">Cost incl. VAT</th><th class="r">Est. profit</th><th class="r">Spare</th></tr></thead><tbody>${rows}</tbody></table>
          ${e.cheaper_bigger_order ? `<div class="num" style="font-size:13px;color:var(--go);margin-top:4px">Price break: ordering ${e.cheaper_bigger_order.order_qty} costs ${krw(e.scenarios[0].cost_krw - e.cheaper_bigger_order.cost_krw)} less than ${e.scenarios[0].order_qty}.</div>` : ''}
          ${rec ? `<div class="rec"><b>${esc(rec.headline)}</b>${esc(rec.reasoning)}</div>` : ''}
          <div class="rule ${recTxt && recTxt !== ruleTxt ? 'diff' : ''}">Simple rule says: ${esc(ruleTxt)}${recTxt && recTxt !== ruleTxt ? ` · AI says: ${esc(recTxt)}` : ''}</div>
          <div class="choices">${choices}</div>
        </div>
      </div>`;
    })
    .join('');
}

document.getElementById('decisions').addEventListener('change', async (e) => {
  const input = e.target.closest('input[type=radio]');
  if (!input) return;
  const id = input.name.slice(2);
  const [action, q] = input.value.split(':');
  decisions[id] = action === 'cancel' ? { action: 'cancel', order_qty: 0 } : { action: 'produce', order_qty: Number(q) };
  renderDecisions();
  const p = await api(`/api/studio/${slug}/settlement/preview`, { body: { decisions } });
  showPreview(p);
});

function showPreview(p) {
  step(2, 'done');
  step(3, 'on');
  document.getElementById('check').classList.remove('hidden');
  const t = p.plan.totals;
  document.getElementById('plan').innerHTML = `
    <tr><td>Full captures</td><td class="r">${t.capture_full}</td></tr>
    <tr><td>Partial captures (some items cancelled)</td><td class="r">${t.capture_partial}</td></tr>
    <tr><td>Holds released, nothing charged</td><td class="r">${t.void}</td></tr>
    <tr><td>Held now</td><td class="r">${usd(t.authorized_cents)}</td></tr>
    <tr><td><b>Charged</b></td><td class="r"><b>${usd(t.capture_cents)}</b></td></tr>
    <tr><td>Released back to fans</td><td class="r">${usd(t.release_cents)}</td></tr>
    <tr><td>Refunds needed</td><td class="r">0</td></tr>`;
  document.getElementById('factory').innerHTML = p.plan.production
    .map((x) => `<tr><td>${esc(x.option_id)} · ${esc(x.name_en)}</td><td class="r">${x.pledged_qty}</td><td class="r">${x.order_qty}</td><td class="r">${x.leftover_units}</td><td class="r">${krw(x.cost_krw)}</td></tr>`)
    .join('') || '<tr><td colspan="5" class="muted">Nothing goes to the factory.</td></tr>';
  document.getElementById('guard').innerHTML = p.guard.checks.map((c) => `<li class="${c.ok ? '' : 'bad'}">${esc(c.name)}${!c.ok && c.detail ? ` <small>(${esc(c.detail)})</small>` : ''}</li>`).join('');
  document.getElementById('samples').innerHTML = (p.samples || [])
    .map(
      (s) => `<div class="sample"><div class="h"><span>${esc(s.buyer)} · ${esc(s.language)}${s.fallback ? ` (${esc(s.fallback)} text)` : ''}</span><span class="pill ${s.action === 'void' ? '' : 'go'}">${esc(ACTION[s.action])}</span></div>
      ${s.note_to_payer ? `<div><small class="muted">PayPal note</small><br>${esc(s.note_to_payer)}</div>` : '<div><small class="muted">No PayPal note on a released hold</small></div>'}
      <div style="margin-top:6px"><small class="muted">Message</small><br>${esc(s.message)}</div></div>`,
    )
    .join('');
  const live = status.paypal_mode === 'sandbox' ? `${t.live_pledges} live sandbox holds go to PayPal; ${t.pledges - t.live_pledges} simulated demo pledges are kept as rows in Quorum only.` : `${t.pledges} calls to the MOCK PayPal API.`;
  document.getElementById('go-title').textContent = `Charge ${t.capture_full + t.capture_partial} fans, release ${t.void} holds`;
  document.getElementById('go-sub').textContent = `${usd(t.capture_cents)} captured with final_capture=true and a PayPal-Request-Id per pledge, so a retry never charges twice. ${live}`;
  document.getElementById('execute').disabled = !p.guard.ok;
  const k = view.counts;
  document.getElementById('honor').innerHTML = k.live_past_honor_period
    ? `<div class="note warn" style="margin-top:10px">${k.live_past_honor_period} live holds are past PayPal's 3-day honor period. PayPal still attempts the capture, but the funds are not guaranteed. <button class="ghost small" id="reauth">Reauthorize them first</button></div>`
    : '';
  document.getElementById('reauth')?.addEventListener('click', async (e) => {
    busy(e.currentTarget, true, 'Reauthorizing');
    const r = await api(`/api/studio/${slug}/reauthorize-due`, { method: 'POST' });
    view = await api(`/api/studio/${slug}`);
    document.getElementById('honor').innerHTML = `<div class="note" style="margin-top:10px">Reauthorized ${r.reauthorized} of ${r.due} holds; each has a fresh 3-day honor period.${r.failed.length ? ` ${r.failed.length} failed.` : ''}</div>`;
  });
}

document.getElementById('execute').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  busy(btn, true, 'Capturing and voiding in PayPal');
  step(3, 'done');
  step(4, 'on');
  try {
    await api(`/api/studio/${slug}/settlement/execute`, { body: { decisions } });
    location.reload();
  } catch (err) {
    document.getElementById('exec-out').innerHTML = `<p class="err">${esc(err.message)}</p>`;
    busy(btn, false);
  }
});

async function showSettled(c) {
  ['decide', 'check'].forEach((id) => document.getElementById(id).classList.add('hidden'));
  [2, 3, 4].forEach((n) => step(n, 'done'));
  const r = await api(`/api/studio/${slug}/settlement`);
  const s = r.settlement;
  const res = s.results;
  const count = (st) => res.filter((x) => x.status === st).length;
  document.getElementById('settled-card').classList.remove('hidden');
  document.getElementById('to-ship').href = `/studio/${slug}/ship`;
  document.getElementById('csv').href = `/api/studio/${slug}/messages.csv`;
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  const sent = res.filter((x) => x.status === 'captured' || x.status === 'voided');
  const sentCap = sent.reduce((a, x) => a + (x.status === 'captured' ? x.capture_cents : 0), 0);
  const sentRel = sent.reduce((a, x) => a + x.release_cents, 0);
  const where = status.paypal_mode === 'sandbox' ? 'PayPal sandbox' : 'MOCK PayPal API';
  const lead = count('simulated')
    ? `In PayPal: ${usd(sentCap)} charged, ${usd(sentRel)} released (${n(sent.length, 'live hold')}). Counting the ${count('simulated')} simulated pledges too, which are not sent to PayPal: ${usd(s.totals.capture_cents)} charged, ${usd(s.totals.release_cents)} released.`
    : `${usd(s.totals.capture_cents)} charged, ${usd(s.totals.release_cents)} released.`;
  document.getElementById('settled-sum').innerHTML = `${lead} ${n(count('captured'), 'capture')} and ${n(count('voided'), 'void')} confirmed by the ${where}${count('failed') ? `, <span class="err">${count('failed')} failed</span>` : ''}${count('skipped') ? `, <span class="err">${count('skipped')} skipped by pre-flight</span>` : ''}. Pre-flight read ${n(s.preflight?.checked ?? 0, 'live authorization')} back from PayPal before charging.`;
  const main = document.querySelector('main');
  const box = document.createElement('section');
  box.className = 'stack';
  const sample = r.samples.slice(0, 40);
  box.innerHTML = `<div class="card"><h2>Results</h2>
    <table class="num"><thead><tr><th>Fan</th><th>Outcome</th><th class="r">Charged</th><th class="r">Released</th><th>PayPal</th><th>Note on receipt</th></tr></thead><tbody>
    ${sample
      .map(
        (x) => `<tr><td>${esc(x.buyer)}<div class="muted" style="font-size:12px">${esc(x.country)} · ${esc(x.language)}</div></td><td>${esc(ACTION[x.action])}</td><td class="r">${usd(x.capture_cents)}</td><td class="r">${usd(x.release_cents)}</td>
        <td style="font-size:12px">${x.capture_id ? `capture ${esc(x.capture_id)}` : esc(x.result)}</td><td style="font-size:12px;max-width:340px">${esc(x.note_to_payer || '')}</td></tr>`,
      )
      .join('')}</tbody></table>
    ${r.samples.length > sample.length ? `<p class="muted">Showing ${sample.length} of ${r.samples.length}.</p>` : ''}</div>`;
  main.appendChild(box);
}

await load();
