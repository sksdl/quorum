// Settlement: turn the creator's go / no-go decisions into PayPal captures and voids.
import { ai, checkRecommendation, checkTemplate } from './ai.js';
import { campaignEconomics, defaultDecisions, normalizeDecisions, planSettlement, guardPlan } from './engine.js';
import { fmtUsd } from './money.js';
import { newId } from './store.js';

const BASIC_EN = {
  language: 'en',
  item_names: {},
  note_capture_full: '{creator} pre-order. Charged {captured} for {confirmed_items} and shipping.',
  note_capture_partial: '{creator} pre-order. Not made: {cancelled_items}. Charged {captured} for {confirmed_items} and shipping. Released {released}.',
  message_capture_full: 'Update from {creator}: everything you pre-ordered is being made. PayPal charged {captured} for {confirmed_items} and shipping.',
  message_capture_partial: 'Update from {creator}: {cancelled_items} will not be made this time. PayPal charged {captured} for {confirmed_items} and shipping, and released {released}. That part was never charged.',
  message_void: 'Update from {creator}: {cancelled_items} will not be made this time. Your hold of {released} was released and you were not charged.',
};

export function languageOf(locale) {
  const l = String(locale || 'en');
  if (/^zh-(TW|HK|Hant)/i.test(l)) return 'zh-TW';
  return l.split('-')[0].toLowerCase();
}

// Step 1: numbers, AI recommendation and payer-note templates. Nothing moves yet.
export async function draftSettlement({ campaign, pledges }) {
  const economics = campaignEconomics(campaign, pledges);
  const rules = defaultDecisions(economics);
  const languages = [...new Set(pledges.filter((p) => p.status === 'held').map((p) => languageOf(p.buyer.locale)))];
  const [rec, notes] = await Promise.allSettled([ai.recommendSettlement({ campaign, economics }), getTemplates(campaign, languages)]);

  let recommendation = null;
  let aiMeta = null;
  let problems = [];
  if (rec.status === 'fulfilled') {
    aiMeta = rec.value.meta;
    const checked = checkRecommendation(economics, rec.value.data);
    problems = checked.problems;
    recommendation = { summary: rec.value.data.summary, options: checked.decisions };
  } else {
    problems = [`AI recommendation unavailable: ${rec.reason?.message}`];
  }
  const tpl = notes.status === 'fulfilled' ? notes.value : { templates: {}, meta: null, problems: [`AI templates unavailable: ${notes.reason?.message}`] };

  // Start from the AI's picks where they passed the checks, rules elsewhere.
  const decisions = { ...rules };
  for (const [id, d] of Object.entries(recommendation?.options || {})) decisions[id] = { action: d.action, order_qty: d.order_qty };
  return { economics, rules, recommendation, ai: aiMeta, problems, decisions, templates: tpl.templates, notes_ai: tpl.meta, template_problems: tpl.problems, languages };
}

async function getTemplates(campaign, languages) {
  const r = await ai.noteTemplates({ campaign, languages });
  const templates = {};
  const problems = [];
  for (const t of r.data.templates) {
    const p = checkTemplate(t);
    if (p.length) problems.push(...p);
    else templates[t.language] = t;
  }
  return { templates, meta: r.meta, problems };
}

export function templateFor(templates, lang) {
  if (templates?.[lang]) return templates[lang];
  return { ...(templates?.en || BASIC_EN), language: lang, _fallback: 'English' };
}

// A few filled-in notes so the creator reads exactly what fans will see before approving.
export function sampleTexts({ campaign, plan, templates }) {
  const picks = [];
  const seen = new Set();
  for (const action of ['capture_partial', 'void', 'capture_full']) {
    for (const row of plan.rows) {
      const lang = languageOf(row.buyer.locale);
      if (row.action !== action || seen.has(lang)) continue;
      seen.add(lang);
      picks.push({ pledge_id: row.pledge_id, buyer: row.buyer.name, action, ...textsForRow({ campaign, row, template: templateFor(templates, lang) }) });
      if (picks.filter((p) => p.action === action).length >= 2) break;
    }
  }
  return picks;
}

