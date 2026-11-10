// AI layer. Five jobs, each a single model call that must return JSON matching a schema:
//   1. draftCampaign      creator's post + factory quote (any language) -> structured campaign
//   2. answerFan          fan question in any language -> grounded answer in that language
//   3. recommendSettlement computed scenarios + creator's own words -> go / no-go per option
//   4. noteTemplates      per-language payer notes with placeholders (code fills the amounts)
//   5. matchShipments     carrier export rows -> pledges, across scripts and spellings
// The model never produces an amount that is sent to PayPal. Every output is checked here
// before the app uses it, and falls back to rules when a check fails.
// The model is a deployment in Azure OpenAI, called through the v1 Chat Completions API with
// structured outputs (response_format json_schema, strict). See server/config.js for the .env settings.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import * as mock from './ai-mock.js';

export class AiError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'AiError';
    this.detail = detail;
  }
}

export function chatRequest({ name, system, user, schema, effort, maxTokens }) {
  return {
    model: config.azure.deployment,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
    reasoning_effort: effort,
    max_completion_tokens: maxTokens,
  };
}

// One line per model call in <data>/ai-calls.jsonl: job, time, tokens. Used to report usage.
function logCall(entry) {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.appendFileSync(path.join(config.dataDir, 'ai-calls.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // usage logging must never break a request
  }
}

async function postWithRetry(url, init, waits = [1000, 4000]) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(180000) });
    } catch (e) {
      if (i >= waits.length) throw new AiError(`Azure OpenAI could not be reached: ${e.message}`);
      await new Promise((r) => setTimeout(r, waits[i]));
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && i < waits.length) {
      const after = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, after > 0 && after < 30 ? after * 1000 : waits[i]));
      continue;
    }
    return res;
  }
}

async function modelJson({ name, system, user, schema, effort = 'medium', maxTokens = 16000 }) {
  const started = Date.now();
  const res = await postWithRetry(`${config.azure.baseUrl}chat/completions`, {
    method: 'POST',
    headers: { 'api-key': config.azure.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(chatRequest({ name, system, user, schema, effort, maxTokens })),
  });
  const body = await res.json().catch(() => ({}));
  const usage = body.usage || {};
  const meta = {
    mode: 'azure-openai',
    model: body.model || config.modelLabel,
    ms: Date.now() - started,
    input_tokens: usage.prompt_tokens,
    output_tokens: usage.completion_tokens,
    reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
  };
  const fail = (message, detail) => {
    logCall({ job: name, ok: false, error: message, ...meta });
    const e = new AiError(message, detail);
    e.status = res.status;
    return e;
  };
  if (!res.ok) {
    const err = body.error || {};
    if (err.code === 'content_filter') throw fail('Azure content filtering blocked this request', err);
    throw fail(`Azure OpenAI returned HTTP ${res.status}${err.code ? ` ${err.code}` : ''}: ${err.message || 'no message'}`, err);
  }
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) throw fail('The model declined this request', choice.message.refusal);
  if (choice?.finish_reason === 'length') throw fail('The model output was cut off (max_completion_tokens)');
  if (choice?.finish_reason === 'content_filter') throw fail('Azure content filtering stopped the reply');
  let data;
  try {
    data = JSON.parse(choice?.message?.content ?? '');
  } catch {
    throw fail('The model returned text that is not valid JSON');
  }
  logCall({ job: name, ok: true, ...meta });
  return { data, meta };
}

const str = { type: 'string' };
const int = { type: 'integer' };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

// ---------- 1. campaign draft ----------

const CAMPAIGN_SCHEMA = obj({
  title: str,
  creator_name: str,
  summary_en: str,
  duration_days: int,
  ship_estimate_en: str,
  options: {
    type: 'array',
    items: obj({
      id: str,
      name_original: str,
      name_en: str,
      description_en: str,
      price_usd: { type: 'string', description: 'Overseas price in USD as written in the post, two decimals, e.g. "9.00"' },
      domestic_price_krw: { anyOf: [int, { type: 'null' }] },
      tiers: { type: 'array', items: obj({ min_qty: int, unit_cost_krw: int }) },
      fixed_cost_krw: int,
    }),
  },
  shipping_regions: {
    type: 'array',
    items: obj({ id: str, label_en: str, price_usd: str, countries: { type: 'array', items: str } }),
  },
  cost_basis: obj({ quote_includes_vat: { type: 'boolean' }, vat_rate: { type: 'number' } }),
  creator_preferences: { type: 'array', items: obj({ applies_to: { type: 'array', items: str }, text_en: str }) },
  questions_for_creator: { type: 'array', items: obj({ about: str, question_en: str }) },
});

