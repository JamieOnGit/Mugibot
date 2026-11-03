// Click & Collect when a checkout won't deliver the order (extension/fill.js, Mugibot 2.2 — EB Games' pre-orders and
// some products are Click & Collect only). Home delivery first, always; then, only once the checkout says it can't
// deliver this order — in EB Games' words ("Unfortunately the items below are not in stock for delivery. Please choose
// Click & Collect to proceed.") or anyone's — Click & Collect: your postcode typed into "Collect from", the first
// suburb it suggests, and of the stores it lists, one that has it, the nearest (its km). In Chromium, with flows.js and
// fill.js as the extension loads them (no extension needed), on pages written here and on the dummy EB Games checkout.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startMockStore } from '../devtools/mockstore.js';
import { serialize } from '../server/retailers/index.js';
import ebgames from '../server/retailers/ebgames.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const SCRIPTS = ['flows.js', 'fill.js'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n;\n');
const EB_FLOW = JSON.stringify(serialize(ebgames.flow.checkout));
let browser;
let store;

before(async () => {
  browser = await chromium.launch({ headless: true, args: ['--no-proxy-server'] });
  store = await startMockStore();
});
after(async () => {
  await browser.close();
  await store.close();
});

/** A page with this body, and flows.js and fill.js in it. */
async function pageWith(body) {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body><header>Store · <a href="#">Click &amp; Collect only available at selected stores</a></header><main>${body}</main><footer>Delivery not available to PO Boxes. Express delivery isn't available everywhere.</footer></body></html>`);
  await page.addScriptTag({ content: SCRIPTS });
  return page;
}
const choice = `<div class="toggle"><button type="button" aria-pressed="false">Click &amp; Collect</button><button type="button" aria-pressed="true">Home Delivery</button></div>`;
const said = async (body) => {
  const page = await pageWith(body);
  try { return await page.evaluate((f) => MGBFill.noHomeWords(MGBFlows.revive(JSON.parse(f))), EB_FLOW); } finally { await page.close(); }
};

test("🏬 EB Games' words, and the same said other ways, all read as \"home delivery isn't possible for this order\"", async () => {
  const ways = [
    'Unfortunately the items below are not in stock for delivery. Please choose Click & Collect to proceed.',
    'Unfortunately the items below are not in stock for delivery.',
    'Please choose Click & Collect to proceed.',
    'These items are unavailable for delivery.',
    'Home delivery is unavailable for the items below.',
    'Sorry, delivery isn’t available for some items in your order. Select Click & Collect to continue.',
    'The following products can only be collected in store.',
    'Item(s) not available for home delivery',
    'This pre-order is Click & Collect only',
    'Out of stock for delivery',
    'Unfortunately we\'re unable to deliver the items below.',
    'Please switch to Click and Collect',
    'To proceed, please select Click & Collect.',
    'Available for Click & Collect only',
    'No delivery stock for this item',
    'Only available for in-store pickup',
    'Items marked below aren\'t currently stocked for delivery',
  ];
  for (const w of ways) assert.ok(await said(`${choice}<p>${w}</p>`), `read: "${w}"`);
  // Said in a warning, in words none of those cover: read from the warning itself (red words, or an alert box).
  assert.ok(await said(`${choice}<div style="color:#c0392b">Sorry, the items below are currently unavailable to be delivered.</div>`), 'a red warning');
  assert.ok(await said(`${choice}<div role="alert">Sorry, the items below are currently unavailable to be delivered.</div>`), 'an alert box');
  assert.equal(await said(`${choice}<p>Sorry, the items below are currently unavailable to be delivered.</p>`), '', 'the same words as plain text: not enough on their own');
});

test("🏬 never read as \"can't deliver this order\": one kind of delivery, somewhere it won't go, a cost, a time, the address, or a store still to choose — nor the page's header and footer", async () => {
  const not = [
    'Express delivery isn\'t available for this postcode.',
    'Same day delivery not available',
    'We can\'t deliver to PO Boxes or parcel lockers.',
    'Free delivery isn\'t available on orders under $50.',
    'Orders placed after 2pm cannot be shipped until the next business day.',
    'Delivery not available on public holidays.',
    'Please select a store to check for availability.',
    'Please enter a valid delivery address.',
    'Delivery not available on Sundays.',
    'Gift wrapping not available for delivery orders.',
    'Click & Collect is free. Home Delivery from $9.95.',
    'Your order will be delivered in 3–5 business days.',
  ];
  for (const w of not) assert.equal(await said(`${choice}<div role="alert" style="color:#c0392b">${w}</div>`), '', `not read: "${w}"`);
  assert.equal(await said(choice), '', 'the header ("Click & Collect only available at selected stores") and footer ("Delivery not available to PO Boxes") are never read');
});

