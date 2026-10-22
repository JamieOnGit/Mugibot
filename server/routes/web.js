// Pages that do something when opened: "Connect Discord" (and Discord's
// redirect back), and the ⚡ Buy links in Discord messages.

import { purposeKey, verifyParts } from '../crypto.js';
import { entitlement } from '../entitlement.js';
import { item as checkItem, num, str } from '../schema.js';
import { startBuy } from './user.js';

function redirect(res, to) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
  return true;
}

const loginFirst = (res, url) => redirect(res, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);

/** Returns true if it answered the request. */
export async function handleWebRoute(ctx, req, res, url) {
  const { cfg, repo, discord } = ctx;
  const p = url.pathname.replace(/\/+$/, '') || '/';

  // --- Connect Discord ---------------------------------------------------------------
  if (p === '/auth/discord') {
    if (!req.user) return loginFirst(res, url);
    if (!discord.oauthReady) return redirect(res, '/app?discord=not_configured#discord');
    return redirect(res, discord.authorizeUrl(repo.createOAuthState(req.user.id)));
  }
  if (p === '/auth/discord/callback') {
    if (!req.user) return loginFirst(res, url);
    const state = str(url.searchParams.get('state'), 100);
    if (url.searchParams.get('error')) return redirect(res, '/app?discord=cancelled#discord');
    if (!repo.useOAuthState(state, req.user.id)) return redirect(res, '/app?discord=expired#discord');
    try {
      const out = await discord.link(req.user, str(url.searchParams.get('code'), 200));
      repo.addEvent(req.user.id, { type: 'account', level: 'success', message: `Discord connected: ${out.username}${out.sync && out.sync.inGuild ? ' — you\'re in the members\' server' : ''}` });
      return redirect(res, `/app?discord=${out.sync && out.sync.error ? 'linked_with_problem' : 'linked'}#discord`);
    } catch (e) {
      cfg.log('[discord] connect failed:', e.message);
      return redirect(res, `/app?discord=failed&reason=${encodeURIComponent(e.message.slice(0, 200))}#discord`);
    }
  }

  // --- ⚡ Buy links -----------------------------------------------------------------------
  // One click: every ⚡ Buy goes straight to the store, with the product on its way into your bag.
  //   /buy/<item>?qty=<n>&t=<signed>: from your own DM — that many (the item's quantity when the DM went out;
  //     the qty is part of what was signed, and a link from before quantities says 1).
  //   /buy?store=…&sku=…&url=…&name=…&t=<signed>: a Monitor alert in a Discord channel — the same
  //     link for everyone, each with their own checkout; not on your watchlist yet, it's added.
  //   The same without a signature, pressed on Mugibot's own pages (the Monitor tab's ⚡ Buy).
  // Anything else (an expired link, someone else's link to /buy from another website) opens the
  // buy page, which asks you to press ⚡ Buy once: another site can't start a checkout for you.
  // (Pressed on one of Mugibot's pages: the browser says so — Referer, and Sec-Fetch-Site where it
  // sends it. Not passed on by the sign-in page, which follows any link it's given.)
  const fromHere = (() => {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return false;
    try {
      const ref = new URL(req.headers.referer);
      return ref.host === String(req.headers.host || '') && !/^\/(login|signup|forgot|reset)\/?$/.test(ref.pathname);
    } catch {
      return false;
    }
  })();
  const m = p.match(/^\/buy\/([\w-]{4,60})$/);
  if (m) {
    if (!req.user) return loginFirst(res, url);
    const it = repo.getItem(req.user.id, m[1]);
    const qty = num(url.searchParams.get('qty'), { min: 1, max: 10, int: true, def: it ? it.quantity : 1 });
    const t = url.searchParams.get('t');
    const signed = t && verifyParts(purposeKey(cfg.dataKey, 'buy-link'), [req.user.id, it ? it.id : '', String(qty)], t, repo.now());
    if (it && it.url && (signed || fromHere) && entitlement(req.user, repo.now()).active && ctx.limiter.hit(`go:${req.user.id}`, 60, 60 * 1000)) {
      const { url: go } = startBuy(ctx, req.user, it, { quantity: qty });
      return redirect(res, go);
    }
    return false; // the buy page (pages.js) shows the item and a ⚡ Buy button
  }
  if (p === '/buy') {
    if (!req.user) return loginFirst(res, url);
    if (fromHere || ctx.notifier.verifyAlertBuyLink(url.searchParams)) {
      const go = buyFromAlert(ctx, req.user, url.searchParams);
      if (go) return redirect(res, go);
    }
    return false; // the buy page: what went wrong, or the ⚡ Buy button
  }
  return false;
}

/**
 * A Monitor alert's ⚡ Buy, for this member: their own watchlist item for that product (added if
 * it isn't on it), then straight to the store. Null when it can't (no membership, a full
 * watchlist, no product link yet…): the buy page then says why.
 */
function buyFromAlert(ctx, user, params) {
  if (!entitlement(user, ctx.repo.now()).active || !ctx.limiter.hit(`go:${user.id}`, 60, 60 * 1000)) return null;
  try {
    const it = alertItem(ctx, user, { store: params.get('store'), sku: params.get('sku'), url: params.get('url'), name: params.get('name') });
    return it ? startBuy(ctx, user, it).url : null;
  } catch {
    return null;
  }
}

/**
 * A Monitor alert's product as this member's watchlist item: theirs if it's on their watchlist,
 * else added (with the alert's product link). Null when it can't be (a full watchlist, no link).
 * Also for Discord's ⚡ Buy button on an alert (routes/discord.js).
 */
export function alertItem(ctx, user, a) {
  const { cfg, repo, retailers } = ctx;
  const store = str(a.store, 40);
  const sku = str(a.sku, 60);
  // The alert's product link, as a watchlist item (only if it's that store's page).
  const fromLink = () => {
    if (!a.url) return null;
    const c = checkItem({ url: str(a.url, 1000), store, sku, name: str(a.name, 120) }, { retailers });
    return c.store === store && c.url ? c : null;
  };
  let it = repo.itemBySku(user.id, store, sku);
  if (!it) {
    const add = repo.countItems(user.id) < cfg.limits.items ? fromLink() : null;
    if (!add) return null;
    it = repo.addItem(user.id, add);
  } else if (!it.url) {
    // On the watchlist before its page was found: the alert has it (kept).
    const found = fromLink();
    if (found) it = repo.updateItem(user.id, it.id, { ...it, url: found.url }) || { ...it, url: found.url };
  }
  return it;
}
