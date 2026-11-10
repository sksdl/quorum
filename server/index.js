import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';
import { Store, newId } from './store.js';
import { MockPayPal } from './mock-paypal.js';
import { createPayPal, buildOrderBody, readAuthorization } from './paypal.js';
import { ai, validateCampaignDraft, publicFacts, checkFanAnswer, HANDOFF } from './ai.js';
import { priceCart, optionTotals, campaignEconomics, authAge, regionForCountry, moqOf } from './engine.js';
import { draftSettlement, previewSettlement, executeSettlement, sampleTexts } from './settle.js';
import { matchExport, uploadTracking, demoExport } from './ship.js';
import { fmtUsd } from './money.js';

const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.csv': 'text/csv; charset=utf-8' };
const PAGES = [
  [/^\/$/, 'index.html'],
  [/^\/studio\/new$/, 'studio-new.html'],
  [/^\/c\/[a-z0-9-]+$/, 'campaign.html'],
  [/^\/c\/[a-z0-9-]+\/pledge\/[a-zA-Z0-9_]+$/, 'pledge.html'],
  [/^\/studio\/[a-z0-9-]+$/, 'dashboard.html'],
  [/^\/studio\/[a-z0-9-]+\/settle$/, 'settle.html'],
  [/^\/studio\/[a-z0-9-]+\/ship$/, 'ship.html'],
];

