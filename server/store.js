import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A small JSON-file store. Good enough for a single-creator prototype;
// the shape maps directly onto two tables (campaigns, pledges) plus an event log.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = Store.empty();
    if (fs.existsSync(file)) this.data = { ...Store.empty(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }

  static empty() {
    return { campaigns: {}, pledges: {}, events: [] };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  reset() {
    this.data = Store.empty();
    this.save();
  }

  campaign(slug) {
    return this.data.campaigns[slug] || null;
  }

  putCampaign(c) {
    this.data.campaigns[c.slug] = c;
    this.save();
    return c;
  }

  pledges(slug) {
    return Object.values(this.data.pledges)
      .filter((p) => p.campaign_slug === slug)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  pledge(id) {
    return this.data.pledges[id] || null;
  }

  pledgeByOrder(orderId) {
    return Object.values(this.data.pledges).find((p) => p.paypal?.order_id === orderId) || null;
  }

  putPledge(p) {
    this.data.pledges[p.id] = p;
    this.save();
    return p;
  }

  log(slug, type, text, extra = {}) {
    const ev = { at: new Date().toISOString(), campaign: slug, type, text, ...extra };
    this.data.events.push(ev);
    if (this.data.events.length > 2000) this.data.events.splice(0, this.data.events.length - 2000);
    this.save();
    return ev;
  }

  events(slug, limit = 60) {
    return this.data.events.filter((e) => e.campaign === slug).slice(-limit).reverse();
  }
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x')}`;
}