const DRAFT_SYSTEM = `You turn a small creator's pre-order post and a factory quote into a structured pre-order campaign for fans abroad. The post and quote may be in any language (often Korean or Japanese).

Rules:
- Copy prices, quantities and costs exactly as written. Never invent a number that is not in the input.
- Option ids are A, B, C... in the order the post lists them.
- price_usd is the overseas USD price from the post, formatted like "9.00".
- tiers come from the factory quote: each price break as min_qty and unit_cost_krw. The lowest min_qty is the factory minimum.
- One-time costs such as mold or plate fees go in fixed_cost_krw, not in the unit cost.
- shipping_regions: one entry per shipping price in the post. List ISO 3166-1 alpha-2 codes for named regions, leaving out the creator's own country. The catch-all region ("everywhere else") has an empty countries list.
- If the quote says VAT is excluded, set quote_includes_vat false and vat_rate to the local VAT rate (Korea: 0.1).
- creator_preferences: restate, in English, anything the creator says about leftover stock, storage, risk or what sells elsewhere, with the option ids it applies to.
- questions_for_creator: anything ambiguous or missing that affects money (exchange rate, VAT, one-time fees, shipping rules). Ask, do not guess.
- summary_en: how ordering works for fans. PayPal holds the money at pre-order, and after the deadline only the items that go to the factory are charged; the creator may still make an item that falls short of its minimum.
- English text is for fans: plain, short, specific. No marketing words, no em dashes.`;

const NO_PAYPAL = new Set(['CU', 'IR', 'KP', 'SY']);

export function validateCampaignDraft(d) {
  const errors = [];
  const ids = new Set();
  if (!d.options?.length) errors.push('No options found');
  for (const o of d.options || []) {
    if (ids.has(o.id)) errors.push(`Duplicate option id ${o.id}`);
    ids.add(o.id);
    if (!/^\d+\.\d{2}$/.test(o.price_usd)) errors.push(`${o.id}: price_usd "${o.price_usd}" is not like 9.00`);
    if (!o.tiers?.length) errors.push(`${o.id}: no factory price tiers`);
    for (const t of o.tiers || []) if (!(t.min_qty > 0 && t.unit_cost_krw > 0)) errors.push(`${o.id}: bad tier ${JSON.stringify(t)}`);
    if (o.fixed_cost_krw < 0) errors.push(`${o.id}: negative fixed cost`);
  }
  if (!d.shipping_regions?.length) errors.push('No shipping regions found');
  for (const r of d.shipping_regions || []) {
    if (!/^\d+\.\d{2}$/.test(r.price_usd)) errors.push(`Region ${r.id}: price "${r.price_usd}" is not like 5.00`);
    // PayPal does not operate in these countries, so a model-written list must not offer shipping there.
    r.countries = (r.countries || []).map((c) => String(c).toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c) && !NO_PAYPAL.has(c));
  }
  if ((d.shipping_regions || []).filter((r) => r.countries.length === 0).length !== 1) {
    errors.push('Expected exactly one catch-all shipping region (empty country list)');
  }
  if (!(d.duration_days >= 1 && d.duration_days <= 29)) {
    errors.push(`Duration ${d.duration_days} days: PayPal authorizations last 29 days, so campaigns must be 1-29 days`);
  }
  return errors;
}

// ---------- 2. fan questions ----------

const FAN_SCHEMA = obj({ language: str, answer: str, forward_to_creator: { type: 'boolean' } });

const FAN_SYSTEM = `You answer questions from fans about one pre-order campaign. Answer in the language the fan wrote in, under 90 words.
Use only the campaign data and live totals you are given. How payment works, if relevant: PayPal places a hold (authorization) at pre-order. When the campaign closes, only items that are produced are captured, plus shipping once per order. The rest of the hold is released, so nothing needs a refund. Options below the factory minimum may still be produced if the creator decides so.
If the answer is not in the data, say you passed the question to the creator and set forward_to_creator to true. No marketing tone.`;

// Dollar amounts in a fan answer must be ones a cart in this campaign can add up to: up to three of
// each item plus at most one shipping price. Anything else is not shown to the fan; the question
// goes to the creator instead. This catches invented prices and fees, not every wrong sentence.
const NUM = '(\\d+(?:[.,]\\d{1,2})?)';
const AMOUNT_RE = new RegExp(
  `(?:US\\s?\\$|\\$|USD\\s?)\\s?${NUM}|${NUM}\\s?(?:\\$|USD\\b|US[-\\s]?dollars?|dollars?|米ドル|ドル|美元|美金|dólares?|dolares?|dollari|dolar|달러|ดอลลาร์)`,
  'gi',
);

