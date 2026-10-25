// The stores Mugibot works with. Each retailer has its own file in this
// folder with its own checkout flow: which buttons to press, in which order,
// where its checkout page is, and which button is the final one (never pressed).
//
// The flows are plain data. The server sends them to the browser extension,
// so a retailer's flow can be fixed here and every member gets the fix
// without reinstalling the extension. Adding a brand-new retailer also needs
// a new extension build (its address goes into the extension's permissions).
//
// flowStatus: 'verified' = tested end to end on the real site
//             'beta'     = tested on the dummy store for that retailer only
//             'draft'    = a best guess, not tested yet

import amazon from './amazon.js';
import bigw from './bigw.js';
import cherrycollectables from './cherrycollectables.js';
import citybeach from './citybeach.js';
import collectiblemadness from './collectiblemadness.js';
import ebgames from './ebgames.js';
import fromthedeep from './fromthedeep.js';
import gameology from './gameology.js';
import gamerholic from './gamerholic.js';
import gamesmen from './gamesmen.js';
import gamesworld from './gamesworld.js';
import goodgames from './goodgames.js';
import jbhifi from './jbhifi.js';
import kmart from './kmart.js';
import pbandai from './pbandai.js';
import pokebox from './pokebox.js';
import pokemoncenter from './pokemoncenter.js';
import shoplink, { cartLines } from './shoplink.js';
import target from './target.js';
import thegamescube from './thegamescube.js';
import toysrus from './toysrus.js';
import trainertown from './trainertown.js';
import zing from './zing.js';

export const RETAILER_DEFS = [kmart, bigw, target, ebgames, zing, jbhifi, toysrus, trainertown, amazon, thegamescube, gamerholic, pokemoncenter, pbandai, citybeach,
  pokebox, goodgames, collectiblemadness, cherrycollectables, gamesmen, gamesworld, gameology, fromthedeep, shoplink];

// Card boxes are often in a frame hosted by the store's payment provider.
export const PAYMENT_HOSTS = [
  'https://*.adyen.com/*',
  'https://*.braintreegateway.com/*',
  'https://js.stripe.com/*',
  'https://*.cybersource.com/*',
  'https://*.checkout.com/*',
  'https://*.worldpay.com/*',
  'https://*.qvalent.com/*',
  'https://*.payway.com.au/*',
  'https://*.windcave.com/*',
  'https://*.eway.io/*',
  'https://*.securepay.com.au/*',
  // Shopify's card fields (JB Hi-Fi, Toys"R"Us, Gamerholic, Trainer Town): checkout.pci.shopifyinc.com
  // since 2024 — one frame per box; checkout.shopifycs.com before that.
  'https://checkout.pci.shopifyinc.com/*',
  'https://checkout.shopifycs.com/*',
  // Paydock (Target's card form), with the Mastercard gateway behind it (its card boxes can come from there).
  'https://*.paydock.com/*',
  'https://ap-gateway.mastercard.com/*',
  // Fat Zebra (an Australian payment provider).
  'https://*.pmnts.io/*',
  // Global-e (Premium Bandai's checkout): the whole checkout is in its frame, delivery details too.
  'https://*.global-e.com/*',
  // Card forms Australian Magento and WooCommerce stores use (The Gamesmen's, Games World's — Stripe's
  // is above): PayPal's own card fields, Square's, Tyro's and Pin Payments'.
  'https://*.paypal.com/*',
  'https://*.squarecdn.com/*',
  'https://*.tyro.com/*',
  'https://cdn.pinpayments.com/*',
];

export const OTHER_STORE = { id: 'other', name: 'Other website', flowStatus: 'none', monitor: { server: true, browser: false }, hosts: [] };

const LOCAL = new Set(['localhost', '127.0.0.1']);

