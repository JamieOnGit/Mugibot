// Admin console: members, memberships, Discord, SKUs, stores and setup.
// (No access to members' addresses, cards, watchlists or activity.)
import { $, $$, api, h, initThemeToggle, toast, when } from './common.js';

initThemeToggle($('#theme-toggle'));

const PAGE = 50;
let offset = 0;
let total = 0;
const date = (ts) => (ts ? new Date(ts).toLocaleDateString() : '—');
const loaders = {};
const TABS = ['overview', 'members', 'skus', 'blacklist', 'news', 'retailers', 'integrations', 'whop', 'audit'];
const STATUS = { in_stock: 'in stock', preorder: 'pre-order', out_of_stock: 'sold out', coming_soon: 'coming soon', in_store: 'in store only', not_listed: 'not listed', not_found: 'gone', blocked: 'blocked', error: 'error', pending: 'pending', unknown: 'unknown' };

function showTab() {
  const tab = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  $$('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  loaders[tab]().catch((e) => toast('Something went wrong', e.message, 'warn'));
}
window.addEventListener('hashchange', showTab);

// --- Overview -------------------------------------------------------------------
loaders.overview = async () => {
  const [s, integ] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/integrations')]);
  const box = $('#stats');
  box.textContent = '';
  const stat = (label, n) => box.append(h('div', { class: 'card stat' }, h('div', { class: 'n' }, String(n)), h('div', { class: 'muted small' }, label)));
  stat('Accounts', s.users);
  stat('Paying members', (s.plans.active || 0) + (s.plans.past_due || 0));
  stat('Payment failed', s.plans.past_due || 0);
  stat('Free access', s.plans.comped || 0);
  stat('Not members', (s.plans.none || 0) + (s.plans.canceled || 0));
  stat('Sign-ups (7 days)', s.signups7d);
  stat('Discord connected', s.discordLinked);
  stat('In the server', s.discordInServer);
  stat('SKUs watched', s.watchedSkus);
  stat('Unlinked Whop memberships', s.unlinkedMemberships);
  const hints = $('#setup-hints');
  hints.textContent = '';
  const todo = [];
  if (!integ.whop.apiKey || !integ.whop.planId) todo.push('Whop: set WHOP_API_KEY and WHOP_PLAN_ID so members can subscribe (docs/WHOP.md).');
  if (!integ.whop.webhookSecret) todo.push('Whop: set WHOP_WEBHOOK_SECRET so memberships update automatically.');
  if (!integ.discord.oauth) todo.push('Discord: set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET so members can connect Discord (docs/DISCORD.md).');
  if (!integ.discord.bot) todo.push('Discord: set DISCORD_BOT_TOKEN and DISCORD_GUILD_ID for DMs, server access and channel posts.');
  if (!integ.discord.memberRoleId) todo.push('Discord: set DISCORD_MEMBER_ROLE_ID so members get (and lose) the members\' role.');
  if (!integ.discord.commands) todo.push('Discord: set DISCORD_PUBLIC_KEY and run "npm run discord:commands" for slash commands.');
  hints.append(h('h2', {}, todo.length ? 'Still to set up' : 'All set up ✓'), todo.length ? h('ul', { class: 'plain' }, ...todo.map((t) => h('li', {}, t))) : h('p', { class: 'muted' }, 'Run the Setup check tab to confirm the Discord bot\'s permissions.'));
};

// --- Members ----------------------------------------------------------------------
function planText(u) {
  if (u.role === 'admin') return 'Admin';
  if (u.plan === 'trial') return u.trial_ends_at > Date.now() ? `Trial until ${date(u.trial_ends_at)}` : 'Trial ended';
  return { active: u.cancel_at_period_end ? `Member (ends ${date(u.current_period_end)})` : 'Member', past_due: 'Payment failed', canceled: 'Ended', comped: 'Free access', none: 'Not a member' }[u.plan] || u.plan;
}

async function act(u, body, label) {
  try {
    await api('PUT', `/api/admin/users/${u.id}`, body);
    toast(label, u.username, 'success');
    loadUsers();
  } catch (e) {
    toast("Couldn't do that", e.message, 'warn');
  }
}

async function post(path, body, ok) {
  try {
    const r = await api('POST', path, body);
    if (ok) ok(r);
    return r;
  } catch (e) {
    toast("Couldn't do that", e.message, 'warn');
    return null;
  }
}

function actions(u) {
  const plan = h('select', { 'aria-label': `Plan for ${u.username}` },
    ...['none', 'trial', 'active', 'past_due', 'canceled', 'comped'].map((p) => h('option', { value: p, selected: p === u.plan }, p === 'comped' ? 'comped (free access)' : p)));
  plan.addEventListener('change', () => act(u, { plan: plan.value }, `Plan set to ${plan.value}`));
  return h('div', { class: 'acts status-row' },
    plan,
    h('button', { class: 'btn small', type: 'button', onclick: () => { const d = prompt(`Give ${u.username} a free trial / extend it by how many days?`, '7'); if (d) act(u, { extendTrialDays: Number(d) }, `Trial extended by ${d} days`); } }, '+ Trial'),
    h('button', { class: 'btn small', type: 'button', onclick: () => act(u, { disabled: !u.disabled }, u.disabled ? 'Unsuspended' : 'Suspended') }, u.disabled ? 'Unsuspend' : 'Suspend'),
    h('button', { class: 'btn small', type: 'button', onclick: () => act(u, { role: u.role === 'admin' ? 'user' : 'admin' }, u.role === 'admin' ? 'No longer admin' : 'Made admin') }, u.role === 'admin' ? 'Remove admin' : 'Make admin'),
    h('button', {
      class: 'btn small', type: 'button',
      onclick: () => post(`/api/admin/users/${u.id}/reset-link`, {}, (r) => {
        prompt(`Password-reset link for ${u.username} (works once, for 1 hour).${r.sent ? ` Also sent to their ${r.sent > 1 ? 'email and Discord' : 'email or Discord'}.` : ''} Copy it and send it to them:`, r.link);
      }),
    }, 'Reset link'),
    u.discord_id ? h('button', { class: 'btn small', type: 'button', onclick: () => post(`/api/admin/users/${u.id}/discord-sync`, {}, (r) => { toast(r.sync.error ? 'Discord: not quite' : 'Discord synced', r.sync.error || u.username, r.sync.error ? 'warn' : 'success'); loadUsers(); }) }, 'Sync Discord') : null,
    h('button', {
      class: 'btn small', type: 'button',
      onclick: () => {
        const id = prompt(`Link a Whop membership to ${u.username}. Membership ID (mem_…) or license key:`, u.whop_membership_id || '');
        if (id) post(`/api/admin/users/${u.id}/whop-link`, { membership: id }, (r) => { toast('Whop membership linked', `${u.username}: ${r.plan}`, 'success'); loadUsers(); });
      },
    }, 'Link Whop'),
    u.whop_membership_id ? h('button', { class: 'btn small', type: 'button', onclick: () => post(`/api/admin/users/${u.id}/whop-sync`, {}, (r) => { toast('Refreshed from Whop', `${u.username}: ${r.plan}`, 'success'); loadUsers(); }) }, 'Refresh Whop') : null,
    h('button', {
      class: 'btn small', type: 'button',
      onclick: async () => { if (confirm(`Sign ${u.username} out everywhere (browsers and extensions)?`)) { await post(`/api/admin/users/${u.id}/signout`, {}); toast('Signed out', u.username, 'success'); } },
    }, 'Sign out'),
    h('button', {
      class: 'btn small danger', type: 'button',
      onclick: async () => {
        const confirmName = prompt(`This deletes ${u.username}'s account and all their data, cancels their Whop membership and removes their Discord role.\nType their username to confirm:`);
        if (confirmName === null) return;
        try {
          await api('DELETE', `/api/admin/users/${u.id}`, { confirm: confirmName });
          toast('Account deleted', u.username, 'success');
          loadUsers();
        } catch (e) { toast("Couldn't delete", e.message, 'warn'); }
      },
    }, 'Delete'));
}

async function loadUsers() {
  const q = $('#q').value.trim();
  const r = await api('GET', `/api/admin/users?limit=${PAGE}&offset=${offset}&q=${encodeURIComponent(q)}&plan=${encodeURIComponent($('#plan-filter').value)}`);
  total = r.total;
  const body = $('#users');
  body.textContent = '';
  if (!r.users.length) body.append(h('tr', {}, h('td', { colspan: '7', class: 'empty' }, 'No members found.')));
  for (const u of r.users) {
    const discord = u.discord_id
      ? [h('div', {}, u.discord_username || u.discord_id), h('div', { class: 'muted small' }, u.discord_in_guild ? (u.discord_role ? 'in server · member role' : 'in server') : 'not in server'), u.discord_error ? h('div', { class: 'small warn-text' }, u.discord_error) : null]
      : [h('span', { class: 'muted' }, 'not connected')];
    body.append(h('tr', { dataset: { id: u.id } },
      h('td', {}, h('b', {}, u.username), u.email ? h('div', { class: 'muted small' }, u.email) : null, u.disabled ? h('span', { class: 'pill err' }, 'Suspended') : null),
      h('td', {}, planText(u), u.whop_membership_id ? h('div', { class: 'muted small' }, u.whop_membership_id) : null),
      h('td', {}, ...discord),
      h('td', {}, date(u.created_at)),
      h('td', {}, u.last_login_at ? when(u.last_login_at) : '—'),
      h('td', { class: 'small' }, `${u.items} SKUs · ${u.devices} browsers`),
      h('td', {}, actions(u))));
  }
  $('#page-info').textContent = total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : '';
  $('#prev').disabled = offset === 0;
  $('#next').disabled = offset + PAGE >= total;
}
loaders.members = loadUsers;
$('#search').addEventListener('submit', (e) => { e.preventDefault(); offset = 0; loadUsers(); });
$('#plan-filter').addEventListener('change', () => { offset = 0; loadUsers(); });
$('#prev').addEventListener('click', () => { offset = Math.max(0, offset - PAGE); loadUsers(); });
$('#next').addEventListener('click', () => { offset += PAGE; loadUsers(); });

// --- SKUs and restock pings ----------------------------------------------------------
let retailerList = [];
async function ensureRetailers() {
  if (!retailerList.length) retailerList = (await api('GET', '/api/admin/retailers')).retailers;
  return retailerList;
}

loaders.skus = async () => {
  const [{ skus }, retailers] = await Promise.all([api('GET', '/api/admin/skus'), ensureRetailers()]);
  const sel = $('#r-store');
  if (!sel.options.length) for (const r of retailers) sel.append(h('option', { value: r.id }, r.name));
  const body = $('#skus');
  body.textContent = '';
  if (!skus.length) body.append(h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'Nobody is watching anything yet.')));
  for (const s of skus) {
    const statuses = Object.entries(s.statuses || {}).map(([k, n]) => `${n} ${STATUS[k] || k}`).join(' · ');
    const server = s.server ? `${STATUS[s.server.status] || s.server.status || 'pending'}${s.server.checked_at ? ` · ${when(s.server.checked_at)}` : ''}${s.server.error ? ` · ${s.server.error}` : ''}` : (s.url ? 'pending' : 'looking for the page');
    body.append(h('tr', {},
      h('td', {}, h('b', {}, s.name), s.announced ? ' 📣' : '', h('div', { class: 'muted small' }, `${s.storeName} · ${s.sku}`), s.url ? h('a', { class: 'small', href: s.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null),
      h('td', {}, `${s.watchers} (${s.monitoring} monitoring)`),
      h('td', { class: 'small' }, statuses),
      h('td', { class: 'small' }, server),
      h('td', {}, h('button', { class: 'btn small', type: 'button', onclick: () => { $('#r-store').value = s.store; $('#r-sku').value = s.sku; $('#r-note').focus(); } }, 'Ping…'))));
  }
};

$('#restock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const store = $('#r-store').value;
  const sku = $('#r-sku').value.trim();
  if (!confirm(`Ping everyone watching ${sku} that it's in stock?`)) return;
  const r = await post('/api/admin/restock', { store, sku, note: $('#r-note').value });
  if (r) {
    $('#r-msg').textContent = `Pinged ${r.pinged} of ${r.watchers} watchers${r.posted ? ' and posted in the restock channel' : ''}.`;
    $('#r-msg').className = 'msg ok';
  }
});

