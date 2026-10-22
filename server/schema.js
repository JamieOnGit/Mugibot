// Input checks. Everything a user sends goes through one of these first.

import crypto from 'node:crypto';
import { CART_LINK, cartLines } from './retailers/shoplink.js';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (message) => new HttpError(400, message);

export const str = (v, max = 200) => (v === undefined || v === null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

export function num(v, { min = -Infinity, max = Infinity, def = null, int = false } = {}) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const x = int ? Math.round(n) : n;
  return Math.min(max, Math.max(min, x));
}

export const bool = (v, def = false) => (v === undefined || v === null ? def : v === true || v === 'true' || v === 1 || v === '1' || v === 'on');

export function httpUrl(value, label = 'Link', { required = true } = {}) {
  const s = str(value, 2000);
  if (!s) {
    if (required) throw bad(`${label} is required`);
    return '';
  }
  let u;
  try { u = new URL(s); } catch { throw bad(`${label} isn't a valid web address`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(`${label} must start with https://`);
  if (u.username || u.password) throw bad(`${label} can't contain a username or password`);
  u.hash = '';
  return u.toString();
}

// --- Accounts ------------------------------------------------------------------
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'mugibot', 'everyone', 'here', 'moderator', 'staff', 'discord', 'whop']);
export function username(v, { allowReserved = false } = {}) {
  const s = str(v, 40).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(s)) throw bad('Usernames are 3–24 characters: letters, numbers, dots, dashes and underscores');
  if (!allowReserved && RESERVED.has(s)) throw bad('That username is reserved — choose another');
  return s;
}

const EMAIL_RE = /^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$/;
export function email(v) {
  const s = str(v, 254).toLowerCase();
  if (!EMAIL_RE.test(s)) throw bad('Enter a valid email address');
  return s;
}
/** '' → null (email is optional). */
export const optionalEmail = (v) => (str(v, 254) ? email(v) : null);

export function password(v) {
  const s = typeof v === 'string' ? v : '';
  if (s.length < 10) throw bad('Use at least 10 characters for your password');
  if (s.length > 200) throw bad('That password is too long');
  if (/^(.)\1+$/.test(s) || /^(password|1234567890|qwertyuiop)/i.test(s)) throw bad('Choose a less guessable password');
  return s;
}

// --- Watchlist items -------------------------------------------------------------
/**
 * A SKU to watch and buy. Give a product link (the store and SKU are read
 * from it), or a store and SKU (the product page is found from the SKU).
 * opts: { retailers, existing, isAdmin }
 */
