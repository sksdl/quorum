// Builds the demo: one campaign (the sample AI draft of fixtures/demo-post-ko.txt)
// with a few days of fictional pledges from fans abroad. Pre-orders close 9.6 hours after seeding.
//   PAYPAL_MODE=mock     every seeded pledge is a real authorization in the local mock PayPal
//   PAYPAL_MODE=sandbox  seeded pledges are marked "simulated" and never touch PayPal;
//                        pledges you make through the real sandbox checkout are the live ones.
//
// npm run seed -- --keep-live
//   Rebuilds the seeded pledges relative to now but keeps the holds made through the checkout
//   (open ones only). Use it on the day of a demo: holds placed 4 to 9 days earlier are then past
//   PayPal's 3-day honor period, so reauthorization can be shown, and the campaign is open again.
//
// npm run seed -- --with-walkthrough
//   Also seeds the walkthrough's three carts (keyring; stand + pin; pin) for one fan in Germany.
//   In sandbox mode they are simulated like the rest, so the settlement screens show the README's
//   numbers (136 pledges, $3,533.00 held) without a sandbox buyer.
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from '../server/config.js';
import { Store, newId } from '../server/store.js';
import { MockPayPal } from '../server/mock-paypal.js';
import { buildOrderBody, readAuthorization } from '../server/paypal.js';
import { priceCart, regionForCountry } from '../server/engine.js';
import { fmtUsd } from '../server/money.js';

const TARGET = { A: 63, B: 27, C: 212, D: 41 };
const FX = 1380; // creator's own assumption for cost estimates, not a market quote
const FEE = 0.05; // creator's fee allowance for estimates

let seed = 20261031;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const weighted = (pairs) => {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of pairs) if ((r -= w) <= 0) return v;
  return pairs[pairs.length - 1][0];
};