// --- Blacklist: products (or whole stores) that never ping -----------------------------
loaders.blacklist = async () => {
  const [{ entries }, retailers] = await Promise.all([api('GET', '/api/admin/blacklist'), ensureRetailers()]);
  const sel = $('#bl-store');
  if (sel.options.length < 2) for (const r of retailers) sel.append(h('option', { value: r.id }, r.name));
  const body = $('#blacklist');
  body.textContent = '';
  if (!entries.length) body.append(h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'Nothing on the blacklist.')));
  for (const e of entries) {
    const what = e.sku ? (e.name || `SKU ${e.sku}`) : 'Every product';
    body.append(h('tr', {},
      h('td', {}, h('b', {}, what), e.sku ? h('div', { class: 'muted small' }, `SKU ${e.sku}`) : null),
      h('td', {}, e.storeName),
      h('td', { class: 'small' }, e.note || '—'),
      h('td', { class: 'small' }, date(e.createdAt)),
      h('td', {}, h('button', {
        class: 'btn small', type: 'button', 'aria-label': `Take ${what} at ${e.storeName} off the blacklist`,
        onclick: async () => {
          try {
            await api('DELETE', `/api/admin/blacklist/${e.id}`);
            $('#bl-msg').textContent = '';
            toast('Off the blacklist', `${what} · ${e.storeName}`, 'success');
            loaders.blacklist();
          } catch (err) { toast("Couldn't do that", err.message, 'warn'); }
        },
      }, 'Remove'))));
  }
};