/** A retailer's copy in the dummy store: same flow, on the dummy store's address under its own path. */
function demoCopy(def, demoUrl) {
  const u = new URL(demoUrl);
  const port = u.port ? `:${u.port}` : '';
  const hosts = LOCAL.has(u.hostname) ? [...LOCAL].map((h) => `${h}${port}`) : [u.host];
  const base = `${u.origin}${def.devPath}`;
  return {
    ...def,
    id: `demo-${def.id}`,
    name: `${def.name} (dummy store)`,
    base,
    // A search provider (Kmart's Constructor.io): the dummy store has its own copy.
    ...(def.sweep && def.sweep.apiBase ? { sweep: { ...def.sweep, apiBase: `${base}/cnstrc` } } : {}),
    // A checkout in a frame of its own (Global-e's, Amazon's quick checkout): the dummy store's copy of it too.
    ...(def.devFrames && def.flow && def.flow.checkout
      ? { flow: { ...def.flow, checkout: { ...def.flow.checkout, frames: [...(def.flow.checkout.frames || []), ...def.devFrames] } } } : {}),
    hosts,
    pathPrefix: def.devPath,
    demo: true,
    realId: def.id,
    // (A store whose items are checked more often — Shop checkout links — is in the dummy store too.)
    monitor: {
      server: true, browser: true,
      ...(def.monitor && def.monitor.intervalSeconds ? { intervalSeconds: def.monitor.intervalSeconds, floorSeconds: def.monitor.floorSeconds, hostGapSeconds: def.monitor.hostGapSeconds } : {}),
      // (Its pages opened in the extension's window for in-browser checks, at its pace: the dummy store's copy too.)
      ...(def.monitor && def.monitor.render ? { render: true, browserSeconds: def.monitor.browserSeconds, ...(def.monitor.privateWindow ? { privateWindow: true } : {}) } : {}),
      // (…or asked for from inside a tab of the store: the dummy store's copy too.)
      ...(def.monitor && def.monitor.inPage ? { inPage: true } : {}),
    },
  };
}

/**
 * The latest sign-in reading at a store across a member's browsers (each one's logins[store]), with the
 * browser's name — at a store read off the screen (check.onScreen, Shop's), only readings made that way
 * or by a run: an older extension read Shop's pages' source, which says "Sign in to your account"
 * either way, and took members signed in for signed out.
 */
export function latestLogin(r, devices, id = r && r.id) {
  const screenOnly = !!(r && r.account && r.account.check && r.account.check.onScreen);
  let best = null;
  for (const d of devices || []) {
    const l = d.logins && d.logins[id];
    if (!l || (screenOnly && !['screen', 'run'].includes(l.how))) continue;
    if (!best || l.at > best.at) best = { ...l, device: d.name };
  }
  return best;
}

/** RegExps → { re, f } so flows can travel as JSON (the extension turns them back). */
export function serialize(v) {
  if (v instanceof RegExp) return { re: v.source, f: v.flags };
  if (Array.isArray(v)) return v.map(serialize);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, serialize(x)]));
  return v;
}

function pathOf(url) {
  let p = url.pathname;
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  return p;
}

export class Retailers {
  /** getSetting(key) → stored admin overrides, e.g. { enabled: false } */
  constructor(cfg, getSetting = () => null) {
    this.cfg = cfg;
    this.getSetting = getSetting;
    const demo = cfg.demoStoreUrl ? RETAILER_DEFS.filter((d) => d.devPath).map((d) => demoCopy(d, cfg.demoStoreUrl)) : [];
    // Dummy-store copies first: their path prefix makes them more specific.
    this.list = [...demo, ...RETAILER_DEFS];
  }

  get(id) {
    if (id === 'other') return OTHER_STORE;
    return this.list.find((r) => r.id === id) || null;
  }

  /** Admin switches for one retailer. */
  settings(r) {
    if (!r || r.id === 'other') return { enabled: true, serverChecks: true, browserChecks: false };
    const saved = this.getSetting(`retailer:${r.id}`) || {};
    return {
      enabled: saved.enabled !== false,
      // (server 'never': a store that refuses every server — BIG W — whatever an admin saved before.)
      serverChecks: r.monitor.server === 'never' ? false : saved.serverChecks ?? r.monitor.server !== false,
      browserChecks: saved.browserChecks ?? r.monitor.browser !== false,
    };
  }

  enabled(r) {
    return !!r && this.settings(r).enabled;
  }

  /**
   * The retailer a link belongs to (null for any other website). A cart link (/cart/<variant>:<qty>) at
   * a store Mugibot doesn't know is a Shop checkout link (retailers/shoplink.js) — the dummy store's
   * copy for a link on the dummy store's address.
   */
  forUrl(url) {
    let u;
    try { u = url instanceof URL ? url : new URL(url); } catch { return null; }
    const host = u.host.toLowerCase();
    const p = pathOf(u);
    const hostOk = (r) => r.hosts.some((h) => host === h || host.endsWith(`.${h.replace(/^www\./, '')}`));
    const known = this.list.find((r) => hostOk(r) && (!r.pathPrefix || p === r.pathPrefix || p.startsWith(`${r.pathPrefix}/`)));
    if (known) return known;
    if (!/^https?:$/.test(u.protocol) || !cartLines(p)) return null;
    return this.list.find((r) => r.cartLinks && (!r.demo || hostOk(r))) || null;
  }