/** The stores a page lists, as fill.js reads them, and the one it would choose. */
async function stores(body) {
  const page = await pageWith(body);
  try { return await page.evaluate(() => ({ list: MGBFill.storeChoices(), best: MGBFill.bestStore() })); } finally { await page.close(); }
}
const ebRow = (brand, name, avail, km) => `<li class="store-row"><div><div>${brand}</div><div>${name}</div><div>Tue: 10:00am - 5:00pm</div></div><div>${avail}<div>📍 ${km}km away</div></div></li>`;
const n = (got, of) => `<span>${got} of ${of} items</span><br><span>available</span>`;

test('🏬 the store: one that has it first, then the nearest (its km) — never one that has none, whatever order the page lists them in', async () => {
  // EB Games' list, as the real one shows it: the nearest stores have none of it.
  const eb = await stores(`<h3>Stores near Cheltenham, VIC 3192</h3><ul>${[
    ebRow('EB Games', 'Keysborough', n(1, 1), '11.32'), ebRow('EB Games / ZiNG', 'Chadstone', n(0, 1), '0.86'),
    ebRow('EB Games', 'Moorabbin', '<span>Unavailable</span>', '1.02'), ebRow('EB Games', 'Southlands', n(1, 1), '1.34'), ebRow('EB Games / ZiNG', 'The Glen', n(1, 1), '14.60'),
  ].join('')}</ul>`);
  assert.deepEqual(eb.list.map((s) => [s.name, s.km, s.stock, s.target]), [
    ['EB Games Keysborough', 11.32, 0, 'li'], ['EB Games / ZiNG Chadstone', 0.86, 3, 'li'], ['EB Games Moorabbin', 1.02, 3, 'li'],
    ['EB Games Southlands', 1.34, 0, 'li'], ['EB Games / ZiNG The Glen', 14.6, 0, 'li'],
  ]);
  assert.deepEqual(eb.best, { name: 'EB Games Southlands', km: 1.34, stock: 0 });
  // All of the order before some of it, even further away ("1 of 2 items available" at 0.5 km, "2 of 2" at 3.1 km).
  const some = await stores(`<ul>${ebRow('EB Games', 'Southland', n(1, 2), '0.50')}${ebRow('EB Games', 'Highpoint', n(2, 2), '3.10')}</ul>`);
  assert.equal(some.best.name, 'EB Games Highpoint');
  // Only some of it anywhere: the nearest of those.
  const part = await stores(`<ul>${ebRow('EB Games', 'Far', n(1, 2), '9.00')}${ebRow('EB Games', 'Near', n(1, 2), '2.00')}${ebRow('EB Games', 'None', n(0, 2), '0.20')}</ul>`);
  assert.equal(part.best.name, 'EB Games Near');
  // None of them has it: none chosen.
  const none = await stores(`<ul>${ebRow('EB Games', 'A', n(0, 1), '1.00')}${ebRow('EB Games', 'B', '<span>Out of stock</span>', '2.00')}</ul>`);
  assert.equal(none.best, null);
  // One store listed: still its own line, not the whole list — nor the box around it with the order's prices in it.
  const one = await stores(`<div><input aria-label="Collect from"></div><section><div><p>Subtotal <span>$46.00</span></p><p>Tue 4 Nov</p></div><ul>${ebRow('EB Games', 'Southlands', n(1, 1), '1.34')}</ul></section>`);
  assert.deepEqual(one.list.map((s) => [s.name, s.target]), [['EB Games Southlands', 'li']]);
  // The number and its "km away" apart (<span>1.34</span>km away): read together.
  const split = await stores('<ul><li class="r"><b>EB Games Northland</b> <i>available</i> <span>3.20</span>km away</li><li class="r"><b>EB Games Preston</b> <i>available</i> <span>1.10</span> km away</li></ul>');
  assert.deepEqual(split.best, { name: 'EB Games Preston', km: 1.1, stock: 0 });
  // A store finder's list (Kmart's: no stock said, a "Select" each): the nearest, by its km — and its own button.
  const kmart = await stores('<ul><li class="store-result"><b>Kmart Southland</b> · 5.1 km · Open until 9pm <button type="button">Select</button></li><li class="store-result"><b>Kmart Cheltenham</b> · 2.1 km · Open until 9pm <button type="button">Select</button></li></ul>');
  assert.deepEqual(kmart.best, { name: 'Kmart Cheltenham', km: 2.1, stock: 2 });
  assert.deepEqual(kmart.list.map((s) => s.target), ['button', 'button']);
  // Lines as boxes that show a hand (no list): the box, by its distance; "850 m away" is 0.85 km.
  const divs = await stores('<div><div class="s" style="cursor:pointer"><p>EB Games Northland</p><p>In stock</p><p>850 m away</p></div><div class="s" style="cursor:pointer"><p>EB Games Preston</p><p>In stock</p><p>2.4 km away</p></div></div>');
  assert.deepEqual(divs.best, { name: 'EB Games Northland', km: 0.85, stock: 0 });
});