export function fanAnswerAmounts(text) {
  const out = [];
  for (const m of String(text || '').normalize('NFKC').matchAll(AMOUNT_RE)) out.push(Math.round(Number((m[1] || m[2]).replace(',', '.')) * 100));
  return out;
}

export function cartAmounts(campaign, maxEach = 3) {
  const cents = (v) => Math.round(Number(v) * 100);
  // Grows one item at a time and keeps only distinct sums, so it stays small for any number of items.
  let sums = new Set([0]);
  for (const o of campaign.options) {
    const next = new Set();
    for (const a of sums) for (let q = 0; q <= maxEach; q++) next.add(a + q * cents(o.price_usd));
    sums = next;
  }
  const out = new Set();
  for (const a of sums) for (const sh of [0, ...campaign.shipping_regions.map((r) => cents(r.price_usd))]) out.add(a + sh);
  return out;
}

export function checkFanAnswer(campaign, answer) {
  const allowed = cartAmounts(campaign);
  const unknown = fanAnswerAmounts(answer).filter((c) => !allowed.has(c));
  return { ok: unknown.length === 0, unknown: unknown.map((c) => (c / 100).toFixed(2)) };
}

// Shown instead of a withheld answer, in the fan's language when we have it.
export const HANDOFF = {
  en: 'Thanks, I passed your question to the creator, who will reply to you directly.',
  ja: 'ご質問はクリエイターに伝えました。クリエイターから直接お返事します。',
  de: 'Danke, ich habe deine Frage an das Studio weitergegeben. Du bekommst direkt eine Antwort.',
  fr: 'Merci, ta question a été transmise au studio, qui te répondra directement.',
  es: 'Gracias, pasé tu pregunta al estudio, que te responderá directamente.',
  'zh-TW': '謝謝，你的問題已轉給創作者，創作者會直接回覆你。',
  ko: '질문은 작가에게 전달했어요. 작가가 직접 답해 드릴 거예요.',
  id: 'Terima kasih, pertanyaanmu sudah diteruskan ke kreator, yang akan menjawab langsung.',
};

// ---------- 3. settlement recommendation ----------

const SETTLE_SCHEMA = obj({
  options: {
    type: 'array',
    items: obj({
      option_id: str,
      action: { type: 'string', enum: ['produce', 'cancel'] },
      order_qty: { type: 'integer', description: 'One of the scenario order_qty values for this option, or 0 when cancelling' },
      headline: str,
      reasoning: str,
    }),
  },
  summary: str,
});

const SETTLE_SYSTEM = `You help a small creator decide which pre-order options to send to the factory when the campaign closes.
For each option you get computed scenarios: order quantity, factory cost in KRW including VAT, estimated profit in KRW after a payment-fee allowance, and leftover units the creator would keep. You also get the creator's own words about storage and risk.
For every option with pledges, choose: produce at one of that option's scenario order_qty values, or cancel. You may not use any other quantity. Producing fewer units than pledged is not possible.
Weigh profit against leftover stock and the creator's stated limits. Cancelling an option releases fans' holds for it; nobody is charged for it.
Per option, write a one-line headline that starts with the action (no option letter, no dashes) and two or three plain sentences of reasoning that cite the numbers you were given. Never invent numbers. Then a two-sentence summary.`;

export function checkRecommendation(economics, rec) {
  const out = {};
  const problems = [];
  for (const e of economics) {
    if (e.pledged_qty === 0) continue;
    const r = rec.options?.find((x) => x.option_id === e.option_id);
    const allowed = new Set(e.scenarios.map((s) => s.order_qty));
    if (!r) {
      problems.push(`${e.option_id}: no recommendation`);
      continue;
    }
    if (r.action === 'produce' && !allowed.has(r.order_qty)) {
      problems.push(`${e.option_id}: order_qty ${r.order_qty} is not one of the computed scenarios`);
      continue;
    }
    out[e.option_id] = { action: r.action, order_qty: r.action === 'produce' ? r.order_qty : 0, headline: r.headline, reasoning: r.reasoning };
  }
  return { decisions: out, problems };
}

// ---------- 4. payer note templates ----------

const NOTES_SCHEMA = obj({
  templates: {
    type: 'array',
    items: obj({
      language: str,
      item_names: { type: 'array', items: obj({ option_id: str, name: str }) },
      note_capture_full: str,
      note_capture_partial: str,
      message_capture_full: str,
      message_capture_partial: str,
      message_void: str,
    }),
  },
});

