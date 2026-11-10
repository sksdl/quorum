import { api, esc, header, aiTag, busy, krw } from '/js/common.js';

await header({ active: 'new' });
let draft = null;

if (new URLSearchParams(location.search).get('lang') === 'en') document.getElementById('demo').textContent = 'Use the demo post (English translation)';
document.getElementById('demo').addEventListener('click', async () => {
  // ?lang=en on the page URL loads the English translations of the sample post and quote.
  const d = await api(`/api/demo-inputs${new URLSearchParams(location.search).get('lang') === 'en' ? '?lang=en' : ''}`);
  document.getElementById('post').value = d.post_text;
  document.getElementById('quote').value = d.quote_text;
});

document.getElementById('draft').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const m = document.getElementById('draft-msg');
  m.textContent = '';
  busy(btn, true, 'Reading the post and quote');
  try {
    const r = await api('/api/ai/draft-campaign', { body: { post_text: document.getElementById('post').value, quote_text: document.getElementById('quote').value } });
    draft = r.draft;
    render(r);
  } catch (err) {
    m.innerHTML = `<span class="err">${esc(err.message)}</span>`;
  } finally {
    busy(btn, false);
  }
});

function render(r) {
  const d = r.draft;
  document.getElementById('s1').className = 'done';
  document.getElementById('s2').className = 'on';
  document.getElementById('review').classList.remove('hidden');
  document.getElementById('d-ai').innerHTML = aiTag(r.ai, 'Drafted by AI');
  document.getElementById('d-title').textContent = `${d.title} · ${d.creator_name}`;
  document.getElementById('d-summary').textContent = d.summary_en;
  document.getElementById('d-days').textContent = d.duration_days;
  document.getElementById('d-ship').textContent = d.ship_estimate_en;
  document.getElementById('d-errors').innerHTML = r.errors.length ? `<div class="note warn"><b>Fix before publishing:</b><br>${r.errors.map(esc).join('<br>')}</div>` : '';
  document.getElementById('d-options').innerHTML = d.options
    .map(
      (o) => `<tr><td><b>${esc(o.id)}</b> ${esc(o.name_en)}<br><small>${esc(o.name_original)}</small></td>
      <td class="r num">$${esc(o.price_usd)}</td>
      <td class="tiers num">${o.tiers.map((t) => `${t.min_qty}+: ${krw(t.unit_cost_krw)}`).join('<br>')}${o.fixed_cost_krw ? `<br>one-time: ${krw(o.fixed_cost_krw)}` : ''}</td></tr>`,
    )
    .join('');
  document.getElementById('d-regions').innerHTML = d.shipping_regions
    .map((x) => `<tr><td>${esc(x.label_en)}<br><small>${x.countries.length ? esc(x.countries.join(' ')) : 'all other countries'}</small></td><td class="r num">$${esc(x.price_usd)}</td></tr>`)
    .join('');
  document.getElementById('d-prefs').innerHTML = d.creator_preferences.map((p) => `<li>${esc(p.text_en)} <small>(${esc(p.applies_to.join(', '))})</small></li>`).join('');
  document.getElementById('d-questions').innerHTML = d.questions_for_creator
    .map((q, i) => `<label class="q"><input type="checkbox" data-q="${i}"> <span>${esc(q.question_en)}</span></label>`)
    .join('') || '<p class="muted">None.</p>';
  document.getElementById('vat').value = d.cost_basis.quote_includes_vat ? 'inc' : 'ex';
  syncPublish(r.errors.length === 0);
  document.getElementById('d-questions').addEventListener('change', () => syncPublish(r.errors.length === 0));
  document.getElementById('review').scrollIntoView({ behavior: 'smooth' });
}

function syncPublish(valid) {
  const boxes = [...document.querySelectorAll('#d-questions input[type=checkbox]')];
  const all = boxes.every((b) => b.checked);
  document.getElementById('publish').disabled = !(valid && all);
  document.getElementById('s3').className = valid && all ? 'on' : '';
}

document.getElementById('publish').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  busy(btn, true, 'Publishing');
  try {
    const vatInc = document.getElementById('vat').value === 'inc';
    const body = {
      draft: { ...draft, cost_basis: { ...draft.cost_basis, quote_includes_vat: vatInc, vat_rate: vatInc ? 0 : draft.cost_basis.vat_rate || 0.1 } },
      fx_krw_per_usd: Number(document.getElementById('fx').value),
      fee_rate: Number(document.getElementById('fee').value),
      post_text: document.getElementById('post').value,
      quote_text: document.getElementById('quote').value,
    };
    const r = await api('/api/campaigns', { body });
    location.href = `/studio/${r.slug}`;
  } catch (err) {
    document.getElementById('pub-msg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
    busy(btn, false);
  }
});