test('🏬 your postcode for "Collect from": your details\' own, else the one in your address however it was saved', async () => {
  const page = await pageWith('');
  try {
    const near = (p) => page.evaluate((x) => MGBFill.fieldValues(x, null).collectNear, p);
    assert.equal(await near({ address1: '11 Monterey Dr', suburb: 'Cheltenham', state: 'VIC', postcode: '3192' }), '3192');
    assert.equal(await near({ address1: '11 Monterey Dr, Cheltenham VIC 3192' }), '3192');
    assert.equal(await near({ address1: '1341 Dandenong Rd', suburb: 'Chadstone 3148' }), '3148');
    assert.equal(await near({ address1: '1341 Dandenong Rd', suburb: 'Chadstone' }), '', 'a street number is never taken for a postcode');
    // (Only ever a postcode — the owner's rule, Nov 2026: a postcode your details give for collecting, else your own.)
    assert.equal(await near({ postcode: '3192', collectNear: '3150' }), '3150', 'the postcode your details say to collect near');
    assert.equal(await near({ postcode: '3192', collectNear: 'Southland' }), '3192', 'a suburb there: your postcode instead');
    assert.equal(await near({ address1: '11 MONTEREY DRIVE', postcode: '3192', collectNear: '11 MONTEREY DRIVE' }), '3192', 'never your street');
    assert.equal(await near({ address1: '11 Monterey Dr', suburb: 'Cheltenham', state: 'VIC', postcode: 'VIC 3192' }), '3192');
  } finally { await page.close(); }
});

test('🏬 "Collect from" is known for what it is however it\'s drawn — EB Games\' real one has "address" in its own name and id — and an address box is never taken for it', async () => {
  const kinds = async (body) => {
    const page = await pageWith(body);
    try {
      return await page.evaluate((f) => {
        const C = MGBFlows.revive(JSON.parse(f));
        return Array.from(document.querySelectorAll('input')).map((el) => [el.id, MGBFill.isCollectBox(el), MGBFill.isStoreBox(el), (MGBFill.lookupBox(C) || {}).id || '']);
      }, EB_FLOW);
    } finally { await page.close(); }
  };
  // EB Games' (Nov 2026): a Material field — its label not tied to the box, its hint under it, "address" in its name and id.
  const eb = '<div class="mat-form-field"><div class="mat-form-field-flex"><div class="mat-form-field-infix"><input id="addressSearch" name="address" formcontrolname="address" type="text" autocomplete="off" role="combobox" aria-autocomplete="list" aria-describedby="h1"><span><label><mat-label>Collect from</mat-label></label></span></div></div><div><mat-hint id="h1">Please enter suburb or postcode</mat-hint></div></div>';
  assert.deepEqual(await kinds(eb), [['addressSearch', true, true, '']], 'a collect box, never the address lookup');
  // Its label tied to it; only its aria-label; only its hint, in a Click & Collect part of the page.
  assert.deepEqual(await kinds('<label for="a1">Collect from</label><input id="a1" name="deliveryAddress" role="combobox">'), [['a1', true, true, '']]);
  assert.deepEqual(await kinds('<input id="a2" aria-label="Pick up from" name="address">'), [['a2', true, true, '']]);
  assert.deepEqual(await kinds('<div class="click-collect"><div><input id="a3" name="addressQuery" aria-describedby="h3"></div><small id="h3">Please enter suburb or postcode</small></div>'), [['a3', true, true, '']]);
  // Delivery's own address boxes: never a collect box — the address lookup is the address lookup.
  assert.deepEqual(await kinds('<label for="d1">Delivery address</label><input id="d1" name="address" placeholder="Start typing your address" role="combobox">'), [['d1', false, false, 'd1']]);
  // (A "Suburb or postcode" box outside Click & Collect: never a collect box — a store finder's only while collecting.)
  assert.deepEqual(await kinds('<div class="delivery"><label for="d2">Suburb or postcode</label><input id="d2" name="suburb"></div>'), [['d2', false, true, '']]);
  // Both on one page (Home Delivery's lookup, and Click & Collect's box): the lookup is the delivery one.
  assert.deepEqual((await kinds(`<div><label for="d3">Address</label><input id="d3" name="address" placeholder="Start typing your address" role="combobox"></div>${eb}`)).map((x) => x.slice(0, 3).concat(x[3])), [['d3', false, false, 'd3'], ['addressSearch', true, true, 'd3']]);
  // A card box is never one, whatever's around it.
  assert.deepEqual(await kinds('<div class="collect"><label for="c1">Card number</label><input id="c1" name="cardnumber"></div>'), [['c1', false, false, '']]);
});