export const store = new Store(path.join(config.dataDir, 'quorum-db.json'));
export const mockPayPal = config.paypalMode === 'mock' ? new MockPayPal(path.join(config.dataDir, 'mock-paypal.json'), config.publicUrl) : null;
export const paypal = createPayPal({ base: config.paypalBase, clientId: config.paypalClientId, clientSecret: config.paypalClientSecret });

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function serveFile(res, file) {
  const ext = path.extname(file);
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  // Lets the PayPal popup talk back to this page (same header PayPal's v6 sample sets).
  if (ext === '.html') headers['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups';
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function slugify(s) {
  const base = String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'campaign';
  let slug = base;
  for (let i = 2; store.campaign(slug); i++) slug = `${base}-${i}`;
  return slug;
}

function mustCampaign(slug) {
  const c = store.campaign(slug);
  if (!c) throw new HttpError(404, 'Campaign not found');
  return c;
}

function publicCampaign(c) {
  const pledges = store.pledges(c.slug);
  const totals = optionTotals(c, pledges);
  const held = pledges.filter((p) => p.status === 'held');
  return {
    slug: c.slug,
    status: c.status,
    title: c.title,
    creator_name: c.creator_name,
    summary_en: c.summary_en,
    ship_estimate_en: c.ship_estimate_en,
    opens_at: c.opens_at,
    closes_at: c.closes_at,
    shipping_regions: c.shipping_regions,
    options: c.options.map((o) => ({
      id: o.id,
      name_en: o.name_en,
      description_en: o.description_en,
      price_usd: o.price_usd,
      image: o.image || null,
      moq: moqOf(o),
      pledged_qty: totals[o.id].qty,
      decision: c.settlement?.decisions?.[o.id]?.action || null,
    })),
    backers: held.length + pledges.filter((p) => ['captured', 'partially_captured', 'voided', 'capture_failed'].includes(p.status)).length,
  };
}

function studioView(c) {
  const pledges = store.pledges(c.slug);
  const now = Date.now();
  const held = pledges.filter((p) => p.status === 'held');
  return {
    campaign: c,
    public: publicCampaign(c),
    modes: { paypal: config.paypalMode, ai: config.aiMode },
    economics: campaignEconomics(c, pledges),
    pledges: pledges
      .filter((p) => p.status !== 'pending')
      .map((p) => ({ ...p, auth_age: authAge(p, now) }))
      .reverse(),
    counts: {
      held: held.length,
      live: held.filter((p) => !p.simulated).length,
      simulated: held.filter((p) => p.simulated).length,
      held_cents: held.reduce((s, p) => s + p.total_cents, 0),
      past_honor_period: held.filter((p) => !authAge(p, now)?.in_honor_period).length,
      live_past_honor_period: held.filter((p) => !p.simulated && !authAge(p, now)?.in_honor_period).length,
      pending: pledges.filter((p) => p.status === 'pending').length,
    },
    events: store.events(c.slug),
    mock_ledger: mockPayPal ? mockPayPal.ledger() : null,
  };
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = (re) => p.match(re);
  let g;

  if (req.method === 'GET' && p === '/api/status') {
    return json(res, 200, {
      paypal_mode: config.paypalMode,
      ai_mode: config.aiMode,
      model: config.modelLabel,
      paypal_client_id: config.paypalMode === 'sandbox' ? config.paypalClientId : null,
      campaigns: Object.values(store.data.campaigns).map((c) => ({ slug: c.slug, title: c.title, status: c.status, creator_name: c.creator_name })),
    });
  }

  if (req.method === 'GET' && p === '/api/demo-inputs') {
    // ?lang=en gives the English reference translations, without their first "Reference translation" line.
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'ko';
    const read = (name) => fs.readFileSync(path.join(ROOT, `fixtures/${name}-${lang}.txt`), 'utf8').replace(/^Reference translation[^\n]*\n+/, '');
    return json(res, 200, { post_text: read('demo-post'), quote_text: read('factory-quote') });
  }

  if (req.method === 'POST' && p === '/api/ai/draft-campaign') {
    const body = await readJson(req);
    if (!body.post_text?.trim() || !body.quote_text?.trim()) throw new HttpError(400, 'Paste both the post and the factory quote');
    try {
      const r = await ai.draftCampaign({ postText: body.post_text, quoteText: body.quote_text });
      return json(res, 200, { draft: r.data, errors: validateCampaignDraft(r.data), ai: r.meta });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }

  if (req.method === 'POST' && p === '/api/campaigns') {
    const body = await readJson(req);
    const d = body.draft;
    const errors = validateCampaignDraft(d || {});
    if (errors.length) throw new HttpError(400, errors.join('; '));
    const fx = Number(body.fx_krw_per_usd);
    const fee = Number(body.fee_rate);
    if (!(fx > 100 && fx < 10000)) throw new HttpError(400, 'Enter the KRW per USD rate you want to use for cost estimates');
    if (!(fee >= 0 && fee < 0.3)) throw new HttpError(400, 'Fee allowance must be between 0 and 0.3');
    const now = new Date();
    const c = {
      ...d,
      slug: slugify(`${d.creator_name} ${d.title}`),
      status: 'open',
      created_at: now.toISOString(),
      opens_at: now.toISOString(),
      closes_at: new Date(now.getTime() + d.duration_days * 86400000).toISOString(),
      cost_basis: { ...d.cost_basis, vat_rate: d.cost_basis.quote_includes_vat ? 0 : d.cost_basis.vat_rate, fx_krw_per_usd: fx, fee_rate: fee },
      options: d.options.map((o, i) => ({ ...o, image: o.image || `/img/item-${'abcd'[i] || 'a'}.svg` })),
      source: { post_text: body.post_text || null, quote_text: body.quote_text || null },
    };
    store.putCampaign(c);
    store.log(c.slug, 'published', `Campaign published (${c.options.length} options, closes in ${d.duration_days} days)`);
    return json(res, 201, { slug: c.slug });
  }

  if ((g = m(/^\/api\/campaigns\/([a-z0-9-]+)$/)) && req.method === 'GET') {
    return json(res, 200, { campaign: publicCampaign(mustCampaign(g[1])), modes: { paypal: config.paypalMode, ai: config.aiMode } });
  }

  if ((g = m(/^\/api\/campaigns\/([a-z0-9-]+)\/pledges$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    if (c.status !== 'open' || Date.now() > Date.parse(c.closes_at)) throw new HttpError(409, 'This campaign is closed');
    const body = await readJson(req);
    let cart;
    try {
      cart = priceCart(c, (body.lines || []).filter((l) => Number(l.qty) > 0), body.region_id);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    const pledge = {
      id: newId('plg'),
      campaign_slug: c.slug,
      status: 'pending',
      simulated: false,
      created_at: new Date().toISOString(),
      buyer: { locale: String(body.locale || 'en').slice(0, 12) },
      lines: cart.items.map(({ option_id, qty, unit_cents }) => ({ option_id, qty, unit_cents })),
      region_id: cart.region_id,
      item_cents: cart.item_cents,
      shipping_cents: cart.shipping_cents,
      total_cents: cart.total_cents,
      paypal: {},
    };
    const back = `${config.publicUrl}/c/${c.slug}`;
    const order = await paypal.createOrder(buildOrderBody({ campaign: c, pledge, returnUrl: `${back}?paypal=return`, cancelUrl: `${back}?paypal=cancel` }), `qrm-ord-${pledge.id}`);
    pledge.paypal.order_id = order.id;
    store.putPledge(pledge);
    const approve = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href || null;
    return json(res, 201, { pledge_id: pledge.id, order_id: order.id, total: fmtUsd(cart.total_cents), approve_url: config.paypalMode === 'mock' ? approve : null });
  }

  if ((g = m(/^\/api\/campaigns\/([a-z0-9-]+)\/pledges\/([A-Z0-9]+)\/authorize$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    const pledge = store.pledgeByOrder(g[2]);
    if (!pledge || pledge.campaign_slug !== c.slug) throw new HttpError(404, 'Pledge not found');
    if (pledge.status !== 'pending') return json(res, 200, { pledge_id: pledge.id, status: pledge.status, total: fmtUsd(pledge.total_cents) });
    const order = await paypal.authorizeOrder(g[2], `qrm-auth-${pledge.id}`);
    const a = readAuthorization(order);
    pledge.paypal = { ...pledge.paypal, ...a };
    pledge.status = a.authorization_status === 'CREATED' ? 'held' : 'auth_' + a.authorization_status.toLowerCase();
    const country = a.shipping?.address?.country_code || null;
    pledge.buyer = { ...pledge.buyer, name: a.shipping?.name || a.payer.name || 'PayPal buyer', email: a.payer.email, country, postal_code: a.shipping?.address?.postal_code || null, city: a.shipping?.address?.admin_area_2 || null };
    pledge.flags = [];
    if (!country) pledge.flags.push('no_shipping_address');
    else if (regionForCountry(c, country)?.id !== pledge.region_id) pledge.flags.push('shipping_region_mismatch');
    if (a.authorized_cents !== pledge.total_cents) pledge.flags.push('authorized_amount_mismatch');
    store.putPledge(pledge);
    store.log(c.slug, 'pledge', `${pledge.buyer.name} (${country || '?'}) pledged ${fmtUsd(pledge.total_cents)}: authorization ${a.authorization_id}`);
    return json(res, 200, { pledge_id: pledge.id, status: pledge.status, total: fmtUsd(pledge.total_cents), expires: a.expiration_time, flags: pledge.flags, pledge_url: `/c/${c.slug}/pledge/${pledge.id}` });
  }

  if ((g = m(/^\/api\/campaigns\/([a-z0-9-]+)\/ask$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    const body = await readJson(req);
    const q = String(body.question || '').trim().slice(0, 600);
    if (!q) throw new HttpError(400, 'Type a question');
    const totals = optionTotals(c, store.pledges(c.slug));
    const r = await ai.answerFan({ campaign: c, totals, question: q });
    const amounts = checkFanAnswer(c, r.data.answer);
    if (!amounts.ok) {
      // The model wrote an amount the campaign does not have; the fan gets a hand-off instead.
      const lang = String(r.data.language || 'en');
      const handoff = HANDOFF[lang] || HANDOFF[lang.split('-')[0].toLowerCase()] || (/^zh/i.test(lang) ? HANDOFF['zh-TW'] : HANDOFF.en);
      r.data = { language: r.data.language, answer: handoff, forward_to_creator: true };
      r.meta = { ...r.meta, withheld: `amounts not in the campaign: ${amounts.unknown.join(', ')}` };
    }
    if (r.data.forward_to_creator) store.log(c.slug, 'question', `Fan question for you: "${q}"`);
    return json(res, 200, { ...r.data, ai: r.meta });
  }

  // ----- creator studio -----
  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)$/)) && req.method === 'GET') return json(res, 200, studioView(mustCampaign(g[1])));

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/close$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    if (c.status === 'open') {
      c.status = 'closed';
      c.closed_at = new Date().toISOString();
      store.putCampaign(c);
      store.log(c.slug, 'closed', 'Pre-orders closed');
    }
    return json(res, 200, { status: c.status });
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/settlement\/draft$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    if (c.status === 'settled') throw new HttpError(409, 'Already settled');
    const pledges = store.pledges(c.slug);
    const d = await draftSettlement({ campaign: c, pledges });
    c.settlement_draft = {
      at: new Date().toISOString(),
      recommendation: d.recommendation,
      ai: d.ai,
      problems: d.problems,
      templates: { templates: d.templates, meta: d.notes_ai, problems: d.template_problems },
    };
    store.putCampaign(c);
    const preview = previewSettlement({ campaign: c, pledges, decisions: d.decisions });
    return json(res, 200, { ...d, preview: { ...preview, samples: sampleTexts({ campaign: c, plan: preview.plan, templates: d.templates }) } });
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/settlement\/preview$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    const body = await readJson(req);
    let preview;
    try {
      preview = previewSettlement({ campaign: c, pledges: store.pledges(c.slug), decisions: body.decisions });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
    return json(res, 200, { ...preview, samples: sampleTexts({ campaign: c, plan: preview.plan, templates: c.settlement_draft?.templates?.templates }) });
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/settlement\/execute$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    if (c.status === 'open') throw new HttpError(409, 'Close pre-orders before settling');
    if (c.status === 'settled') throw new HttpError(409, 'Already settled');
    const body = await readJson(req);
    try {
      const s = await executeSettlement({ store, paypal, campaign: c, decisions: body.decisions, recommendation: c.settlement_draft?.recommendation, draftTemplates: c.settlement_draft?.templates });
      return json(res, 200, s);
    } catch (e) {
      if (/Guard checks failed|Missing decision|order quantity/.test(e.message)) throw new HttpError(409, e.message);
      throw e;
    }
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/settlement$/)) && req.method === 'GET') {
    const c = mustCampaign(g[1]);
    const pledges = store.pledges(c.slug);
    return json(res, 200, {
      settlement: c.settlement || null,
      samples: (c.settlement?.results || [])
        .map((r) => store.pledge(r.pledge_id))
        .filter((p) => p?.settlement)
        .map((p) => ({ pledge_id: p.id, buyer: p.buyer.name, country: p.buyer.country, action: p.settlement.action, language: p.settlement.language, note_to_payer: p.settlement.note_to_payer, message: p.settlement.message, result: p.settlement.result, capture_id: p.paypal?.capture_id || null, capture_cents: p.settlement.capture_cents, release_cents: p.settlement.release_cents })),
      pledge_count: pledges.length,
    });
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/pledges\/([a-zA-Z0-9_]+)\/refresh$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    const pl = store.pledge(g[2]);
    if (!pl || pl.campaign_slug !== c.slug || pl.simulated) throw new HttpError(404, 'Live pledge not found');
    const a = await paypal.getAuthorization(pl.paypal.authorization_id);
    pl.paypal.authorization_status = a.status;
    store.putPledge(pl);
    return json(res, 200, { status: a.status, expiration_time: a.expiration_time });
  }

  if ((g = m(/^\/api\/campaigns\/([a-z0-9-]+)\/pledge\/([a-zA-Z0-9_]+)$/)) && req.method === 'GET') {
    const c = mustCampaign(g[1]);
    const p = store.pledge(g[2]);
    if (!p || p.campaign_slug !== c.slug || p.status === 'pending') throw new HttpError(404, 'Pledge not found');
    const name = (id) => c.options.find((o) => o.id === id)?.name_en || id;
    return json(res, 200, {
      campaign: { slug: c.slug, title: c.title, creator_name: c.creator_name, status: c.status, closes_at: c.closes_at, ship_estimate_en: c.ship_estimate_en },
      pledge: {
        id: p.id,
        status: p.status,
        created_at: p.created_at,
        lines: p.lines.map((l) => ({ ...l, name: name(l.option_id), decision: c.settlement?.decisions?.[l.option_id]?.action || null })),
        shipping_cents: p.shipping_cents,
        total_cents: p.total_cents,
        expires: p.paypal?.expiration_time || null,
        settlement: p.settlement ? { action: p.settlement.action, capture_cents: p.settlement.capture_cents, release_cents: p.settlement.release_cents, note_to_payer: p.settlement.note_to_payer, message: p.settlement.message } : null,
        tracking: p.tracking ? { number: p.tracking.number, carrier: p.tracking.carrier } : null,
      },
    });
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/reauthorize-due$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    const now = Date.now();
    const due = store.pledges(c.slug).filter((p) => p.status === 'held' && !p.simulated && (() => { const a = authAge(p, now); return a && !a.in_honor_period && a.days_to_expiry > 0; })());
    const out = { due: due.length, reauthorized: 0, failed: [] };
    for (let i = 0; i < due.length; i += 4) {
      await Promise.all(due.slice(i, i + 4).map(async (pl) => {
        try {
          const a = await paypal.reauthorize(pl.paypal.authorization_id, pl.total_cents, `qrm-reauth-${pl.id}-${pl.paypal.authorization_id}`);
          pl.paypal.previous_authorization_ids = [...(pl.paypal.previous_authorization_ids || []), pl.paypal.authorization_id];
          pl.paypal.authorization_id = a.id;
          pl.paypal.authorized_at = a.create_time || new Date().toISOString();
          pl.paypal.authorization_status = a.status;
          if (a.expiration_time) pl.paypal.expiration_time = a.expiration_time;
          store.putPledge(pl);
          out.reauthorized++;
        } catch (e) {
          out.failed.push({ pledge_id: pl.id, error: e.message });
        }
      }));
    }
    store.log(c.slug, 'reauthorized', `Reauthorized ${out.reauthorized} of ${out.due} holds past the 3-day honor period${out.failed.length ? ` (${out.failed.length} failed)` : ''}`);
    return json(res, 200, out);
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/messages\.csv$/)) && req.method === 'GET') {
    const c = mustCampaign(g[1]);
    const rows = [['email', 'name', 'language', 'outcome', 'charged_usd', 'released_usd', 'message']];
    for (const p of store.pledges(c.slug)) {
      if (!p.settlement) continue;
      rows.push([p.buyer.email || '', p.buyer.name || '', p.settlement.language, p.settlement.action, (p.settlement.capture_cents / 100).toFixed(2), (p.settlement.release_cents / 100).toFixed(2), p.settlement.message]);
    }
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${c.slug}-messages.csv"` });
    return res.end('\uFEFF' + rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n'));
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/pledges\/([a-zA-Z0-9_]+)\/reauthorize$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    const pl = store.pledge(g[2]);
    if (!pl || pl.campaign_slug !== c.slug || pl.simulated || pl.status !== 'held') throw new HttpError(404, 'Held live pledge not found');
    const a = await paypal.reauthorize(pl.paypal.authorization_id, pl.total_cents, `qrm-reauth-${pl.id}-${pl.paypal.authorization_id}`);
    pl.paypal.previous_authorization_ids = [...(pl.paypal.previous_authorization_ids || []), pl.paypal.authorization_id];
    pl.paypal.authorization_id = a.id;
    pl.paypal.authorized_at = a.create_time || new Date().toISOString();
    pl.paypal.authorization_status = a.status;
    store.putPledge(pl);
    store.log(c.slug, 'reauthorized', `Reauthorized ${pl.buyer.name}: new honor period until ${new Date(Date.parse(pl.paypal.authorized_at) + 3 * 86400000).toISOString().slice(0, 10)}`);
    return json(res, 200, { authorization_id: a.id, status: a.status });
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/shipping\/demo-export$/)) && req.method === 'GET') {
    const c = mustCampaign(g[1]);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
    return res.end(demoExport(c, store.pledges(c.slug)));
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/shipping\/match$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    const body = await readJson(req);
    try {
      return json(res, 200, await matchExport({ pledges: store.pledges(c.slug), csvText: body.csv_text }));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }

  if ((g = m(/^\/api\/studio\/([a-z0-9-]+)\/shipping\/upload$/)) && req.method === 'POST') {
    const c = mustCampaign(g[1]);
    const body = await readJson(req);
    return json(res, 200, { results: await uploadTracking({ store, paypal, campaign: c, matches: body.matches || [] }) });
  }

  throw new HttpError(404, 'Not found');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/mock-paypal')) {
        if (!mockPayPal) return json(res, 404, { error: 'Mock PayPal is off (sandbox mode)' });
        return await mockPayPal.handle(req, res, url, () => readJson(req));
      }
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (url.pathname === '/favicon.ico') return serveFile(res, path.join(PUBLIC, 'img', 'favicon.svg'));
      const page = PAGES.find(([re]) => re.test(url.pathname));
      if (page && req.method === 'GET') return serveFile(res, path.join(PUBLIC, page[1]));
      const file = path.normalize(path.join(PUBLIC, url.pathname));
      if (req.method === 'GET' && file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
      json(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e.status && e.status < 500 ? e.status : e.name === 'PayPalError' ? 502 : 500;
      if (status >= 500) console.error(e);
      json(res, status, { error: e.message, paypal_issue: e.issue || undefined, debug_id: e.debugId || undefined });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server', 'index.js');
if (isMain) {
  createServer().listen(config.port, () => {
    console.log(`Quorum running at ${config.publicUrl}`);
    console.log(`  PayPal: ${config.paypalMode === 'sandbox' ? 'SANDBOX (api-m.sandbox.paypal.com)' : 'MOCK (local stand-in, add sandbox keys to .env)'}`);
    console.log(`  AI:     ${config.aiMode === 'azure-openai' ? `Azure OpenAI, deployment ${config.azure.deployment} at ${new URL(config.azure.baseUrl).host}` : 'MOCK (sample outputs, add Azure OpenAI settings to .env)'}`);
    const first = Object.values(store.data.campaigns)[0];
    if (first) console.log(`  Demo:   ${config.publicUrl}/c/${first.slug}  and  ${config.publicUrl}/studio/${first.slug}`);
  });
}