export const REQUIRED_PLACEHOLDERS = {
  note_capture_full: ['{captured}', '{confirmed_items}'],
  note_capture_partial: ['{captured}', '{released}', '{cancelled_items}', '{confirmed_items}'],
  message_capture_full: ['{captured}', '{confirmed_items}'],
  message_capture_partial: ['{captured}', '{released}', '{cancelled_items}', '{confirmed_items}'],
  message_void: ['{released}', '{cancelled_items}'],
};

const NOTES_SYSTEM = `Write the short texts that tell pre-order fans what happened when a campaign closed, once per requested language.
Use these placeholders exactly; code fills them in later: {creator}, {confirmed_items}, {cancelled_items}, {captured}, {released}.
Never write an amount, a currency symbol or an item quantity yourself.
Each field must contain these placeholders (a template without them is rejected and the fan gets a plain English text instead):
${Object.entries(REQUIRED_PLACEHOLDERS).map(([f, ph]) => `- ${f}: ${ph.join(' ')}`).join('\n')}
- note_capture_full / note_capture_partial go into PayPal's note_to_payer field on the capture. Keep note_capture_full under 120 characters and note_capture_partial under 170 characters as written, placeholders included.
- message_capture_full / message_capture_partial / message_void are longer messages the creator sends by email or DM.
- Make clear that released money was never charged, so there is no refund to wait for.
Also give each item a short name in that language (item_names). Plain, warm, factual. No marketing words.`;

const MONEY_RE = /[$€¥₩£]|\b(USD|KRW|JPY|EUR)\b|\d+[.,]\d{2}\b|\d\s*(dollars?|ドル|円|美元|元|dólares?|dolar|euros?|원|달러)/i;

export function checkTemplate(t) {
  const problems = [];
  for (const [field, needs] of Object.entries(REQUIRED_PLACEHOLDERS)) {
    const text = t[field] || '';
    for (const ph of needs) if (!text.includes(ph)) problems.push(`${t.language}.${field} is missing ${ph}`);
    if (MONEY_RE.test(text.replace(/\{[a-z_]+\}/g, ''))) problems.push(`${t.language}.${field} contains a written amount`);
  }
  if ((t.note_capture_partial || '').length > 180) problems.push(`${t.language}.note_capture_partial is too long for note_to_payer`);
  return problems;
}

// ---------- 5. shipment matching ----------

const MATCH_SCHEMA = obj({
  matches: {
    type: 'array',
    items: obj({
      row: int,
      pledge_id: { anyOf: [str, { type: 'null' }] },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      reason: str,
    }),
  },
});

const MATCH_SYSTEM = `Match rows from a Korea Post bulk shipping export to pre-order pledges.
Recipient names may be romanized differently, in a different order, written in Japanese or Chinese script, upper-case, or have a typo. Addresses may be shortened.
Use name, country and postal code together. Return one entry per row. pledge_id is null when no candidate fits.
confidence: high only when name and postal code both agree; medium when one agrees and the other plausibly refers to the same person; low otherwise.
Never match two rows to the same pledge. When one person has several pledges, use the row's contents and the pledge's items (option letter x quantity) to tell them apart.
reason: one short sentence.`;

export function checkMatches(rows, candidates, result) {
  const byId = new Map(candidates.map((c) => [c.pledge_id, c]));
  const used = new Set();
  const out = [];
  for (const r of rows) {
    const m = result.matches?.find((x) => x.row === r.row);
    let pledge_id = m?.pledge_id ?? null;
    let confidence = m?.confidence || 'low';
    let reason = m?.reason || 'No match returned';
    if (pledge_id && !byId.has(pledge_id)) {
      reason = `Model returned unknown pledge ${pledge_id}`;
      pledge_id = null;
      confidence = 'low';
    } else if (pledge_id && byId.get(pledge_id).country !== r.country) {
      reason = `Country mismatch (${r.country} vs ${byId.get(pledge_id).country})`;
      pledge_id = null;
      confidence = 'low';
    } else if (pledge_id && used.has(pledge_id)) {
      reason = 'Pledge already matched to another row';
      pledge_id = null;
      confidence = 'low';
    }
    if (pledge_id) used.add(pledge_id);
    out.push({ row: r.row, pledge_id, confidence, reason });
  }
  return out;
}

// ---------- public API ----------