export function item(input, { retailers, existing = null, isAdmin = false }) {
  const src = { ...(existing || {}), ...(input || {}) };
  let url = httpUrl(src.url, 'Product link', { required: false });
  let store;
  let sku = str(src.sku, 60);
  if (url) {
    const r = retailers.forUrl(url);
    store = r ? r.id : 'other';
    // A new link brings its own SKU, unless one was typed in with it.
    const typed = input && input.sku !== undefined ? str(input.sku, 60) : '';
    const urlChanged = !existing || existing.url !== url;
    sku = typed || (urlChanged ? retailers.skuFromUrl(url) : existing.sku);
    if (!sku && store === 'other') sku = new URL(url).pathname.split('/').filter(Boolean).pop()?.slice(0, 60) || '';
  } else {
    store = str(src.store, 40);
    const r = retailers.get(store);
    if (!r || store === 'other') throw bad('Choose the store, or paste the product link');
    if (!sku) throw bad(`Enter the ${(r.skuLabel || 'SKU').toLowerCase()}, or paste the product link`);
    // Some stores' links are built from the code alone; for the rest the monitor finds the page.
    url = retailers.productUrlFromSku(r, sku) || (existing && existing.store === store && existing.sku === sku ? existing.url : '');
  }
  if (!sku) throw bad("Couldn't find the product code in that link — enter the SKU / keycode");
  const r = retailers.get(store);
  // How many to buy: 1 unless you say. (A Shop checkout link with one product in it: the link's own number,
  // unless you say otherwise — then the link is changed to it. With several, each as the link has it.)
  let quantity = num(src.quantity, { min: 1, max: 10, def: 1, int: true });
  // A Shop checkout link (retailers/shoplink.js): the store's whole cart link is the item — nothing else to go by.
  if (r && r.cartLinks) {
    if (!url) throw bad("Paste the store's checkout link (…/cart/<number>:<quantity>) — it's the order itself");
    const u = new URL(url);
    const lines = cartLines(u.pathname);
    if (!lines) throw bad("That's a Shop page, not a store's checkout link: paste the store's own link (…/cart/<number>:<quantity>)");
    if (lines.length === 1) {
      quantity = input && input.quantity !== undefined && input.quantity !== '' && input.quantity !== null ? quantity : lines[0].qty;
      u.pathname = u.pathname.replace(CART_LINK, (all, before) => `${before}/cart/${lines[0].id}:${quantity}`);
      url = u.href;
    } else quantity = 1;
    sku = retailers.skuFromUrl(url);
  }
  const changingStore = !existing || existing.store !== store;
  if (changingStore && store !== 'other' && !retailers.enabled(r)) throw bad(`${r ? r.name : store} is switched off at the moment`);
  const out = {
    store,
    sku,
    url,
    name: str(src.name, 120) || (r && r.cartLinks ? `Checkout link at ${new URL(url).host.replace(/^www\./, '')}` : sku),
    price: num(src.price, { min: 0, max: 100000, def: null }),
    maxPrice: num(src.maxPrice ?? src.max_price, { min: 0, max: 100000, def: null }),
    quantity,
    profileId: str(src.profileId ?? src.profile_id, 40) || null,
    monitor: bool(src.monitor, true),
    announce: isAdmin ? bool(src.announce, false) : !!(existing && existing.announce),
    // Auto-checkout (docs/AUTO-CHECKOUT.md): bought by itself when it drops, never above its max price.
    aco: bool(src.aco, false),
    // A Shop checkout link's discount code: typed in at Shop's checkout, Apply pressed, before "Pay now" ('' = none).
    discount: r && r.cartLinks ? String(src.discount ?? '').replace(/\s+/g, '').slice(0, 60) : '',
  };
  if (out.price === null && input && input.price === undefined && existing) out.price = existing.price;
  if (out.aco) {
    if (!r || !r.flow) throw bad(`Auto-checkout works at stores Mugibot has a checkout for — not ${r ? r.name : 'this store'} yet`);
    if (out.maxPrice === null) throw bad('Set a max price to auto-checkout this item: Mugibot never pays more than that');
  }
  return out;
}