/** The dummy EB Games checkout (signed in: your address and saved card) for a Click & Collect-only order, in a tab. */
async function ebCheckout(setup = () => {}) {
  store.reset();
  store.state.signedIn.ebgames = true;
  const S = store.shop('ebgames');
  S.stockless = true;
  S.cart = [{ sku: '312346', qty: 1, price: 46, name: 'One Piece - TCG - Adventure on Kami\'s Island - Borsalino Foil EB04-058' }];
  setup(S);
  const page = await browser.newPage();
  await page.goto(`${store.url}/ebgames/checkout`);
  await page.addScriptTag({ content: SCRIPTS });
  return { page, S };
}
/** Everything typed into "Collect from" (the dummy store's own record): your postcode, never anything else. */
function assertPostcodeOnly(S, postcode) {
  const typed = S.steps.filter((x) => x.step === 'ccTyped').flatMap((x) => x.data.all);
  assert.ok(typed.length > 0, 'something typed into "Collect from"');
  for (const v of typed) assert.ok(postcode.startsWith(v) || /^[A-Z ]+, [A-Z]{2,3} \d{4}$/.test(v), `only the postcode typed into "Collect from" (and the suburb it suggested, chosen) — it had "${v}": ${JSON.stringify(typed)}`);
  assert.ok(!typed.some((v) => /monterey|pallet|drive|\bdr\b|\brd\b/i.test(v)), `never the street: ${JSON.stringify(typed)}`);
}

/** Mugibot's checkout fill there, as Auto-checkout runs it: where it got to, what it said, and the final button. */
const fillIn = (page, profile) => page.evaluate(async ({ f, profile: p }) => {
  const steps = [];
  let fin = null;
  const result = await MGBFill.assist({
    values: MGBFill.fieldValues(p, null), flow: MGBFlows.revive(JSON.parse(f)), storeName: 'EB Games', auto: true, patientMs: 30000,
    report: (type, message) => steps.push(message), onFinal: (x) => { fin = x; },
  });
  return { result, steps, fin: fin ? { text: fin.text, off: fin.el.disabled } : null };
}, { f: EB_FLOW, profile });
const HOME = { firstName: 'Jamie', lastName: 'Ha', email: 'j@example.com', phone: '0466868619', address1: '11 Monterey Dr', suburb: 'Cheltenham', state: 'VIC', postcode: '3192' };