export function previewSettlement({ campaign, pledges, decisions }) {
  const economics = campaignEconomics(campaign, pledges);
  const d = normalizeDecisions(campaign, economics, decisions);
  const plan = planSettlement(campaign, pledges, d);
  const guard = guardPlan(campaign, pledges, d, plan);
  return { decisions: d, plan, guard };
}

function itemList(lines, campaign, names, lang) {
  const sep = ['ja', 'zh-TW', 'zh'].includes(lang) ? '、' : ', ';
  return lines
    .map((l) => `${names?.[l.option_id] || campaign.options.find((o) => o.id === l.option_id).name_en} ×${l.qty}`)
    .join(sep);
}

export function fillTemplate(text, vars) {
  return text.replace(/\{([a-z_]+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m));
}

export function textsForRow({ campaign, row, template }) {
  const lang = template.language;
  const vars = {
    creator: campaign.creator_name,
    captured: `US${fmtUsd(row.capture_cents)}`,
    released: `US${fmtUsd(row.release_cents)}`,
    confirmed_items: itemList(row.confirmed, campaign, template.item_names, lang),
    cancelled_items: itemList(row.cancelled, campaign, template.item_names, lang),
  };
  const kind = row.action;
  let note = null;
  if (kind !== 'void') {
    note = fillTemplate(kind === 'capture_full' ? template.note_capture_full : template.note_capture_partial, vars);
    if (note.length > 255) note = `${note.slice(0, 252)}...`;
  }
  const message = fillTemplate(
    kind === 'capture_full' ? template.message_capture_full : kind === 'capture_partial' ? template.message_capture_partial : template.message_void,
    vars,
  );
  return { language: lang, fallback: template._fallback || null, note_to_payer: note, message };
}

// Step 2: after the creator approves. Guard checks first; if any fails, nothing is sent.
export async function executeSettlement({ store, paypal, campaign, decisions, recommendation, draftTemplates }) {
  const pledges = store.pledges(campaign.slug);
  const { decisions: d, plan, guard } = previewSettlement({ campaign, pledges, decisions });
  if (!guard.ok) {
    const failed = guard.checks.filter((c) => !c.ok).map((c) => c.name).join('; ');
    throw new Error(`Guard checks failed, nothing was sent to PayPal: ${failed}`);
  }

  let templates = draftTemplates?.templates;
  let notesMeta = draftTemplates?.meta || null;
  let templateProblems = draftTemplates?.problems || [];
  if (!templates) {
    const languages = [...new Set(plan.rows.map((r) => languageOf(r.buyer.locale)))];
    try {
      const t = await getTemplates(campaign, languages);
      templates = t.templates;
      notesMeta = t.meta;
      templateProblems = t.problems;
    } catch (e) {
      templates = {};
      templateProblems = [`AI templates unavailable: ${e.message}`];
    }
  }

  const settlement = {
    id: newId('stl'),
    started_at: new Date().toISOString(),
    decisions: d,
    totals: plan.totals,
    production: plan.production,
    guard,
    recommendation: recommendation || null,
    notes_ai: notesMeta,
    template_problems: templateProblems,
    economics: campaignEconomics(campaign, pledges),
    preflight: null,
    results: [],
  };

  // Pre-flight: read every live authorization back from PayPal right before charging.
  // A hold that is no longer CREATED, or whose amount differs, is skipped and flagged.
  const live = plan.rows.filter((r) => !r.simulated);
  const preflight = { checked: live.length, problems: [] };
  const skip = new Map();
  await inBatches(live, 8, async (row) => {
    const p = store.pledge(row.pledge_id);
    try {
      const a = await withRetry(() => paypal.getAuthorization(p.paypal.authorization_id));
      const [w, f = ''] = String(a.amount?.value || '0').split('.');
      const cents = Number(w) * 100 + Number((f + '00').slice(0, 2));
      if (a.status !== 'CREATED') skip.set(row.pledge_id, `authorization is ${a.status}`);
      else if (cents !== row.authorized_cents || a.amount.currency_code !== 'USD') skip.set(row.pledge_id, `authorization amount ${a.amount.value} ${a.amount.currency_code}`);
    } catch (e) {
      skip.set(row.pledge_id, `could not read authorization: ${e.message}`);
    }
  });
  for (const [id, why] of skip) preflight.problems.push({ pledge_id: id, problem: why });
  settlement.preflight = preflight;
  store.log(campaign.slug, 'settle_start', `Settlement started: ${plan.totals.capture_full} full captures, ${plan.totals.capture_partial} partial, ${plan.totals.void} voids`);

  for (const row of plan.rows) {
    const pledge = store.pledge(row.pledge_id);
    const texts = textsForRow({ campaign, row, template: templateFor(templates, languageOf(row.buyer.locale)) });
    const result = { pledge_id: row.pledge_id, action: row.action, capture_cents: row.capture_cents, release_cents: row.release_cents, simulated: row.simulated, language: texts.language };
    try {
      if (skip.has(row.pledge_id)) {
        result.status = 'skipped';
        result.error = `Pre-flight: ${skip.get(row.pledge_id)}`;
        settlement.results.push(result);
        pledge.flags = [...new Set([...(pledge.flags || []), 'preflight_failed'])];
        store.putPledge(pledge);
        continue;
      }
      if (row.simulated) {
        result.status = 'simulated';
      } else if (row.action === 'void') {
        // PayPal voids a reauthorized hold only through the original authorization (CANNOT_BE_VOIDED otherwise).
        const voidId = pledge.paypal.previous_authorization_ids?.[0] || pledge.paypal.authorization_id;
        const out = await paypal.voidAuthorization(voidId, `qrm-void-${pledge.id}`);
        result.status = 'voided';
        result.paypal_status = out?.status || 'VOIDED';
      } else {
        const cap = await paypal.captureAuthorization(
          pledge.paypal.authorization_id,
          { cents: row.capture_cents, finalCapture: true, noteToPayer: texts.note_to_payer },
          `qrm-cap-${pledge.id}`,
        );
        result.status = 'captured';
        result.capture_id = cap.id;
        result.paypal_status = cap.status;
        pledge.paypal.capture_id = cap.id;
        pledge.paypal.capture_status = cap.status;
      }
      pledge.status = row.action === 'void' ? 'voided' : row.action === 'capture_full' ? 'captured' : 'partially_captured';
    } catch (e) {
      result.status = 'failed';
      result.error = e.message;
      result.paypal_issue = e.issue || null;
      pledge.status = 'capture_failed';
    }
    pledge.settlement = {
      settlement_id: settlement.id,
      action: row.action,
      confirmed: row.confirmed,
      cancelled: row.cancelled,
      capture_cents: row.capture_cents,
      release_cents: row.release_cents,
      note_to_payer: texts.note_to_payer,
      message: texts.message,
      language: texts.language,
      result: result.status,
      error: result.error || null,
    };
    store.putPledge(pledge);
    settlement.results.push(result);
  }

  settlement.finished_at = new Date().toISOString();
  const failed = settlement.results.filter((r) => r.status === 'failed' || r.status === 'skipped').length;
  campaign.status = 'settled';
  campaign.settlement = settlement;
  store.putCampaign(campaign);
  store.log(
    campaign.slug,
    'settle_done',
    `Settlement finished: captured ${fmtUsd(plan.totals.capture_cents)}, released ${fmtUsd(plan.totals.release_cents)}${failed ? `, ${failed} failed` : ''}`,
  );
  return settlement;
}

// A pre-flight read that fails on a network error, a 429 or a 5xx is tried again twice,
// so one dropped connection does not leave a fan's hold out of the settlement.
// A 4xx answer (for example 404) is final.
export async function withRetry(fn, waits = [400, 1500]) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const transient = !e.status || e.status === 429 || e.status >= 500;
      if (!transient || i >= waits.length) throw e;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}