// --- Delivery details ----------------------------------------------------------
export const AU_STATES = { NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland', WA: 'Western Australia', SA: 'South Australia', TAS: 'Tasmania', ACT: 'Australian Capital Territory', NT: 'Northern Territory' };
export const EMPTY_PROFILE = { id: '', label: 'Home', firstName: '', lastName: '', email: '', phone: '', address1: '', address2: '', suburb: '', state: '', postcode: '', country: 'AU' };

export function profile(input) {
  const p = { ...EMPTY_PROFILE, ...(input || {}) };
  const state = str(p.state, 40).toUpperCase();
  const out = {
    id: /^[\w-]{4,40}$/.test(String(p.id || '')) ? String(p.id) : `pf_${crypto.randomBytes(6).toString('base64url')}`,
    label: str(p.label, 40) || 'Home',
    firstName: str(p.firstName, 80),
    lastName: str(p.lastName, 80),
    email: str(p.email, 200),
    phone: str(p.phone, 40),
    address1: str(p.address1, 200),
    address2: str(p.address2, 200),
    suburb: str(p.suburb, 100),
    state: AU_STATES[state] ? state : Object.entries(AU_STATES).find(([, full]) => full.toUpperCase() === state)?.[0] || state,
    postcode: str(p.postcode, 10),
    country: 'AU',
  };
  const where = out.label ? ` (${out.label})` : '';
  if (out.email && !EMAIL_RE.test(out.email)) throw bad(`Checkout email looks wrong${where}`);
  if (out.postcode && !/^\d{4}$/.test(out.postcode)) throw bad(`Australian postcodes have 4 digits${where}`);
  if (out.state && !AU_STATES[out.state]) throw bad(`State must be one of NSW, VIC, QLD, WA, SA, TAS, ACT, NT${where}`);
  return out;
}

/** The whole set of delivery profiles: { profiles: [...], defaultId }. */
export function profiles(input, limit = 5) {
  const list = Array.isArray(input && input.profiles) ? input.profiles : [];
  if (!list.length) throw bad('Keep at least one set of delivery details');
  if (list.length > limit) throw bad(`You can have up to ${limit} sets of delivery details`);
  const out = list.map(profile);
  const ids = new Set();
  for (const p of out) {
    if (ids.has(p.id)) p.id = `pf_${crypto.randomBytes(6).toString('base64url')}`;
    ids.add(p.id);
  }
  const defaultId = out.some((p) => p.id === input.defaultId) ? input.defaultId : out[0].id;
  return { profiles: out, defaultId };
}

// --- Auto-checkout ---------------------------------------------------------------
// The member's own switch and limits (docs/AUTO-CHECKOUT.md). Nothing is bought automatically
// until they switch it on and agree; each item is armed on its own, with its own max price.
export const DEFAULT_ACO = {
  enabled: false,
  agreedAt: null, // when they agreed that Mugibot may place orders with their saved card
  mode: 'place', // 'place': press the final button; 'fill': fill checkout in and stop there for them
  maxOrder: 400, // the most one order may cost, delivery included
  perDay: 2, // orders a day (24 hours)
  spendPerDay: 600, // dollars a day
  signedInOnly: false, // (no longer used: a run starts signed in or not — aco.js)
  remoteBuy: true, // Discord's ⚡ Buy (pressed on your phone or anywhere) checks out in your checkout browser
  deviceId: '', // the checkout browser: the one browser runs go to ('' = the newest one connected)
};

export function acoSettings(input, existing = DEFAULT_ACO, now = Date.now()) {
  const src = input || {};
  const a = { ...DEFAULT_ACO, ...existing, ...src };
  const out = {
    enabled: bool(a.enabled, false),
    agreedAt: (existing && existing.agreedAt) || null,
    mode: a.mode === 'fill' ? 'fill' : 'place',
    maxOrder: num(a.maxOrder, { min: 1, max: 10000, def: DEFAULT_ACO.maxOrder }),
    perDay: num(a.perDay, { min: 1, max: 10, def: DEFAULT_ACO.perDay, int: true }),
    spendPerDay: num(a.spendPerDay, { min: 1, max: 20000, def: DEFAULT_ACO.spendPerDay }),
    signedInOnly: bool(a.signedInOnly, false),
    remoteBuy: bool(a.remoteBuy, true),
    deviceId: /^[\w-]{0,40}$/.test(String(a.deviceId || '')) ? String(a.deviceId || '') : '',
  };
  if (out.enabled && !out.agreedAt) {
    if (src.agree !== true) throw bad('Tick the box to agree that Mugibot may check out by itself with your saved card, within your limits');
    out.agreedAt = now;
  }
  return out;
}

// --- Alerts --------------------------------------------------------------------
export const DEFAULT_ALERTS = {
  discordDm: true, // DM me when one of my SKUs is in stock / pre-order opens
  discordDmListed: true, // …and when a SKU I'm waiting for is first listed
  discordDmCheckout: false, // …and when checkout is filled in and waiting for me
  discordWebhook: '', // my own server too (optional)
  discordMention: '',
  emailOnRestock: false,
  emailOnCheckout: false,
  browserChecks: true, // my browser (with the extension) checks my SKUs when a store refuses server checks
};

export function alerts(input, existing = DEFAULT_ALERTS) {
  const a = { ...DEFAULT_ALERTS, ...existing, ...(input || {}) };
  const hook = str(a.discordWebhook, 500);
  if (hook) {
    let u;
    try { u = new URL(hook); } catch { throw bad("Discord webhook isn't a valid link"); }
    if (u.protocol !== 'https:' || !/(^|\.)(discord\.com|discordapp\.com)$/.test(u.hostname) || !u.pathname.startsWith('/api/webhooks/')) {
      throw bad('Discord webhook must look like https://discord.com/api/webhooks/…');
    }
  }
  return {
    discordDm: bool(a.discordDm, true),
    discordDmListed: bool(a.discordDmListed, true),
    discordDmCheckout: bool(a.discordDmCheckout, false),
    discordWebhook: hook,
    discordMention: str(a.discordMention, 100).replace(/@(everyone|here)/g, '$1'),
    emailOnRestock: bool(a.emailOnRestock, false),
    emailOnCheckout: bool(a.emailOnCheckout, false),
    browserChecks: bool(a.browserChecks, true),
  };
}

// --- The card's backup in the member's account ----------------------------------
// Locked in the extension with a passphrase only the member knows (PBKDF2-SHA256 → AES-256-GCM):
// Mugibot keeps the locked copy and can't open it. Only its shape is checked here, plus the parts
// shown in the dashboard (the brand, the last 4 digits and the expiry).
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const CARD_BRANDS = ['Visa', 'Mastercard', 'Amex', 'Card'];
export function cardBackup(input, now = Date.now()) {
  const b = input || {};
  const b64 = (v, min, max, label) => {
    const s = String(v ?? '');
    if (!B64.test(s) || s.length < min || s.length > max) throw bad(`The card backup's ${label} isn't right`);
    return s;
  };
  // (Checked, not clamped: the data was locked with exactly this many.)
  const iterations = Number(b.iterations);
  if (!Number.isInteger(iterations) || iterations < 310000 || iterations > 5000000) throw bad("The card backup's lock isn't right");
  if (b.kdf !== 'PBKDF2-SHA256') throw bad("The card backup's lock isn't right");
  const last4 = String(b.last4 ?? '');
  const expMonth = String(b.expMonth ?? '');
  const expYear = String(b.expYear ?? '');
  if (!/^\d{4}$/.test(last4) || !/^(0[1-9]|1[0-2])$/.test(expMonth) || !/^20\d{2}$/.test(expYear)) throw bad("The card backup's details aren't right");
  return {
    v: 1, kdf: 'PBKDF2-SHA256', iterations,
    salt: b64(b.salt, 22, 88, 'salt'), iv: b64(b.iv, 16, 16, 'nonce'), ct: b64(b.ct, 24, 4096, 'data'),
    last4, brand: CARD_BRANDS.includes(b.brand) ? b.brand : 'Card', expMonth, expYear, hasCvc: !!b.hasCvc, savedAt: now,
  };
}

/** What the dashboard shows of a card backup (never the locked data). */
export const cardBackupInfo = (b) => (b ? { brand: b.brand, last4: b.last4, expMonth: b.expMonth, expYear: b.expYear, hasCvc: !!b.hasCvc, savedAt: b.savedAt } : null);

// --- The card's copy for reinstalls (from extension 1.20) ----------------------------------------
// Locked in the extension with a key the member's dashboard keeps in their browser (its own storage):
// Mugibot keeps the locked copy and never has the key. One copy per browser key — a few at most (each
// browser, and each address of the site, keeps its own key). Only its shape is checked here, plus the
// parts shown in the dashboard.
export const RESTORE_KEY_ID = /^[A-Za-z0-9_-]{16,40}$/;
export const MAX_RESTORE_COPIES = 4;
export function cardRestoreCopy(input, now = Date.now()) {
  const b = input || {};
  const iv = String(b.iv ?? '');
  const ct = String(b.ct ?? '');
  if (!B64.test(iv) || iv.length !== 16 || !B64.test(ct) || ct.length < 24 || ct.length > 4096) throw bad("The copy of your card isn't right");
  const last4 = String(b.last4 ?? '');
  const expMonth = String(b.expMonth ?? '');
  const expYear = String(b.expYear ?? '');
  if (!/^\d{4}$/.test(last4) || !/^(0[1-9]|1[0-2])$/.test(expMonth) || !/^20\d{2}$/.test(expYear)) throw bad("The copy of your card's details aren't right");
  // (host: the dashboard's address the key belongs to — where the card comes back.)
  const host = String(b.host ?? '').toLowerCase().replace(/[^a-z0-9.:-]/g, '').slice(0, 100);
  return { v: 1, iv, ct, last4, brand: CARD_BRANDS.includes(b.brand) ? b.brand : 'Card', expMonth, expYear, hasCvc: !!b.hasCvc, host, savedAt: now };
}

/** What the dashboard shows of the copies for reinstalls (never the locked data): switched on, and each copy's card. */
export const cardRestoreInfo = (doc) => ({
  on: !(doc && doc.off),
  copies: ((doc && doc.copies) || []).map((c) => ({ id: c.id, brand: c.brand, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, hasCvc: !!c.hasCvc, host: c.host || '', savedAt: c.savedAt })),
});