// Fictional fans. Native-script names are used later by the demo carrier export.
const COUNTRIES = {
  JP: { w: 18, locale: 'ja', first: [['Yuki', '由紀'], ['Haruto', '陽斗'], ['Mio', '美緒'], ['Ren', '蓮'], ['Sakura', 'さくら'], ['Sota', '蒼太'], ['Aoi', '葵'], ['Riku', '陸'], ['Hina', '陽菜'], ['Kaito', '海斗']], last: [['Tanaka', '田中'], ['Sato', '佐藤'], ['Suzuki', '鈴木'], ['Takahashi', '高橋'], ['Ito', '伊藤'], ['Watanabe', '渡辺'], ['Yamamoto', '山本'], ['Nakamura', '中村'], ['Kobayashi', '小林'], ['Kato', '加藤']], native: (f, l) => `${l} ${f}`, cities: [['Osaka', 'Osaka', '530-0001'], ['Fukuoka', 'Fukuoka', '810-0001'], ['Sapporo', 'Hokkaido', '060-0001'], ['Nagoya', 'Aichi', '460-0008'], ['Yokohama', 'Kanagawa', '220-0011'], ['Sendai', 'Miyagi', '980-0021'], ['Kyoto', 'Kyoto', '600-8216']] },
  US: { w: 16, locale: 'en', first: ['Emily', 'Jordan', 'Maya', 'Tyler', 'Grace', 'Ethan', 'Olivia', 'Noah', 'Ava', 'Lucas', 'Chloe', 'Mason'], last: ['Carter', 'Nguyen', 'Brooks', 'Patel', 'Rivera', 'Kim', 'Foster', 'Hughes', 'Sullivan', 'Price', 'Bennett', 'Reyes'], cities: [['Austin', 'TX', '78701'], ['Seattle', 'WA', '98103'], ['Chicago', 'IL', '60614'], ['Brooklyn', 'NY', '11215'], ['San Diego', 'CA', '92104'], ['Columbus', 'OH', '43201'], ['Denver', 'CO', '80205']] },
  TW: { w: 9, locale: 'zh-TW', first: [['Wei-Ting', '維婷'], ['Yu-Chen', '昱辰'], ['Pei-Shan', '佩珊'], ['Chia-Hao', '家豪'], ['Hsin-Yi', '欣怡'], ['Po-Wei', '柏維'], ['Yi-Hsuan', '怡萱']], last: [['Lin', '林'], ['Chen', '陳'], ['Huang', '黃'], ['Chang', '張'], ['Wu', '吳'], ['Tsai', '蔡']], native: (f, l) => `${l}${f}`, cities: [['Taipei', '', '100'], ['Taichung', '', '400'], ['Kaohsiung', '', '800'], ['Tainan', '', '700'], ['Hsinchu', '', '300']] },
  ID: { w: 7, locale: 'id', first: ['Putri', 'Rizky', 'Nadia', 'Arif', 'Sari', 'Bayu', 'Intan'], last: ['Ananda', 'Pratama', 'Kusuma', 'Setiawan', 'Wulandari', 'Saputra'], cities: [['Jakarta', 'DKI Jakarta', '10110'], ['Bandung', 'West Java', '40111'], ['Surabaya', 'East Java', '60111'], ['Yogyakarta', 'DI Yogyakarta', '55211']] },
  PH: { w: 6, locale: 'en', first: ['Andrea', 'Miguel', 'Bea', 'Paolo', 'Kim', 'Rina'], last: ['Santos', 'Reyes', 'Garcia', 'Cruz', 'Bautista', 'Mendoza'], cities: [['Quezon City', 'Metro Manila', '1100'], ['Cebu City', 'Cebu', '6000'], ['Davao City', 'Davao del Sur', '8000']] },
  DE: { w: 6, locale: 'de', first: ['Jonas', 'Lea', 'Felix', 'Mia', 'Paul', 'Lina'], last: ['Wagner', 'Fischer', 'Schulz', 'Weber', 'Hoffmann', 'Koch'], cities: [['Hamburg', '', '20095'], ['Köln', '', '50667'], ['München', '', '80331'], ['Dresden', '', '01067']] },
  CA: { w: 6, locale: 'en', first: ['Olivia', 'Liam', 'Ava', 'Ethan', 'Sophie', 'Owen'], last: ['Tremblay', 'MacDonald', 'Wong', 'Singh', 'Roy', 'Campbell'], cities: [['Toronto', 'ON', 'M5V 2T6'], ['Vancouver', 'BC', 'V6B 1A1'], ['Montréal', 'QC', 'H2X 1Y4'], ['Calgary', 'AB', 'T2P 1J9']] },
  MX: { w: 5, locale: 'es', first: ['Sofía', 'Diego', 'Valeria', 'Mateo', 'Ximena', 'Emilio'], last: ['Ramírez', 'Hernández', 'Torres', 'Flores', 'Morales', 'Castillo'], cities: [['Ciudad de México', 'CDMX', '06700'], ['Guadalajara', 'Jalisco', '44100'], ['Monterrey', 'Nuevo León', '64000'], ['Puebla', 'Puebla', '72000']] },
  AU: { w: 5, locale: 'en', first: ['Chloe', 'Jack', 'Ruby', 'Harrison', 'Zoe'], last: ['Mitchell', 'Thompson', 'Nguyen', 'Walsh', 'Harris'], cities: [['Melbourne', 'VIC', '3000'], ['Sydney', 'NSW', '2000'], ['Brisbane', 'QLD', '4000'], ['Perth', 'WA', '6000']] },
  FR: { w: 4, locale: 'fr', first: ['Camille', 'Lucas', 'Chloé', 'Hugo', 'Inès'], last: ['Martin', 'Bernard', 'Dubois', 'Moreau', 'Laurent'], cities: [['Lyon', '', '69001'], ['Paris', '', '75011'], ['Nantes', '', '44000'], ['Lille', '', '59000']] },
  GB: { w: 4, locale: 'en', first: ['Isla', 'Oliver', 'Freya', 'Archie', 'Poppy'], last: ['Morgan', 'Davies', 'Hughes', 'Evans', 'Clarke'], cities: [['London', '', 'E8 3PN'], ['Manchester', '', 'M1 1AE'], ['Bristol', '', 'BS1 4DJ'], ['Leeds', '', 'LS1 4AP']] },
  SG: { w: 4, locale: 'en', first: ['Rachel', 'Marcus', 'Jia Hui', 'Wei Jie', 'Shu Fen'], last: ['Tan', 'Lim', 'Ng', 'Goh', 'Teo'], cities: [['Singapore', '', '238859'], ['Singapore', '', '529510'], ['Singapore', '', '640456'], ['Singapore', '', '159960']] },
  TH: { w: 3, locale: 'th', first: ['Ploy', 'Nattapong', 'Mint', 'Krit'], last: ['Srisuk', 'Chaiyaporn', 'Wongsa', 'Thongdee'], cities: [['Bangkok', 'Bangkok', '10110'], ['Chiang Mai', 'Chiang Mai', '50200']] },
  HK: { w: 3, locale: 'zh-HK', first: [['Tsz Ching', '芷晴'], ['Ka Ho', '家豪'], ['Hoi Yan', '凱欣'], ['Chun Hei', '俊熙']], last: [['Chan', '陳'], ['Wong', '黃'], ['Leung', '梁'], ['Lau', '劉']], native: (f, l) => `${l}${f}`, cities: [['Kowloon', 'Hong Kong', ''], ['Sha Tin', 'Hong Kong', ''], ['Central', 'Hong Kong', '']] },
  MY: { w: 2, locale: 'en', first: ['Nur Aisyah', 'Daniel', 'Mei Ling', 'Hafiz'], last: ['Rahman', 'Lee', 'Ong', 'Ismail'], cities: [['Kuala Lumpur', 'WP Kuala Lumpur', '50450'], ['George Town', 'Penang', '10200']] },
  ES: { w: 1, locale: 'es', first: ['Lucía', 'Pablo', 'Marta'], last: ['García', 'Martínez', 'López'], cities: [['Madrid', '', '28004'], ['Valencia', '', '46001']] },
  NL: { w: 1, locale: 'nl', first: ['Sanne', 'Daan', 'Fleur'], last: ['de Vries', 'Bakker', 'Visser'], cities: [['Amsterdam', '', '1012 AB'], ['Utrecht', '', '3511 AB']] },
};