export const ai = {
  get mode() {
    return config.aiMode;
  },

  async draftCampaign({ postText, quoteText }) {
    if (config.aiMode === 'mock') return mock.draftCampaign({ postText, quoteText });
    const r = await modelJson({
      name: 'campaign_draft',
      system: DRAFT_SYSTEM,
      user: `<creator_post>\n${postText}\n</creator_post>\n\n<factory_quote>\n${quoteText}\n</factory_quote>`,
      schema: CAMPAIGN_SCHEMA,
    });
    return r;
  },

  async answerFan({ campaign, totals, question }) {
    if (config.aiMode === 'mock') return mock.answerFan({ campaign, totals, question });
    const facts = publicFacts(campaign, totals);
    return modelJson({
      name: 'fan_answer',
      system: FAN_SYSTEM,
      user: `<campaign>\n${JSON.stringify(facts)}\n</campaign>\n\n<fan_question>\n${question}\n</fan_question>`,
      schema: FAN_SCHEMA,
      effort: 'low',
      maxTokens: 4000,
    });
  },

  async recommendSettlement({ campaign, economics }) {
    if (config.aiMode === 'mock') return mock.recommendSettlement({ campaign, economics });
    const input = {
      creator_preferences: campaign.creator_preferences,
      cost_basis: campaign.cost_basis,
      options: economics
        .filter((e) => e.pledged_qty > 0)
        .map((e) => ({
          option_id: e.option_id,
          name: e.name_en,
          factory_minimum: e.moq,
          pledged_qty: e.pledged_qty,
          price_usd: (e.price_cents / 100).toFixed(2),
          fixed_cost_krw: campaign.options.find((o) => o.id === e.option_id).fixed_cost_krw,
          scenarios: e.scenarios.map((s) => ({ order_qty: s.order_qty, cost_krw: s.cost_krw, est_profit_krw: s.profit_krw, leftover_units: s.leftover_units })),
        })),
    };
    return modelJson({ name: 'settlement_recommendation', system: SETTLE_SYSTEM, user: JSON.stringify(input), schema: SETTLE_SCHEMA });
  },

  async noteTemplates({ campaign, languages }) {
    if (config.aiMode === 'mock') return mock.noteTemplates({ campaign, languages });
    const input = {
      creator: campaign.creator_name,
      ship_estimate_en: campaign.ship_estimate_en,
      items: campaign.options.map((o) => ({ option_id: o.id, name_en: o.name_en })),
      languages,
    };
    const r = await modelJson({ name: 'payer_note_templates', system: NOTES_SYSTEM, user: JSON.stringify(input), schema: NOTES_SCHEMA });
    r.data.templates = r.data.templates.map((t) => ({ ...t, item_names: Object.fromEntries(t.item_names.map((x) => [x.option_id, x.name])) }));
    return r;
  },

  async matchShipments({ rows, candidates }) {
    if (config.aiMode === 'mock') return mock.matchShipments({ rows, candidates });
    // 40 rows per call keeps each reply well inside the output limit of a non-streaming request.
    // Each chunk only sees pledges from the countries in that chunk.
    const chunks = [];
    for (let i = 0; i < rows.length; i += 40) chunks.push(rows.slice(i, i + 40));
    const results = await Promise.all(
      chunks.map((chunk) => {
        const countries = new Set(chunk.map((r) => r.country));
        const cands = candidates.filter((c) => countries.has(c.country));
        return modelJson({
          name: 'shipment_matches',
          system: MATCH_SYSTEM,
          user: `<export_rows>\n${JSON.stringify(chunk)}\n</export_rows>\n\n<pledges>\n${JSON.stringify(cands)}\n</pledges>`,
          schema: MATCH_SCHEMA,
          effort: 'low',
        });
      }),
    );
    return {
      data: { matches: results.flatMap((r) => r.data.matches || []) },
      meta: { ...results[0].meta, calls: results.length, ms: Math.max(...results.map((r) => r.meta.ms)) },
    };
  },
};

export function publicFacts(campaign, totals) {
  return {
    title: campaign.title,
    creator: campaign.creator_name,
    summary: campaign.summary_en,
    closes_at: campaign.closes_at,
    ships: campaign.ship_estimate_en,
    options: campaign.options.map((o) => ({
      id: o.id,
      name: o.name_en,
      description: o.description_en,
      price_usd: o.price_usd,
      factory_minimum: o.tiers.map((t) => t.min_qty).sort((a, b) => a - b)[0],
      pledged_so_far: totals?.[o.id]?.qty ?? null,
    })),
    shipping: campaign.shipping_regions.map((r) => ({ region: r.label_en, price_usd: r.price_usd, countries: r.countries.length ? r.countries : 'all other countries' })),
  };
}
