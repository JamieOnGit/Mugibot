// The words a product page's buy button uses, the same at every store: "Add to cart", "Add to
// basket", "Add to bag", "Add to trolley", "Pre-order", "Buy now", "Buy it now", "Buy"… all mean
// "put it in my bag" (or straight to checkout). Used by every store's flow (server/retailers), by the
// monitor's page reader (a button saying any of them = it can be bought) and by its search-result
// reader — and, as a copy, by the extension (lib/words.js; extension/core.js keeps its own, the same).
//
// In order of preference: a page with "Add to cart" and "Buy now" side by side has "Add to cart"
// pressed, the way a person would.

export const ADD_WORDS = [
  /\badd to (my |your )?(shopping )?(cart|bag|basket|trolley|order)\b/i,
  /\bpre-?\s?order\b/i,
  /\bbuy (it )?now\b/i,
  /^buy$/i,
  /^(order|purchase|get it) now$/i,
  /^add$/i,
];

// Buttons with those words that aren't a buy button: a wish list, a gift card, paying later, a
// wallet's own express button (Shop Pay, PayPal…), click & collect, a stock alert.
export const NOT_ADD = /wish ?list|favou?rite|compare|registry|gift ?card|notify|remind|alert me|pay later|pay in \d|lay-?by|laybuy|afterpay|zip ?pay|\bzip\b|paypal|klarna|humm|latitude|apple ?pay|google ?pay|g ?pay|shop ?pay|with shop\b|in-?store|click (&|and) collect|pick ?up|reserve/i;

// A search result's tile that can be bought (its whole text: a buy button's words in it somewhere).
export const TILE_ADD_RE = /\b(add to (my |your )?(shopping )?(cart|bag|trolley|basket)|buy (it )?now|in stock|pre-?\s?order)\b/i;

/** Is this a product page's buy button? */
export function isAddLabel(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return !!s && s.length <= 80 && !NOT_ADD.test(s) && ADD_WORDS.some((re) => re.test(s));
}