// Real fans in one city rarely share a postal code; vary the last digits so the demo data looks like that.
const usedPostal = new Set();
function varyPostal(p) {
  if (!p || !/\d$/.test(p)) return p;
  for (let i = 0; i < 50; i++) {
    const v = p.replace(/(\d{1,2})$/, (m) => String(Math.floor(rand() * 10 ** m.length)).padStart(m.length, '0'));
    if (!usedPostal.has(v)) {
      usedPostal.add(v);
      return v;
    }
  }
  return p;
}

const used = new Set();
function makeBuyer(cc, fixed) {
  const c = COUNTRIES[cc];
  for (let tries = 0; tries < 200; tries++) {
    const f = fixed?.first ?? pick(c.first);
    const l = fixed?.last ?? pick(c.last);
    const fName = Array.isArray(f) ? f[0] : f;
    const lName = Array.isArray(l) ? l[0] : l;
    const name = `${fName} ${lName}`;
    if (used.has(name)) continue;
    used.add(name);
    const [city, area, basePostal] = fixed?.city ?? pick(c.cities);
    const postal = fixed?.city ? basePostal : varyPostal(basePostal);
    const street = `${1 + Math.floor(rand() * 240)} ${pick(['Garden', 'Station', 'River', 'Market', 'Hill', 'Park'])} ${cc === 'JP' || cc === 'TW' || cc === 'HK' ? 'Rd' : 'St'}`;
    return {
      name,
      native_name: c.native && Array.isArray(f) ? c.native(f[1], l[1]) : null,
      email: `${fName}.${lName}`.toLowerCase().normalize('NFKD').replace(/[^a-z.]/g, '') + '@example.com',
      country: cc,
      locale: c.locale,
      postal_code: postal,
      city,
      address: { address_line_1: street, admin_area_2: city, ...(area ? { admin_area_1: area } : {}), ...(postal ? { postal_code: postal } : {}), country_code: cc },
    };
  }
  throw new Error('Ran out of unique names');
}

// A few fans with fixed baskets, so the demo always shows each kind of outcome.
const FEATURED = [
  { cc: 'JP', fixed: { first: ['Yuki', '由紀'], last: ['Tanaka', '田中'], city: ['Osaka', 'Osaka', '530-0001'] }, lines: { A: 1, D: 1 }, daysAgo: 8.6 },
  { cc: 'US', fixed: { first: 'Emily', last: 'Carter', city: ['Austin', 'TX', '78701'] }, lines: { B: 1, C: 2 }, daysAgo: 8.1 },
  { cc: 'TW', fixed: { first: ['Wei-Ting', '維婷'], last: ['Lin', '林'], city: ['Taipei', '', '100'] }, lines: { D: 2 }, daysAgo: 6.4 },
  { cc: 'MX', fixed: { first: 'Sofía', last: 'Ramírez', city: ['Guadalajara', 'Jalisco', '44100'] }, lines: { A: 2, C: 3 }, daysAgo: 4.2 },
  { cc: 'ID', fixed: { first: 'Putri', last: 'Ananda', city: ['Bandung', 'West Java', '40111'] }, lines: { B: 1, D: 1 }, daysAgo: 1.3 },
];

