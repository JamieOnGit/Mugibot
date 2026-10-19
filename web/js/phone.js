// "📱 Finish on this phone" (server/aco.js toPhone()): a checkout waiting at a store's checkpoint on
// the member's computer, taken over by their phone. The link (from Discord's ⚡ Buy reply or their DM)
// is signed, so this phone needn't be signed in. Opening it only shows what pressing does; pressing
// stops the computer's checkout and opens the store here, with the product, to pass the check and pay.
import { $, api, setMsg } from './common.js';

const id = (location.pathname.match(/^\/phone\/([\w-]+)/) || [])[1] || '';
const t = new URLSearchParams(location.search).get('t') || '';

async function load() {
  let info;
  try {
    info = await api('GET', `/api/phone/${encodeURIComponent(id)}?t=${encodeURIComponent(t)}`);
  } catch (e) {
    $('#p-meta').textContent = e.message;
    return;
  }
  $('#p-title').textContent = `📱 ${info.name}`;
  $('#p-meta').textContent = `${info.storeName} · your computer: ${info.statusText}`;
  if (!info.can) {
    setMsg($('#p-msg'), info.note);
    return;
  }
  $('#p-what').hidden = false;
  $('#p-what').textContent = info.stop
    ? `Pressing it stops your computer's checkout${info.checkpoint ? ` at ${info.storeName}'s checkpoint` : ''} and opens ${info.storeName} here with it, for you to pass the check and pay on this phone.`
    : `Your computer's checkout is over (${info.statusText.toLowerCase()}): this opens ${info.storeName} here with it.`;
  $('#p-go').textContent = info.stop ? '📱 Stop my computer and buy it here' : `📱 Open ${info.storeName} here`;
  $('#p-row').hidden = false;
}

$('#p-go').addEventListener('click', async () => {
  $('#p-go').disabled = true;
  try {
    const out = await api('POST', `/api/phone/${encodeURIComponent(id)}`, { t });
    setMsg($('#p-msg'), out.stopped ? 'Your computer stopped — opening the store…' : 'Opening the store…', true);
    location.assign(out.url);
  } catch (e) {
    setMsg($('#p-msg'), e.message);
    $('#p-go').disabled = false;
  }
});

load();
