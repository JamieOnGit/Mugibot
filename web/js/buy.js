// The ⚡ Buy page. ⚡ Buy links normally go straight to the store (server/routes/web.js); this page
// is for the ones that can't: an expired or old link, or one from another website. One press and
// you're on your way to checkout — in this browser, or (on a phone, say) in your checkout browser
// on your computer: "Send to my computer" (server/aco.js remote()).
import { $, api, setMsg } from './common.js';

const q = new URLSearchParams(location.search);
const idMatch = location.pathname.match(/^\/buy\/([\w-]+)/);
let item = null;
// No extension in this browser (a phone): sending it to the computer is the way.
if (!document.documentElement.dataset.mugibotExtension) {
  $('#b-remote').classList.add('primary');
  $('#b-go').classList.remove('primary');
}

async function load() {
  if (idMatch) {
    const { items } = await api('GET', '/api/items');
    item = items.find((x) => x.id === idMatch[1]) || null;
  } else {
    item = (await api('GET', `/api/items/lookup?store=${encodeURIComponent(q.get('store') || '')}&sku=${encodeURIComponent(q.get('sku') || '')}`)).item;
  }
  if (item) {
    $('#b-title').textContent = `⚡ ${item.name}`;
    $('#b-meta').textContent = `${item.storeName} · SKU ${item.sku}${item.url ? '' : ' · the product page hasn\'t been found yet'}`;
    $('#b-row').hidden = !item.url;
    $('#b-go').textContent = '⚡ Buy';
    return;
  }
  if (!idMatch && q.get('sku')) {
    $('#b-title').textContent = `⚡ ${q.get('name') || q.get('sku')}`;
    $('#b-meta').textContent = `Not on your watchlist yet — ⚡ Buy adds it (SKU ${q.get('sku')}) and opens it.`;
    $('#b-row').hidden = !q.get('url');
    $('#b-go').textContent = 'Add & ⚡ Buy';
    return;
  }
  $('#b-meta').textContent = 'That SKU isn\'t on your watchlist.';
}

$('#b-go').addEventListener('click', async () => {
  // Open the tab straight away (browsers block pop-ups opened after a delay) — or use this one.
  const btn = $('#b-go');
  btn.disabled = true;
  try {
    if (!item) item = await api('POST', '/api/items', { url: q.get('url'), store: q.get('store'), sku: q.get('sku'), name: q.get('name') || '' });
    const r = await api('POST', `/api/items/${item.id}/go`, {});
    location.href = r.url;
  } catch (e) {
    setMsg($('#b-msg'), e.status === 402 ? `${e.message}.` : e.message);
    btn.disabled = false;
  }
});

$('#b-remote').addEventListener('click', async () => {
  const btn = $('#b-remote');
  btn.disabled = true;
  try {
    if (!item) item = await api('POST', '/api/items', { url: q.get('url'), store: q.get('store'), sku: q.get('sku'), name: q.get('name') || '' });
    const r = await api('POST', `/api/aco/remote/${item.id}`, {});
    const how = r.mode === 'place' ? 'It places the order by itself, within your Auto-checkout limits.' : `It fills checkout in and stops at the final button — ${r.why}.`;
    const asleep = !r.listening ? ` ${r.device.name} isn't open right now${r.fallback ? ', nor is any other browser of yours' : ''} — it starts as soon as ${r.fallback ? 'one is' : 'it is'} (within 2 minutes).`
      : r.standIn ? ` (${r.standIn}, your checkout browser, isn't open — so ${r.device.name} checks out instead.)` : '';
    setMsg($('#b-msg'), `Sent to ${r.device.name}: it's opening the store now. ${how}${asleep} You'll get a DM with how it went.`, true);
  } catch (e) {
    setMsg($('#b-msg'), e.status === 402 ? `${e.message}.` : e.message);
    btn.disabled = false;
  }
});

load().catch((e) => setMsg($('#b-msg'), e.message));
