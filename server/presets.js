// The starter watchlist each new account gets its own copy of (Kmart's
// Pokémon 30th Celebration range). Everyone can edit, reorder or delete
// theirs without affecting anyone else.

export const STARTER_ITEMS = [
  { sku: '43818648', name: 'Day UPC', price: 360, url: 'https://www.kmart.com.au/product/pokemon-tcg%3A-30th-celebration-ultra-premium-collection-day-43818648/' },
  { sku: '43834044', name: 'Night UPC', price: 360, url: 'https://www.kmart.com.au/product/pokemon-tcg%3A-30th-celebration-ultra-premium-collection-night-43834044/' },
  { sku: '43818556', name: 'Knock Out Collection', price: 20, url: 'https://www.kmart.com.au/product/pokemon-trading-card-game%3A-30th-celebration-knock-out-collection-43818556/' },
  { sku: '43818563', name: 'Poster Collection', price: 30, url: 'https://www.kmart.com.au/product/pokemon-trading-card-game%3A-30th-celebration-poster-collection-43818563/' },
  { sku: '43818549', name: 'Pokémon ex Box', price: 45, url: 'https://www.kmart.com.au/product/pokemon-trading-card-game%3A-30th-celebration-pokemon-ex-box-assorted-43818549/' },
  { sku: '43818594', name: 'Binder Collection', price: 65, url: 'https://www.kmart.com.au/product/pokemon-tcg%3A-30th-celebration-binder-collection-43818594/' },
  { sku: '43818587', name: 'Elite Trainer Box', price: 100, url: 'https://www.kmart.com.au/product/pokemon-tcg%3A-30th-celebration-elite-trainer-box-43818587/' },
];

// Dummy products in the test store (npm run mockstore), one shop per retailer
// flow. They never touch a real store. `status` is where each one starts.
export const DUMMY_PRODUCTS = {
  kmart: [
    { sku: '43818648', name: 'Pokémon TCG: 30th Celebration Ultra-Premium Collection (Day)', price: 360, status: 'out_of_stock' },
    { sku: '43818587', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 100, status: 'in_stock' },
    { sku: '43818556', name: 'Pokémon TCG: 30th Celebration Knock Out Collection', price: 20, status: 'in_stock' },
  ],
  bigw: [
    { sku: '6012345', name: 'Pokémon TCG: 30th Celebration Ultra-Premium Collection', price: 359, status: 'out_of_stock' },
    { sku: '6012346', name: 'Pokémon TCG: Scarlet & Violet Booster Bundle', price: 45, status: 'in_stock' },
  ],
  ebgames: [
    { sku: '312345', name: 'One Piece Card Game OP-18 Booster Box (24 Packs)', price: 159, status: 'out_of_stock' },
    { sku: '312346', name: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: 99.95, status: 'in_stock' },
  ],
  jbhifi: [
    { sku: 'pokemon-tcg-30th-celebration-upc', name: 'Pokémon TCG 30th Celebration Ultra-Premium Collection', price: 359, status: 'out_of_stock' },
    { sku: 'pokemon-tcg-30th-celebration-etb', name: 'Pokémon TCG 30th Celebration Elite Trainer Box', price: 99, status: 'in_stock' },
  ],
  trainertown: [
    { sku: 'pokemon-tcg-ascended-heroes-elite-trainer-box', name: 'Pokémon - TCG - Ascended Heroes Elite Trainer Box', price: 129.95, status: 'in_stock' },
    { sku: 'one-piece-tcg-op-14-booster-box', name: 'One Piece - TCG - OP-14 Booster Box', price: 189.95, status: 'out_of_stock' },
  ],
};

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** A dummy product's page, in the shape of that retailer's real product links. */
export function dummyProductPath(store, p) {
  switch (store) {
    case 'kmart': return `/kmart/product/${slugify(p.name)}-${p.sku}/`;
    case 'bigw': return `/bigw/product/${slugify(p.name)}/p/${p.sku}`;
    case 'ebgames': return `/ebgames/product/toys-and-collectibles/${p.sku}-${slugify(p.name)}`;
    case 'jbhifi': return `/jbhifi/products/${p.sku}`;
    case 'trainertown': return `/trainertown/products/${p.sku}`;
    default: return null;
  }
}
