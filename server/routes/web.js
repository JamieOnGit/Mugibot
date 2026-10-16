// Pages that do something when opened: "Connect Discord" (and Discord's
// redirect back), and the ⚡ Buy links in Discord messages.

import { purposeKey, verifyParts } from '../crypto.js';
import { entitlement } from '../entitlement.js';
import { num, str } from '../schema.js';
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
  // /buy/<item>?qty=1&t=<signed>: from your own DM — goes straight to the store (one of it; the
  // qty is only part of what was signed, so links from before quantities were dropped still work).
  // Without a valid signature (or from a channel post: /buy?store=…&sku=…) the
  // buy page asks you to press ⚡ Buy once.
  const m = p.match(/^\/buy\/([\w-]{4,60})$/);
  if (m) {
    if (!req.user) return loginFirst(res, url);
    const it = repo.getItem(req.user.id, m[1]);
    const qty = num(url.searchParams.get('qty'), { min: 1, max: 10, int: true, def: it ? it.quantity : 1 });
    const t = url.searchParams.get('t');
    if (it && it.url && t && entitlement(req.user, repo.now()).active
      && verifyParts(purposeKey(cfg.dataKey, 'buy-link'), [req.user.id, it.id, String(qty)], t, repo.now())) {
      const { url: go } = startBuy(ctx, req.user, it);
      return redirect(res, go);
    }
    return false; // the buy page (pages.js) shows the item and a ⚡ Buy button
  }
  if (p === '/buy' && !req.user) return loginFirst(res, url);
  return false;
}
