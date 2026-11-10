// MOCK AI
// Used when no Azure OpenAI settings are in .env. It returns sample outputs for the demo data
// (hand-written for the demo data, not captured from a model) and plain rules elsewhere,
// so every screen works offline. Results carry
// meta.mode = "mock" and the UI labels them. With a key, server/ai.js calls the Azure OpenAI deployment instead.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { fmtKrw } from './money.js';

const FIX = path.join(ROOT, 'fixtures');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const meta = (note) => ({ mode: 'mock', model: 'mock', note });
const squash = (s) => String(s || '').replace(/\s+/g, '');

export class MockAiError extends Error {}

export function draftCampaign({ postText, quoteText }) {
  if (squash(postText) !== squash(read('demo-post-ko.txt')) || squash(quoteText) !== squash(read('factory-quote-ko.txt'))) {
    throw new MockAiError('MOCK AI only has a sample draft for the demo post and quote. Add Azure OpenAI settings to .env (see .env.example) to draft any post.');
  }
  return { data: JSON.parse(read('ai-mock/campaign-draft.json')), meta: meta('Sample draft written for the demo post; real mode asks the model') };
}

const FAN_ANSWERS = [
  {
    test: /バッジ|キーホルダー/,
    language: 'ja',
    answer:
      'バッジが最低製作数（100個）に届かなかった場合、バッジは製作せず、その分は請求されません。キーホルダーが製作されれば、キーホルダー代と送料だけが請求され、残りの保留は解除されます。もともと請求されていないお金なので、返金を待つ必要はありません。',
  },
  {
    test: /canada|ship.*cost|shipping/i,
    language: 'en',
    answer:
      'Yes. Canada is in the Americas and Oceania region, so shipping is $7.00 per order, charged once however many items you get. Everything ships together at the end of November by Korea Post K-Packet.',
  },
  {
    test: /cobr|pago|cuándo/i,
    language: 'es',
    answer:
      'Al reservar no se cobra nada: PayPal solo retiene el monto. Cuando cierre la preventa, se cobra únicamente lo que se va a fabricar más el envío, y el resto de la retención se libera.',
  },
];

export function answerFan({ question }) {
  const hit = FAN_ANSWERS.find((a) => a.test.test(question));
  if (hit) return { data: { language: hit.language, answer: hit.answer, forward_to_creator: false }, meta: meta('Sample answer written for the demo; real mode asks the model') };
  return {
    data: {
      language: 'en',
      answer: 'This is not covered in the campaign details, so I passed your question to the creator.',
      forward_to_creator: true,
    },
    meta: meta('No sample answer for this question; real mode answers any question in the fan\'s language'),
  };
}

// Rule-based stand-in for the AI recommendation, written the way the model is asked to write.
export function recommendSettlement({ campaign, economics }) {
  const maxLeft = 10;
  const options = [];
  for (const e of economics) {
    if (e.pledged_qty === 0) continue;
    const base = e.scenarios[0];
    const cheaper = e.cheaper_bigger_order;
    const okLeftover = (campaign.creator_preferences || []).some((p) => p.applies_to.includes(e.option_id) && /fine|sell at events/i.test(p.text_en));
    if (cheaper) {
      options.push({
        option_id: e.option_id,
        action: 'produce',
        order_qty: cheaper.order_qty,
        headline: `Order ${cheaper.order_qty}: it costs less than ${base.order_qty}.`,
        reasoning: `${e.pledged_qty} pledged. ${cheaper.order_qty} units cost ${fmtKrw(cheaper.cost_krw)} against ${fmtKrw(base.cost_krw)} for ${base.order_qty}, because the bigger tier is cheaper per unit. You keep ${cheaper.leftover_units} spare${okLeftover ? ', and you said these sell at events' : ''}.`,
      });
    } else if (e.status === 'met') {
      options.push({
        option_id: e.option_id,
        action: 'produce',
        order_qty: base.order_qty,
        headline: `Produce ${base.order_qty}, minimum met.`,
        reasoning: `${e.pledged_qty} pledged against a minimum of ${e.moq}. Estimated profit ${fmtKrw(base.profit_krw)} with no leftover stock.`,
      });
    } else if (base.profit_krw > 0 && base.leftover_units <= maxLeft) {
      options.push({
        option_id: e.option_id,
        action: 'produce',
        order_qty: base.order_qty,
        headline: `Produce ${base.order_qty} even though ${e.shortfall} short.`,
        reasoning: `${e.pledged_qty} pledged, minimum ${e.moq}. Ordering the minimum still leaves an estimated profit of ${fmtKrw(base.profit_krw)} and only ${base.leftover_units} spare, within the ${maxLeft}-unit storage limit you gave.`,
      });
    } else {
      options.push({
        option_id: e.option_id,
        action: 'cancel',
        order_qty: 0,
        headline: `Cancel: ${e.shortfall} short and ${base.profit_krw < 0 ? 'loses money' : 'too much stock'}.`,
        reasoning: `${e.pledged_qty} pledged, minimum ${e.moq}. Producing ${base.order_qty} costs ${fmtKrw(base.cost_krw)} and gives an estimated ${fmtKrw(base.profit_krw)} with ${base.leftover_units} units left over. Fans' holds for this item are released.`,
      });
    }
  }
  const go = options.filter((o) => o.action === 'produce').length;
  return {
    data: {
      options,
      summary: `${go} of ${options.length} options go to the factory. The rest are cancelled and those holds are released, so no refunds are needed.`,
    },
    meta: meta('Rule-based text; real mode has the model weigh the numbers and your notes'),
  };
}

export function noteTemplates({ languages }) {
  const all = JSON.parse(read('ai-mock/note-templates.json')).templates;
  const en = all.find((t) => t.language === 'en');
  const templates = languages.map((lang) => all.find((t) => t.language === lang) || { ...en, language: lang, _fallback: 'English' });
  return { data: { templates }, meta: meta('Pre-written templates for 7 languages; other languages fall back to English') };
}

// Deterministic matcher: same country, then postal code, then name tokens in any order.
export function matchShipments({ rows, candidates }) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
  const zip = (s) => String(s || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  const matches = rows.map((r) => {
    const same = candidates.filter((c) => c.country === r.country);
    const byZip = same.filter((c) => zip(c.postal_code) && zip(c.postal_code) === zip(r.postal_code));
    const byName = same.filter((c) => norm(c.name) === norm(r.recipient) || norm(c.shipping_name) === norm(r.recipient));
    let both = byZip.filter((c) => byName.includes(c));
    // The same fan with several pledges: the parcel contents decide.
    if (both.length > 1) both = both.filter((c) => c.items && String(r.contents || '').includes(c.items));
    if (both.length === 1) return { row: r.row, pledge_id: both[0].pledge_id, confidence: 'high', reason: 'Name and postal code match' };
    if (byZip.length === 1) return { row: r.row, pledge_id: byZip[0].pledge_id, confidence: 'medium', reason: 'Postal code matches; name is written differently' };
    if (byName.length === 1) return { row: r.row, pledge_id: byName[0].pledge_id, confidence: 'medium', reason: 'Name matches; postal code differs' };
    return { row: r.row, pledge_id: null, confidence: 'low', reason: 'No unique candidate (mock matcher cannot read names in other scripts)' };
  });
  return { data: { matches }, meta: meta('Rule-based matcher; real mode lets the model match names across scripts and spellings') };
}