function basketFromPools(pools) {
  const avail = Object.keys(pools).filter((k) => pools[k] > 0);
  const k = Math.min(avail.length, weighted([[1, 45], [2, 40], [3, 15]]));
  const chosen = [];
  while (chosen.length < k) {
    const opt = weighted(avail.filter((a) => !chosen.includes(a)).map((a) => [a, a === 'C' ? pools[a] / 3 : pools[a]]));
    chosen.push(opt);
  }
  const lines = {};
  for (const o of chosen) {
    const want = o === 'A' ? weighted([[1, 80], [2, 20]]) : o === 'B' ? 1 : o === 'C' ? weighted([[1, 25], [2, 35], [3, 20], [4, 12], [5, 8]]) : weighted([[1, 85], [2, 15]]);
    lines[o] = Math.min(want, pools[o]);
  }
  return lines;
}

const SLUG = 'studio-haneul-night-market';
const OPEN_DAYS_AGO = 9.6;

function main() {
  const keepLive = process.argv.includes('--keep-live') || process.env.SEED_KEEP_LIVE === '1';
  const walkthrough = process.argv.includes('--with-walkthrough');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(path.join(config.dataDir, 'quorum-db.json'));
  const now = Date.now();
  const opensAt = now - OPEN_DAYS_AGO * 86400000;

  // Holds made through the checkout (not by this script) that are still open.
  const kept = keepLive ? store.pledges(SLUG).filter((p) => !p.seeded && !p.simulated && p.status === 'held' && p.paypal?.authorization_id) : [];
  const tooOld = kept.filter((p) => Date.parse(p.created_at) < opensAt + 3600000);
  if (tooOld.length) {
    console.error(`--keep-live: ${tooOld.length} live hold(s) were placed more than ${OPEN_DAYS_AGO - 0.1} days ago, before the rebuilt campaign would open:`);
    for (const p of tooOld) console.error(`  ${p.id} ${p.buyer.name} ${p.created_at}`);
    console.error('Seed without --keep-live and place new holds (the old ones expire on their own).');
    process.exit(1);
  }

  store.reset();
  const mock = config.paypalMode === 'mock' ? new MockPayPal(path.join(config.dataDir, 'mock-paypal.json'), config.publicUrl) : null;
  if (mock) {
    if (keepLive) mock.resetKeeping(kept.map((p) => p.paypal.order_id));
    else mock.reset();
  }

  const draft = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/ai-mock/campaign-draft.json'), 'utf8'));
  const campaign = {
    ...draft,
    slug: SLUG,
    status: 'open',
    created_at: new Date(opensAt).toISOString(),
    opens_at: new Date(opensAt).toISOString(),
    closes_at: new Date(opensAt + draft.duration_days * 86400000).toISOString(),
    cost_basis: { ...draft.cost_basis, fx_krw_per_usd: FX, fee_rate: FEE },
    options: draft.options.map((o, i) => ({ ...o, image: `/img/item-${'abcd'[i]}.svg` })),
    source: {
      post_text: fs.readFileSync(path.join(ROOT, 'fixtures/demo-post-ko.txt'), 'utf8'),
      quote_text: fs.readFileSync(path.join(ROOT, 'fixtures/factory-quote-ko.txt'), 'utf8'),
    },
    demo: true,
  };
  store.putCampaign(campaign);
  store.log(campaign.slug, 'published', 'Campaign published (4 options, closes in 10 days)', { at: campaign.opens_at });

  const pools = { ...TARGET };
  const plans = [];
  for (const f of FEATURED) {
    for (const [k, q] of Object.entries(f.lines)) pools[k] -= q;
    plans.push({ buyer: makeBuyer(f.cc, f.fixed), lines: f.lines, daysAgo: f.daysAgo });
  }
  while (Object.values(pools).some((v) => v > 0)) {
    const lines = basketFromPools(pools);
    for (const [k, q] of Object.entries(lines)) pools[k] -= q;
    const cc = weighted(Object.entries(COUNTRIES).map(([k, v]) => [k, v.w]));
    // Pledges bunch up at launch and just before the deadline.
    const daysAgo = weighted([[() => 8.2 + rand() * 1.3, 40], [() => 1.5 + rand() * 6.7, 35], [() => 0.05 + rand() * 1.4, 25]])();
    plans.push({ buyer: makeBuyer(cc), lines, daysAgo });
  }
  if (walkthrough) {
    const fan = makeBuyer('DE');
    plans.push({ buyer: fan, lines: { A: 1 }, daysAgo: 6 }, { buyer: fan, lines: { D: 1 }, daysAgo: 6 }, { buyer: fan, lines: { B: 1, D: 1 }, daysAgo: 0.02 });
  }

  for (const plan of plans.sort((a, b) => b.daysAgo - a.daysAgo)) {
    const at = new Date(now - plan.daysAgo * 86400000);
    const region = regionForCountry(campaign, plan.buyer.country);
    const cart = priceCart(campaign, Object.entries(plan.lines).map(([option_id, qty]) => ({ option_id, qty })), region.id);
    const pledge = {
      id: newId('plg'),
      campaign_slug: campaign.slug,
      status: 'held',
      simulated: !mock,
      seeded: true,
      created_at: at.toISOString(),
      buyer: { name: plan.buyer.name, native_name: plan.buyer.native_name, email: plan.buyer.email, country: plan.buyer.country, locale: plan.buyer.locale, postal_code: plan.buyer.postal_code, city: plan.buyer.city },
      lines: cart.items.map(({ option_id, qty, unit_cents }) => ({ option_id, qty, unit_cents })),
      region_id: cart.region_id,
      item_cents: cart.item_cents,
      shipping_cents: cart.shipping_cents,
      total_cents: cart.total_cents,
      paypal: {},
      flags: [],
    };
    if (mock) {
      const order = mock.createOrder(buildOrderBody({ campaign, pledge, returnUrl: `${config.publicUrl}/c/${campaign.slug}`, cancelUrl: `${config.publicUrl}/c/${campaign.slug}` }), at);
      mock.approve(order.id, plan.buyer, at);
      const a = readAuthorization(mock.authorize(order.id, at));
      pledge.paypal = { order_id: order.id, ...a };
    } else {
      pledge.authorized_at = at.toISOString();
      pledge.paypal = { shipping: { name: plan.buyer.name, address: plan.buyer.address } };
    }
    store.data.pledges[pledge.id] = pledge;
    store.data.events.push({ at: at.toISOString(), campaign: campaign.slug, type: 'pledge', text: `${pledge.buyer.name} (${pledge.buyer.country}) pledged ${fmtUsd(pledge.total_cents)}${mock ? `: authorization ${pledge.paypal.authorization_id}` : ' (simulated)'}` });
  }
  for (const p of kept) {
    store.data.pledges[p.id] = p;
    store.data.events.push({ at: p.created_at, campaign: campaign.slug, type: 'pledge', text: `${p.buyer.name} (${p.buyer.country || '?'}) pledged ${fmtUsd(p.total_cents)}: authorization ${p.paypal.authorization_id}` });
  }
  store.data.events.push({ at: new Date(now - 2.1 * 86400000).toISOString(), campaign: campaign.slug, type: 'question', text: 'Fan question for you: "Can I get the stand in a different color?"' });
  store.data.events.sort((a, b) => a.at.localeCompare(b.at));
  store.save();

  const n = plans.length;
  const held = Object.values(store.data.pledges).filter((p) => p.seeded).reduce((s, p) => s + p.total_cents, 0);
  console.log(`Seeded "${campaign.title}" by ${campaign.creator_name}: ${n} pledges, ${fmtUsd(held)} held (${mock ? 'mock PayPal authorizations' : 'simulated, not in PayPal'})`);
  const totals = {};
  for (const p of Object.values(store.data.pledges)) for (const l of p.lines) totals[l.option_id] = (totals[l.option_id] || 0) + l.qty;
  console.log(`Totals: ${Object.keys(TARGET).map((k) => `${k}=${totals[k] || 0}`).join(' ')}`);
  console.log(`Pre-orders close ${campaign.closes_at} (in ${((Date.parse(campaign.closes_at) - now) / 3600000).toFixed(1)} hours)`);
  if (keepLive) {
    console.log(`Kept ${kept.length} live hold(s) made through the checkout:`);
    for (const p of kept) console.log(`  ${p.buyer.name} ${fmtUsd(p.total_cents)} ${p.lines.map((l) => `${l.option_id}x${l.qty}`).join(' ')}, placed ${((now - Date.parse(p.created_at)) / 86400000).toFixed(1)} days ago`);
  }
}

main();