test("🏬 EB Games, signed in, an order it won't deliver: Click & Collect, 3192 typed into \"Collect from\", CHELTENHAM (the first suburb), EB Games Southlands (the nearest that has it — not Chadstone, nearer but with none), CONFIRM & PAY on", async () => {
  const { page, S } = await ebCheckout();
  try {
    const t0 = Date.now();
    const r = await fillIn(page, HOME);
    assert.equal(r.result, 'final', JSON.stringify(r.steps));
    assert.deepEqual(r.fin, { text: 'CONFIRM & PAY', off: false });
    assert.equal(S.data.ccSearch.typed, '3192', 'the postcode typed');
    assert.equal(S.data.ccSuburb.suburb, 'CHELTENHAM, VIC 3192', 'the first suburb suggested');
    assertPostcodeOnly(S, '3192');
    assert.deepEqual([S.data.store.fulfilment, S.data.store.store, S.data.store.km], ['cnc', 'EB Games Southlands', 1.34]);
    assert.ok(r.steps.some((m) => /^🏬 EB Games doesn't offer home delivery for this order \("unfortunately the items below are not in stock for delivery/.test(m)), r.steps.join('\n'));
    assert.ok(r.steps.includes('🏬 Looking for stores near CHELTENHAM, VIC 3192'), r.steps.join('\n'));
    assert.ok(r.steps.includes('🏬 Click & Collect from EB Games Southlands (has it, 1.34 km away — the nearest of 5 stores that has it)'), r.steps.join('\n'));
    assert.ok(!r.steps.some((m) => /Chose "Home Delivery"/.test(m)), 'Home Delivery already chosen: never chosen again once it said so');
    assert.ok(Date.now() - t0 < 8000, `${Date.now() - t0} ms`);
  } finally { await page.close(); }
});

test('🏬 EB Games saying it in other words (in an alert box), and "Collect from" already showing stores near somewhere else: still Click & Collect, near your postcode', async () => {
  const { page, S } = await ebCheckout((x) => { x.stockless = 'Sorry — the items below are currently unavailable to be delivered.'; x.stocklessAlert = true; x.ccNear = 'BRISBANE CITY, QLD 4000'; });
  try {
    const r = await fillIn(page, { ...HOME, postcode: '2000', suburb: 'Sydney', state: 'NSW' });
    assert.equal(r.result, 'final', JSON.stringify(r.steps));
    assert.equal(S.data.ccSearch.typed, '2000');
    assert.equal(S.data.ccSuburb.suburb, 'SYDNEY, NSW 2000');
    assert.equal(S.data.store.store, 'EB Games Southlands');
    assertPostcodeOnly(S, '2000');
  } finally { await page.close(); }
});

test('🏬 EB Games, its real "Collect from" (\"address\" in its name and id, the label not tied to it): your postcode alone typed — never "11 Monterey Dr" — and the order goes on to CONFIRM & PAY', async () => {
  const { page, S } = await ebCheckout();
  try {
    const r = await fillIn(page, HOME);
    assert.equal(r.result, 'final', JSON.stringify(r.steps));
    assert.deepEqual(r.fin, { text: 'CONFIRM & PAY', off: false });
    assertPostcodeOnly(S, '3192');
    assert.equal(S.data.ccSuburb.suburb, 'CHELTENHAM, VIC 3192');
    assert.equal(S.data.store.store, 'EB Games Southlands');
    assert.ok(!r.steps.some((m) => /Looking up your address|address finder/.test(m)), r.steps.join('\n'));
  } finally { await page.close(); }
});

test('🏬 the plainer "Collect from" (its label tied to it): the same — your postcode alone', async () => {
  const { page, S } = await ebCheckout((x) => { x.ccMarkup = 'plain'; });
  try {
    const r = await fillIn(page, HOME);
    assert.equal(r.result, 'final', JSON.stringify(r.steps));
    assertPostcodeOnly(S, '3192');
    assert.equal(S.data.store.store, 'EB Games Southlands');
  } finally { await page.close(); }
});

test("🏬 an order EB Games delivers: Home Delivery kept — Click & Collect never chosen", async () => {
  const { page, S } = await ebCheckout((x) => { x.stockless = false; });
  try {
    const r = await fillIn(page, HOME);
    assert.equal(r.result, 'final', JSON.stringify(r.steps));
    assert.ok(!r.steps.some((m) => /Click & Collect/.test(m)), r.steps.join('\n'));
    assert.equal((S.data.store || {}).fulfilment, undefined);
  } finally { await page.close(); }
});

test('🏬 no EB Games store near you has it: stopped for you — nothing chosen, and why', async () => {
  const { page, S } = await ebCheckout((x) => { x.ccStores = [{ brand: 'EB Games', name: 'Southlands', km: 1.34, has: false, hours: '' }, { brand: 'EB Games', name: 'Chadstone', km: 0.86, has: 'none', hours: '' }]; });
  try {
    const r = await fillIn(page, HOME);
    assert.equal(r.result, 'needs_you', JSON.stringify(r.steps));
    assert.match(r.steps.at(-1), /none of the 2 stores near CHELTENHAM, VIC 3192 has it for Click & Collect — nothing bought/);
    assert.equal(S.data.store, undefined, 'no store chosen');
  } finally { await page.close(); }
});
