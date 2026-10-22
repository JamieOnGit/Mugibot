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
  // CrystalCommerce links carry the category; pre-orders sit in a "… Pre-Orders" one.
  thegamescube: [
    { sku: '729233', name: "One Piece Card Game The World's Strongest Warriors Booster Box OP-17", price: 189.95, status: 'in_stock', category: 'one_piece_tcg-one_piece_booster_boxes' },
    { sku: '731930', name: 'Pokemon TCG Mega Evolution Booster Display', price: 249.95, status: 'out_of_stock', category: 'all_other_tcgs-pokemon-pokemon_booster_boxes' },
    { sku: '731931', name: 'Pokemon TCG Phantasmal Flames Elite Trainer Box', price: 89.95, status: 'preorder', category: 'pokemon_pre_orders' },
  ],
  gamerholic: [
    { sku: 'pokemon-tcg-mega-evolution-elite-trainer-box', name: 'Pokemon TCG Mega Evolution Elite Trainer Box', price: 99.95, status: 'in_stock' },
    { sku: 'preorder-one-piece-card-game-op-15-booster-box', name: 'PREORDER One Piece Card Game OP-15 Booster Box', price: 199.95, status: 'out_of_stock' },
  ],
  // Toys"R"Us (Shopify), at toysrus.com.au.
  toysrus: [
    { sku: 'pokemon-tcg-scarlet-violet-151-ultra-premium-collection', name: 'Pokemon TCG Scarlet & Violet 151 Ultra Premium Collection', price: 179.99, status: 'in_stock' },
    { sku: 'pokemon-tcg-mega-evolution-booster-bundle', name: 'Pokemon TCG Mega Evolution Booster Bundle', price: 54.99, status: 'out_of_stock' },
  ],
  pokemoncenter: [
    { sku: '10-10447-108', name: 'Pokémon TCG: 30th Celebration Pokémon Center Elite Trainer Box', price: 129.95, status: 'in_stock' },
    { sku: '10-10450-101', name: 'Pokémon TCG: Mega Evolution Booster Bundle', price: 49.95, status: 'out_of_stock' },
  ],
  // Target: two trading-card products, and the clothes its "Often Bought Together" pop-up offers
  // after Add to basket (Auto-checkout and ⚡ Buy close it, never add them).
  target: [
    { sku: '71234567', name: 'Pokémon TCG: Mega Evolution Elite Trainer Box', price: 79, status: 'out_of_stock' },
    { sku: '71234568', name: 'Pokémon TCG: Prismatic Evolutions Booster Bundle', price: 49, status: 'in_stock' },
    { sku: '70000001', name: 'Australian Cotton Blend Sleeveless Bubble Top', price: 25, status: 'in_stock', upsell: true },
    { sku: '70000002', name: 'Lily Loves European Linen Culotte Pants', price: 50, status: 'in_stock', upsell: true },
    { sku: '70000003', name: 'Lily Loves Australian Cotton Tie Detail T-Shirt', price: 25, status: 'in_stock', upsell: true },
    { sku: '70000004', name: 'Lily Loves European Linen Blend Puff Sleeve Midi Dress', price: 65, status: 'in_stock', upsell: true },
  ],
  // City Beach-style (Salesforce Commerce Cloud): the booster pack from the real store, and a skateboard that drops later.
  citybeach: [
    { sku: '20424049-01', name: 'Pokémon Ninja Spinner Booster Pack Trading Cards', price: 9.99, status: 'in_stock' },
    { sku: '20499999-01', name: 'Pokémon Pikachu Complete Skateboard', price: 129.99, status: 'in_stock', listed: false },
  ],
  // Amazon-style: ASINs, Amazon's search tiles (the live sweeps read those, from an admin's browser).
  amazon: [
    { sku: 'B0MGBTEST1', name: 'Pokémon TCG: Destined Rivals Booster Bundle', price: 59, status: 'in_stock' },
    { sku: 'B0MGBTEST2', name: 'Pokémon TCG: Surging Sparks Elite Trainer Box', price: 89, status: 'out_of_stock' },
  ],
  pbandai: [
    { sku: 'N2903432001', name: 'ONE PIECE CARD GAME Premium Card Collection -29th Anniversary Edition-', price: 25, status: 'in_stock' },
    { sku: 'N2863373001', name: 'ONE PIECE CARD GAME Official Playmat Limited Edition vol.6', price: 51, status: 'out_of_stock' },
  ],
  // Pokébox, Good Games, Collectible Madness, Cherry Collectables (Shopify card shops) — named the way each names its products.
  pokebox: [
    { sku: 'pokemon-tcg-30th-celebration-elite-trainer-box-etb', name: 'Pokemon TCG: 30th Celebration Elite Trainer Box (ETB)', price: 289.99, status: 'in_stock' },
    { sku: 'one-piece-card-game-op-15-booster-box-japanese', name: 'One Piece Card Game - OP-15: Adventure on KAMI’s Island Booster Box [Japanese]', price: 134.99, status: 'out_of_stock' },
  ],
  goodgames: [
    { sku: 'pokemon-tcg-mega-lucario-ex-league-battle-deck', name: 'Pokemon TCG - Mega Lucario ex League Battle Deck', price: 60, status: 'in_stock' },
    { sku: 'one-piece-card-game-op-14-booster-box', name: 'One Piece Card Game - OP-14 Booster Box', price: 189.95, status: 'out_of_stock' },
  ],
  collectiblemadness: [
    { sku: 'pokemon-tcg-mega-zygarde-ex-premium-collection', name: 'Pokemon - TCG - Mega Zygarde ex Premium Collection', price: 95, status: 'in_stock' },
    { sku: 'pokemon-tcg-delta-reign-booster-box', name: 'Pokemon - TCG - Delta Reign Booster Box', price: 339, status: 'out_of_stock' },
  ],
  cherrycollectables: [
    { sku: 'pokemon-tcg-mega-evolution-phantasmal-flames-booster-pack', name: 'Pokemon TCG ME02 Mega Evolution - Phantasmal Flames Booster Pack', price: 17.99, status: 'in_stock' },
    { sku: 'pokemon-tcg-30th-celebration-elite-trainer-box', name: 'Pokemon TCG 30th Celebration Elite Trainer Box', price: 299.99, status: 'out_of_stock' },
  ],
  // Gameology (Shopify, FoxTheme's "Hyper"): named as its real products are; its links name a collection on the way.
  gameology: [
    { sku: 'one-piece-card-game-op-15-booster-box', name: "One Piece Card Game OP-15 Adventure on Kami's Island Booster Box", price: 519.95, status: 'in_stock' },
    { sku: 'pokemon-tcg-mega-evolution-perfect-order-booster-box', name: 'Pokemon TCG Mega Evolution Perfect Order Booster Box', price: 289.95, status: 'out_of_stock' },
    { sku: 'one-piece-card-game-op-15-single-booster-pack', name: "One Piece Card Game OP-15 Adventure on Kami's Island Single Booster Pack", price: 22.95, status: 'in_stock' },
  ],
  // The Gamesmen (Magento): its links are the product's name; its item codes are numbers.
  gamesmen: [
    { sku: 'pokemon-tcg-mega-evolution-perfect-order-elite-trainer-box', code: '258811', name: 'Pokemon TCG: Mega Evolution Perfect Order Elite Trainer Box', price: 119.95, status: 'in_stock' },
    { sku: 'pokemon-tcg-mega-evolution-pitch-black-elite-trainer-box', code: '249543', name: 'Pokemon TCG: Mega Evolution: Pitch Black Elite Trainer Box', price: 139.95, status: 'out_of_stock' },
    { sku: 'one-piece-card-game-op-16-the-time-of-battle-booster-box', code: '261002', name: 'One Piece Card Game: OP-16 The Time of Battle Booster Box', price: 199.95, status: 'preorder' },
  ],
  // Games World (WooCommerce): its links are /product/<name>/; the add-to-cart link takes the product's id.
  gamesworld: [
    { sku: 'one-piece-carrying-on-his-will-op-13-sealed-booster-box-24', name: 'ONE PIECE CARRYING ON HIS WILL [OP-13] SEALED BOOSTER BOX (24)', price: 240, status: 'in_stock' },
    { sku: 'pokemon-tcg-mega-evolution-elite-trainer-box', name: 'POKEMON TCG MEGA EVOLUTION ELITE TRAINER BOX', price: 89.99, status: 'out_of_stock' },
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
    case 'thegamescube': return `/thegamescube/catalog/${p.category || 'all_other_tcgs'}/${slugify(p.name).replace(/-/g, '_')}/${p.sku}`;
    case 'gamerholic': return `/gamerholic/products/${p.sku}`;
    case 'toysrus': return `/toysrus/products/${p.sku}`;
    case 'pokemoncenter': return `/pokemoncenter/product/${p.sku}/${slugify(p.name)}`;
    case 'pbandai': return `/pbandai/item/${p.sku}`;
    case 'target': return `/target/p/${slugify(p.name)}/${p.sku}`;
    case 'amazon': return `/amazon/dp/${p.sku}`;
    case 'citybeach': return `/citybeach/${slugify(p.name)}/${p.sku}.html`;
    case 'pokebox': case 'goodgames': case 'collectiblemadness': case 'cherrycollectables': return `/${store}/products/${p.sku}`;
    case 'gamesmen': return `/gamesmen/${p.sku}`;
    case 'gamesworld': return `/gamesworld/product/${p.sku}/`;
    case 'gameology': return `/gameology/collections/${/one-piece/.test(p.sku) ? 'one-piece-booster-boxs' : 'pokemon-booster-boxes'}/products/${p.sku}`;
    default: return null;
  }
}