$('#bl-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const store = $('#bl-store').value;
  const sku = $('#bl-sku').value.trim();
  if (!store && !sku) {
    $('#bl-msg').textContent = 'Choose a store, enter a SKU, or both.';
    $('#bl-msg').className = 'msg err';
    return;
  }
  if (store && !sku && !confirm(`Blacklist every product at ${$('#bl-store').selectedOptions[0].textContent}? Nothing there will ping until you take it off.`)) return;
  const r = await post('/api/admin/blacklist', { store, sku, note: $('#bl-note').value });
  if (!r) return;
  $('#bl-msg').textContent = r.created ? `Added${r.monitorsRemoved ? `, and removed ${r.monitorsRemoved} monitor${r.monitorsRemoved === 1 ? '' : 's'}` : ''}.` : 'Already on the blacklist.';
  $('#bl-msg').className = 'msg ok';
  $('#bl-sku').value = '';
  $('#bl-note').value = '';
  loaders.blacklist();
});

// --- News: release news (docs/NEWS.md) — admins' own, the news feeds', and #news ---------------
const news = { data: null, editing: null };
// (Release days are days in Sydney, like the stores'.)
const SYDNEY_DAY = new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayBox = (ms) => {
  if (!ms) return '';
  const p = Object.fromEntries(SYDNEY_DAY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
const releaseDay = (ms) => new Date(ms).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const tick = (ok, label, detail) => h('li', {}, h('span', { class: ok ? 'ok-mark' : 'no-mark' }, ok ? '✓' : '✕'), h('div', {}, h('b', {}, label), detail ? h('div', { class: 'muted small' }, detail) : null));

async function newsCall(method, path, body, done) {
  try {
    const r = await api(method, path, body);
    if (r && r.items) renderNews(r);
    if (done) done(r);
    return r;
  } catch (e) {
    toast("Couldn't do that", e.message, 'warn');
    return null;
  }
}

function newsForm(item = null) {
  news.editing = item ? item.id : null;
  $('#nw-form-title').textContent = item ? 'Edit news' : 'Add news';
  $('#nw-save').textContent = item ? 'Save changes' : 'Add news';
  $('#nw-cancel').hidden = !item;
  $('#nw-title').value = item ? item.title : '';
  $('#nw-url').value = item ? item.url : '';
  $('#nw-date').value = item ? dayBox(item.releaseAt) : '';
  $('#nw-category').value = item ? item.category : '';
  $('#nw-summary').value = item ? item.summary : '';
  $('#nw-post').checked = !item;
  const ids = new Set(item ? item.stores.map((s) => s.id) : []);
  for (const box of $$('#nw-stores input')) box.checked = ids.has(box.value);
  if (item) $('#nw-form').scrollIntoView({ block: 'start' });
}

function renderNews(d) {
  news.data = d;
  const cat = $('#nw-category');
  if (cat.options.length < 2) for (const [k, v] of Object.entries(d.categories)) cat.append(h('option', { value: k }, v));
  const stores = $('#nw-stores');
  if (!stores.querySelector('input')) for (const s of d.stores) stores.append(h('label', { class: 'check inline' }, h('input', { type: 'checkbox', value: s.id }), s.name));

  const body = $('#nw-items');
  body.textContent = '';
  if (!d.items.length) body.append(h('tr', {}, h('td', { colspan: '6', class: 'empty' }, 'No news yet. Add some above, or wait for the feeds.')));
  for (const x of d.items) {
    body.append(h('tr', {},
      h('td', { class: 'small' }, x.releaseAt ? releaseDay(x.releaseAt) : x.releaseText || '—'),
      h('td', {}, x.url ? h('a', { href: x.url, target: '_blank', rel: 'noopener' }, h('b', {}, x.title)) : h('b', {}, x.title),
        h('div', { class: 'muted small' }, `${d.categories[x.category] || x.category}${x.summary ? ` · ${x.summary.slice(0, 140)}${x.summary.length > 140 ? '…' : ''}` : ''}`)),
      h('td', { class: 'small' }, x.stores.map((s) => s.name).join(', ') || '—'),
      h('td', { class: 'small' }, x.source === 'admin' ? 'Admin' : x.sourceName, h('div', { class: 'muted small' }, when(x.at))),
      h('td', { class: 'small' }, x.postedAt ? when(x.postedAt) : h('span', { class: 'muted' }, 'not posted')),
      h('td', {}, h('div', { class: 'acts status-row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => newsCall('POST', `/api/admin/news/${x.id}/post`, {}, () => toast('Posted in #news', x.title, 'success')) }, x.postedAt ? 'Post again' : 'Post now'),
        h('button', { class: 'btn small', type: 'button', onclick: () => newsForm(x) }, 'Edit'),
        h('button', { class: 'btn small danger', type: 'button', 'aria-label': `Delete ${x.title}`, onclick: () => { if (confirm(`Delete "${x.title}"? (A post in #news stays there.)`)) newsCall('DELETE', `/api/admin/news/${x.id}`); } }, 'Delete')))));
  }

  const ch = $('#nw-channel');
  ch.textContent = '';
  // (The role it pings now: pressing "Set up #news" again keeps it — an empty box pings no one.)
  if (document.activeElement !== $('#nw-role')) $('#nw-role').value = (d.newsChannel && d.newsChannel.roleId) || '';
  ch.append(
    tick(d.bot, 'Discord bot', d.bot ? 'Ready' : 'Not set up yet (Setup check) — news still shows on the dashboard'),
    tick(!!d.newsChannel, '#news', d.newsChannel ? `Channel ${d.newsChannel.channelId}${d.newsChannel.roleId ? ` · pings role ${d.newsChannel.roleId}` : ' · pings no one'}` : 'Not set up yet: the bot finds it by name (or makes it) the first time there\'s news to post'),
    tick(!!d.digest, '📅 Coming up', d.digest ? `Last posted ${d.digest.day} (${d.digest.count} release${d.digest.count === 1 ? '' : 's'})` : 'Each morning at 8:31 (Sydney), when something comes out in the next 14 days'));

  $('#nf-help').textContent = `Each feed is read every ${d.everyMinutes} minutes${d.running ? '' : ' (not on this server: its monitor is off)'}, as Mugibot. An entry becomes news when its title reads like a release — pre-orders, a release date, launches, restocks, drops… — and it names a hyped product, or one of the feed's own words. A feed's first read only sets the scene: nothing in it is posted.`;
  $('#nf-words-list').textContent = `Hyped products: ${d.defaults.words.join(', ')}. Left out when the title says: ${d.defaults.notWords.join(', ')}. A feed's own words are added to the hyped products; "-word" leaves out entries with that word in the title.`;
  const feeds = $('#nf-feeds');
  feeds.textContent = '';
  if (!d.feeds.length) feeds.append(h('tr', {}, h('td', { colspan: '6', class: 'empty' }, 'No feeds. Add one above.')));
  for (const f of d.feeds) {
    const on = h('input', { type: 'checkbox', checked: f.enabled, 'aria-label': `${f.name} on` });
    on.addEventListener('change', () => newsCall('PUT', `/api/admin/news/feeds/${f.id}`, { enabled: on.checked }, () => toast('Saved', `${f.name}: ${on.checked ? 'on' : 'off'}`, 'success')));
    const last = !f.lastFetchAt ? h('span', { class: 'muted' }, 'not yet')
      : [h('div', {}, when(f.lastFetchAt)), f.lastError
        ? h('div', { class: 'small warn-text' }, `${f.lastError}${f.nextAt ? ` — tries again ${when(f.nextAt)}` : ''}`)
        : h('div', { class: 'muted small' }, f.lastResult)];
    feeds.append(h('tr', {},
      h('td', {}, h('b', {}, f.name), h('div', { class: 'small wrap-anywhere' }, h('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.url))),
      h('td', {}, on),
      h('td', { class: 'small' }, f.keywords || h('span', { class: 'muted' }, 'the defaults')),
      h('td', { class: 'small' }, last),
      h('td', { class: 'small' }, String(f.found)),
      h('td', {}, h('div', { class: 'acts status-row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => newsCall('POST', '/api/admin/news/feeds/check', { id: f.id }, (r) => { const x = r.results[0]; toast(x.ok ? `Read ${f.name}` : `${f.name}: not read`, x.ok ? (x.notModified ? 'Nothing new' : `${x.added} new`) : x.error, x.ok ? 'success' : 'warn'); }) }, 'Check'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { const w = prompt(`Words for ${f.name}, comma-separated — added to the hyped products. "-word" leaves out entries with it in the title. Empty: just the defaults.`, f.keywords); if (w !== null) newsCall('PUT', `/api/admin/news/feeds/${f.id}`, { keywords: w }); } }, 'Words…'),
        h('button', { class: 'btn small danger', type: 'button', 'aria-label': `Remove ${f.name}`, onclick: () => { if (confirm(`Stop reading ${f.name}? (The news it found stays.)`)) newsCall('DELETE', `/api/admin/news/feeds/${f.id}`); } }, 'Remove')))));
  }
}

loaders.news = async () => renderNews(await api('GET', '/api/admin/news'));

$('#nw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    title: $('#nw-title').value.trim(), url: $('#nw-url').value.trim(), releaseAt: $('#nw-date').value || null,
    category: $('#nw-category').value || undefined, summary: $('#nw-summary').value.trim(), stores: $$('#nw-stores input').filter((b) => b.checked).map((b) => b.value),
  };
  const msg = $('#nw-msg');
  try {
    const editing = news.editing;
    const r = editing ? await api('PUT', `/api/admin/news/${editing}`, body) : await api('POST', '/api/admin/news', { ...body, post: $('#nw-post').checked });
    let posted = !!r.posted;
    let problem = r.postError || '';
    if (editing && $('#nw-post').checked) {
      try { renderNews(await api('POST', `/api/admin/news/${editing}/post`, {})); posted = true; } catch (err) { problem = err.message; }
    } else {
      renderNews(r);
    }
    msg.textContent = `${editing ? 'Saved' : 'Added'}${posted ? ' and posted in #news' : ''}.${problem ? ` Not posted: ${problem}` : ''}`;
    msg.className = `msg ${problem ? 'err' : 'ok'}`;
    newsForm();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  }
});
$('#nw-cancel').addEventListener('click', () => { newsForm(); $('#nw-msg').textContent = ''; });

$('#nw-setup').addEventListener('click', () => newsCall('POST', '/api/admin/news/channel', { roleId: $('#nw-role').value.trim() }, (r) => {
  $('#nw-channel-msg').textContent = `Done: #${r.channel.name} ${r.channel.made ? 'made' : 'found'}${r.roleId ? `, pinging role ${r.roleId}` : ''}.`;
  $('#nw-channel-msg').className = 'msg ok';
}));
$('#nw-digest').addEventListener('click', async () => {
  try {
    const r = await api('POST', '/api/admin/news/digest', {});
    $('#nw-channel-msg').textContent = `Posted 📅 Coming up: ${r.count} release${r.count === 1 ? '' : 's'}.`;
    $('#nw-channel-msg').className = 'msg ok';
  } catch (err) {
    $('#nw-channel-msg').textContent = err.message;
    $('#nw-channel-msg').className = 'msg err';
  }
});

$('#nf-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#nf-msg');
  msg.textContent = 'Reading it…';
  msg.className = 'msg';
  try {
    const r = await api('POST', '/api/admin/news/feeds', { url: $('#nf-url').value.trim(), name: $('#nf-name').value.trim(), keywords: $('#nf-words').value });
    renderNews(r);
    msg.textContent = r.result.ok ? `Added: ${r.result.entries} entries in it, ${r.result.matched} about releases (its first read: kept, not posted).` : `Added, but it couldn't be read: ${r.result.error}`;
    msg.className = `msg ${r.result.ok ? 'ok' : 'err'}`;
    for (const id of ['#nf-url', '#nf-name', '#nf-words']) $(id).value = '';
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  }
});
$('#nf-check').addEventListener('click', async () => {
  const msg = $('#nf-msg');
  msg.textContent = 'Reading every feed that\'s on…';
  msg.className = 'msg';
  const r = await newsCall('POST', '/api/admin/news/feeds/check', {});
  if (!r) { msg.textContent = ''; return; }
  const bad = r.results.filter((x) => !x.ok);
  const added = r.results.reduce((n, x) => n + (x.added || 0), 0);
  msg.textContent = `Read ${r.results.length - bad.length} of ${r.results.length}: ${added} new.${bad.length ? ` Not read: ${bad.map((x) => x.name).join(', ')}.` : ''}`;
  msg.className = `msg ${bad.length ? 'err' : 'ok'}`;
});

// --- Stores and flows -------------------------------------------------------------------
loaders.retailers = async () => {
  retailerList = (await api('GET', '/api/admin/retailers')).retailers;
  const body = $('#retailers');
  body.textContent = '';
  for (const r of retailerList) {
    const toggle = (key) => {
      // (A store that refuses every server — BIG W — is never checked by it: its switch shows off, and stays so.)
      if (key === 'serverChecks' && r.monitor && r.monitor.server === 'never') {
        return h('input', { type: 'checkbox', checked: false, disabled: true, 'aria-label': `${r.name} ${key}`, title: `${r.name} refuses every server: its pages are only read from members' browsers` });
      }
      const box = h('input', { type: 'checkbox', checked: r[key], 'aria-label': `${r.name} ${key}` });
      box.addEventListener('change', async () => {
        try {
          await api('PUT', `/api/admin/retailers/${r.id}`, { [key]: box.checked });
          toast('Saved', `${r.name}: ${key} ${box.checked ? 'on' : 'off'}`, 'success');
        } catch (e) { toast("Couldn't save", e.message, 'warn'); box.checked = !box.checked; }
      });
      return box;
    };
    body.append(h('tr', {},
      h('td', {}, h('b', {}, r.name), h('div', { class: 'muted small' }, r.hosts.join(', ')), r.flowNote ? h('div', { class: 'muted small' }, r.flowNote) : null),
      h('td', {}, h('span', { class: `pill flow-${r.flowStatus}` }, r.flowStatus)),
      h('td', {}, toggle('enabled')),
      h('td', {}, toggle('serverChecks')),
      h('td', {}, toggle('browserChecks')),
      h('td', {}, h('button', { class: 'btn small', type: 'button', onclick: () => { const pre = $('#flow-json'); pre.hidden = false; pre.textContent = `${r.name} — server/retailers/${r.id.replace(/^demo-/, '')}.js\n\n${JSON.stringify(r.flow, null, 2)}`; pre.scrollIntoView({ block: 'nearest' }); } }, 'View flow'))));
  }
};

// --- Setup check ----------------------------------------------------------------------
loaders.integrations = async () => {
  const i = await api('GET', '/api/admin/integrations');
  const box = $('#integrations');
  box.textContent = '';
  const row = (ok, label, detail) => h('li', {}, h('span', { class: ok ? 'ok-mark' : 'no-mark' }, ok ? '✓' : '✕'), h('div', {}, h('b', {}, label), detail ? h('div', { class: 'muted small' }, detail) : null));
  box.append(h('h3', {}, 'Server'), h('ul', { class: 'checks' },
    row(/^https:/.test(i.baseUrl), 'Public address (BASE_URL)', `${i.baseUrl}${/^https:/.test(i.baseUrl) ? '' : ' — use your https:// address in production (Discord buttons and secure cookies need it)'}`),
    row(true, 'Membership price shown', `${i.price}${i.trialDays ? ` · ${i.trialDays}-day free trial` : ' · no free trial'}`),
    row(true, 'Restock monitor', `Server checks every ${i.monitor.intervalSeconds}s per page, ${i.monitor.hostGapSeconds}s between requests to one store · members' browsers every ${i.monitor.browserIntervalSeconds}s · User-Agent "${i.monitor.userAgent}"`),
    row(i.email.configured, 'Email (optional)', i.email.configured ? 'Password resets and email alerts can be sent' : 'RESEND_API_KEY / EMAIL_FROM not set — resets go by Discord DM, or use "Reset link" under Members'),
    i.demoStoreUrl ? row(true, 'Dummy store mode', i.demoStoreUrl) : null));
  box.append(h('h3', {}, 'Whop'), h('ul', { class: 'checks' },
    row(i.whop.apiKey, 'API key (WHOP_API_KEY)', i.whop.apiKey ? 'Set' : 'Needed to create checkout links, check memberships and link ones bought on Whop'),
    row(!!i.whop.planId, 'Plan (WHOP_PLAN_ID)', i.whop.planId || 'The plan_… of your A$19.99/month pricing option'),
    row(!!i.whop.productId, 'Product (WHOP_PRODUCT_ID, optional)', i.whop.productId || 'Set it to accept every plan of your product (e.g. monthly and yearly)'),
    row(i.whop.webhookSecret, 'Webhook secret (WHOP_WEBHOOK_SECRET)', `Webhook URL to add in Whop: ${i.whop.webhookUrl}`),
    row(!!i.whop.lastWebhookAt, 'Last webhook received', i.whop.lastWebhookAt ? `${when(i.whop.lastWebhookAt)} (${i.whop.lastWebhookType})` : 'None yet — send a test event from Whop\'s dashboard'),
    i.whop.checkoutUrl ? row(true, 'Fallback checkout link (WHOP_CHECKOUT_URL)', i.whop.checkoutUrl) : null));
  const d = i.discord;
  box.append(h('h3', {}, 'Discord'), h('ul', { class: 'checks' },
    row(d.oauth, 'Connect Discord (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET)', `OAuth2 redirect to add in the Developer Portal: ${d.redirectUri}`),
    row(d.bot, 'Bot (DISCORD_BOT_TOKEN / DISCORD_GUILD_ID)', d.guildId ? `Server ${d.guildId}` : 'Not set'),
    row(!!d.memberRoleId, 'Member role (DISCORD_MEMBER_ROLE_ID)', d.memberRoleId ? `${d.memberRoleId}${d.kickOnExpire ? ' · members are removed from the server when their membership ends' : ' · the role is removed when a membership ends'}` : 'Not set'),
    row(!!d.restockChannelId, 'Restock channel (DISCORD_RESTOCK_CHANNEL_ID)', d.restockChannelId ? `${d.restockChannelId}${d.restockRoleId ? ` · pings role ${d.restockRoleId}` : ''}` : 'Not set'),
    row(d.commands, 'Slash commands (DISCORD_PUBLIC_KEY)', `Interactions endpoint URL: ${d.interactionsUrl} — then press "Register slash commands" below`),
    row(!!d.inviteUrl, 'Invite link (DISCORD_INVITE_URL, optional)', d.inviteUrl || 'Shown to members on their Discord tab')));
  renderExtension(await api('GET', '/api/admin/extension'));
};

// --- Browser extension: Chrome Web Store link, package, who's on which copy ---------------
const SOURCE = { store: 'Chrome Web Store (updates itself)', download: 'downloaded copy', unknown: 'older copy' };
function renderExtension(x) {
  const list = $('#x-info');
  list.textContent = '';
  const row = (ok, label, detail) => h('li', {}, h('span', { class: ok ? 'ok-mark' : 'no-mark' }, ok ? '✓' : '✕'), h('div', {}, h('b', {}, label), detail ? h('div', { class: 'muted small' }, detail) : null));
  list.append(
    row(true, `Current version: ${x.version}`, 'Bump "version" in extension/manifest.json with each change to the extension.'),
    row(!!x.storeUrl, 'Chrome Web Store listing', x.storeUrl ? h('a', { href: x.storeUrl, target: '_blank', rel: 'noopener', class: 'wrap-anywhere' }, x.storeUrl) : 'Not published yet: members download the extension from their dashboard and replace it by hand to update.'),
    row(!!x.storeUrl, 'Automatic updates', x.storeUrl ? x.autoPublish : 'Start with the Chrome Web Store listing.'),
    row(true, "Members' browsers (last 30 days)", x.browsers.length ? x.browsers.map((b) => `${b.count} × v${b.version}, ${SOURCE[b.source] || b.source}`).join(' · ') : 'None connected yet'));
  $('#x-store').value = x.storeUrl || '';
}
$('#x-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    renderExtension(await api('PUT', '/api/admin/extension', { storeUrl: $('#x-store').value }));
    $('#x-msg').textContent = $('#x-store').value ? 'Saved. Members are asked to move to the Chrome Web Store copy.' : 'Removed.';
    $('#x-msg').className = 'msg ok';
  } catch (err) {
    $('#x-msg').textContent = err.message;
    $('#x-msg').className = 'msg err';
  }
});

$('#d-check').addEventListener('click', async () => {
  $('#d-msg').textContent = 'Checking…';
  const r = await post('/api/admin/integrations/discord-check', {});
  $('#d-msg').textContent = '';
  const list = $('#d-checks');
  list.textContent = '';
  for (const c of (r && r.checks) || []) list.append(h('li', {}, h('span', { class: c.ok ? 'ok-mark' : 'no-mark' }, c.ok ? '✓' : '✕'), h('div', {}, h('b', {}, c.label), c.detail ? h('div', { class: 'muted small' }, c.detail) : null)));
});
$('#d-post').addEventListener('click', async () => {
  const r = await post('/api/admin/integrations/discord-post', {});
  if (r) { $('#d-msg').textContent = 'Posted — check the channel.'; $('#d-msg').className = 'msg ok'; }
});
$('#d-commands').addEventListener('click', async () => {
  const r = await post('/api/admin/integrations/discord-commands', {});
  if (r) { $('#d-msg').textContent = `Registered ${r.commands.join(', ')}. Type / in your server to see them.`; $('#d-msg').className = 'msg ok'; }
});

// --- Whop memberships ---------------------------------------------------------------------
loaders.whop = async () => {
  const { memberships } = await api('GET', `/api/admin/whop/memberships${$('#w-unlinked').checked ? '?unlinked=1' : ''}`);
  const body = $('#memberships');
  body.textContent = '';
  if (!memberships.length) body.append(h('tr', {}, h('td', { colspan: '5', class: 'empty' }, 'No memberships yet. They appear here as Whop sends webhooks.')));
  for (const m of memberships) {
    body.append(h('tr', {},
      h('td', {}, h('code', {}, m.id)),
      h('td', {}, m.status, m.cancel_at_period_end ? h('div', { class: 'muted small' }, 'cancels at period end') : null),
      h('td', {}, m.whop_username || '—', m.email ? h('div', { class: 'muted small' }, m.email) : null),
      h('td', {}, date(m.renewal_period_end)),
      h('td', {}, m.username ? h('b', {}, m.username) : h('span', { class: 'warn-text' }, 'not linked'))));
  }
};
$('#w-unlinked').addEventListener('change', () => loaders.whop());

// --- Audit log --------------------------------------------------------------------------------
loaders.audit = async () => {
  const { entries } = await api('GET', '/api/admin/audit');
  const list = $('#audit');
  list.textContent = '';
  if (!entries.length) list.append(h('li', { class: 'empty' }, 'No admin changes yet.'));
  for (const a of entries) list.append(h('li', {}, h('time', {}, when(a.created_at)), h('span', {}, `${a.actor || 'system'} — ${a.action}: ${a.detail}`)));
};

showTab();