  /** Best guess at the product code in a product link. */
  skuFromUrl(url) {
    let u;
    try { u = new URL(url); } catch { return ''; }
    const p = pathOf(u);
    const r = this.forUrl(u);
    // A Shop checkout link: its options and quantities ("48835830579405:2,40653613531341:1").
    if (r && r.cartLinks && cartLines(p)) return cartLines(p).map((x) => `${x.id}:${x.qty}`).join(',');
    if (r && r.skuFromPath) {
      const m = p.match(r.skuFromPath);
      if (m) return m[1];
    }
    const shopify = p.match(/\/products\/([^/?#.]+)/);
    if (shopify) return shopify[1];
    const digits = p.match(/(\d{6,12})(?!.*\d{6,12})/);
    return digits ? digits[1] : '';
  }

  name(storeId) {
    const r = this.get(storeId);
    return r ? r.name : storeId;
  }

  /** A store's name — or, for another website, its address ("shop.example.com"); a Shop checkout link's, its store's ("creations.mattel.com · Shop"). */
  siteName(storeId, url = '') {
    const r = this.get(storeId);
    if ((storeId === 'other' || (r && r.cartLinks)) && url) {
      try { const host = new URL(url).host.replace(/^www\./, ''); return storeId === 'other' ? host : `${host} · ${r.name}`; } catch { /* not a link */ }
    }
    return this.name(storeId);
  }

  /** Does Mugibot check out at this store (⚡ Buy, Auto-checkout)? Not at another website. */
  canBuy(storeId) {
    const r = this.get(storeId);
    return !!(r && r.flow);
  }

  /** Stores whose product links are built from the code alone (Amazon's ASIN, a Shopify handle). */
  productUrlFromSku(r, sku) {
    if (!r || !r.base || !sku || !r.productPathFromSku) return null;
    return `${r.base}${r.productPathFromSku.replace('{sku}', encodeURIComponent(sku))}`;
  }

  /**
   * The store's own add-to-cart link, where it has one (Shopify cart links, Amazon's add-to-cart
   * link): opens the store with the product already in the cart. null when the store has none.
   */
  cartUrl(storeId, { sku, variantId = '', qty = 1 } = {}) {
    const r = this.get(storeId);
    if (!r || !r.base || !r.cartPath) return null;
    if (r.cartPath.includes('{variant}') && !variantId) return null;
    return `${r.base}${r.cartPath.replace('{variant}', encodeURIComponent(variantId)).replace('{sku}', encodeURIComponent(sku || '')).replace('{qty}', String(qty))}`;
  }

  /** Where to look for a SKU that doesn't have a product link yet. */
  searchUrl(r, sku) {
    if (!r || !r.base || !sku || !r.searchPath) return null;
    return `${r.base}${r.searchPath.replace('{q}', encodeURIComponent(sku))}`;
  }

  /** For the dashboard's store picker and the admin page. */
  publicList({ all = false } = {}) {
    return this.list.filter((r) => all || this.enabled(r)).map((r) => ({
      id: r.id, name: r.name, base: r.base, flowStatus: r.flowStatus, flowNote: r.flowNote, skuLabel: r.skuLabel, skuHint: r.skuHint,
      demo: !!r.demo, searchable: !!(r.searchPath || r.productPathFromSku), ...this.settings(r),
      // (Shop checkout links: added by their link only, in a section of their own.)
      cartLinks: !!r.cartLinks,
    }));
  }

  /** What the browser extension needs: where each flow applies and the flow itself. */
  forExtension() {
    return this.list.filter((r) => this.enabled(r)).map((r) => serialize({
      id: r.id, name: r.name, hosts: r.hosts, pathPrefix: r.pathPrefix || null, flowStatus: r.flowStatus, platform: r.platform || null,
      skuFromPath: r.skuFromPath, productPath: r.productPath, cartPath: r.cartPath || null, flow: r.flow,
      // The store login monitor: the store's address, and how to tell you're signed in there.
      base: r.base, account: r.account || null,
      // Its checkpoint or virtual queue (monitor/gate.js): what one of its pages looks like.
      gate: r.gate ? { kind: r.gate.kind, label: r.gate.label, page: r.gate.page } : null,
      // Shop checkout links: each its own checkout (no bag shared with another), opened by the link itself.
      cartLinks: !!r.cartLinks,
    }));
  }
}
