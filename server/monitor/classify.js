// What a product is, from its name: which game, what kind of product (a booster box, a hangsell, an Elite Trainer
// Box…), its set codes (OP-20, EB-05…) — so a drop is told apart from a restock of an accessory, an alert's priority
// can follow what members chase, and Auto-checkout knows how many to put in the bag: a booster box (or display, or
// case) one; a booster pack, hangsell or blister as many as the store allows (watches set to "auto", MONITORING.md).
//
// Names as Australian stores write them, e.g. EB Games' "One Piece TCG OP-19 Hangsell Booster", "One Piece TCG EB-05
// Booster", Premium Bandai's "ONE PIECE CARD GAME PREMIUM BOOSTER -THE BEST vol.2- [PRB-02] (BOX)".

const norm = (s) => String(s || '').toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '') // pokémon → pokemon
  .replace(/[‐-―]/g, '-')
  .replace(/\s+/g, ' ').trim();

// One Piece's set codes: OP-20 (main sets), EB-05 (extra boosters), PRB-02 (premium boosters), ST-21 (starter decks).
const OP_CODE = /\b(op|eb|prb|st)\s?-?\s?(\d{2})\b/g;
// Pokémon's: SV10, SV8a, ME01 (Mega Evolution), SWSH12 — and its English set names stores use.
const PKM_CODE = /\b(sv|swsh|me|sm)\s?-?\s?(\d{1,2}(?:\.\d)?[a-z]?)\b/g;

export const GAMES = Object.freeze({ onepiece: 'One Piece', pokemon: 'Pokémon', other: 'Other' });

export const TYPES = Object.freeze({
  case: 'Case',
  booster_box: 'Booster box',
  elite_trainer_box: 'Elite Trainer Box',
  booster_bundle: 'Booster bundle',
  premium_collection: 'Premium collection',
  collection: 'Collection box',
  tin: 'Tin',
  starter_deck: 'Starter deck',
  hangsell: 'Hangsell',
  blister: 'Blister',
  booster_pack: 'Booster pack',
  single: 'Single card',
  accessory: 'Accessory',
  other: 'Other',
});

/** Pokémon / One Piece / other, from a name. */
export function gameOf(name) {
  const n = norm(name);
  if (/\bone ?piece\b|\bstraw hat\b/.test(n)) return 'onepiece';
  if (/\bpokemon\b|\bpikachu\b|\bscarlet (?:&|and)? ?violet\b|\belite trainer\b|\betb\b|\bmega evolution\b/.test(n)) return 'pokemon';
  // (A One Piece set code on its own — "OP-20 Booster Box" — at a card shop that leaves the game's name out.)
  if (/\b(op|eb|prb)-\d{2}\b/.test(n) && /\bbooster|\bpack|\bbox|\bdisplay|\bdeck|\bhang ?sell/.test(n)) return 'onepiece';
  return 'other';
}

// An individual card, sold on its own — already unpacked (Mugibot 2.2): never Auto-checkout's to buy by itself, whatever
// watch finds it. As stores write them: EB Games' "One Piece - TCG - One Piece Promotion Cards - Ms. All Sunday (Promotion
// Pack 2023) Normal OP01-079 - NM/M", "… Borsalino Foil EB04-058 - NM/M"; a card shop's "Pokemon Charizard ex 199/165 - Near
// Mint". Sure signs anywhere: its condition (NM/M, Near Mint, Lightly Played, PSA 10) or a One Piece card number (OP01-079,
// EB04-058, ST10-001, PRB01-001). Signs only in a card game's name (never "Single Serve Coffee Maker", "Laptop - HP"):
// "single", a Pokémon card number (199/165, SVP 045, TG05/TG30, P-001), a short condition at its end ("- LP").
const SURE_CONDITION = /\bnm\s?\/\s?m\b|\bnear[- ]mint\b|\b(lightly|moderately|heavily) played\b|\b(psa|bgs|cgc)\s?\d/;
const OP_CARD = /\b(op|eb|st|prb)\s?\d{1,2}\s?-\s?\d{3}\b/;
const TCG_NAME = /\btcg\b|\bccg\b|\bcard game\b|\btrading cards?\b|\bpromo(tion)? cards?\b|\bmagic the gathering\b|\bmtg\b|\byu-?gi-?oh\b|\blorcana\b|\bdigimon\b|\bflesh and blood\b/;
const CARD_NUMBER = /\bp-\d{3}\b|\b\d{1,3}\s?\/\s?\d{2,3}\b|\b(tg|gg|sv|svp|swsh)\s?\d{1,3}\s?\/\s?(tg|gg|sv)?\s?\d{2,3}\b|\bsv-?p\s?\d{2,3}\b|\bswsh\s?\d{3}\b/;
const CONDITION = /\bmint condition\b|(?:-|\()\s*(nm|lp|mp|hp|dmg)\s*\)?$|\bgraded\b/;
const SINGLE_WORDS = /\bsingles?\b(?!\s?(booster|pack|blister|sleeved|deck|tin))|\bindividual card\b|\bpromo card\b(?!s? (box|pack|collection|set))/;
// (A sealed product's own words: never a single, whatever numbers it carries — "Booster Box (24 Packs)", "36/box".)
const SEALED_WORDS = /\bbooster (box|display|bundle|case)\b|\bdisplay\b|\belite trainer\b|\betb\b|\bstarter deck\b|\bdeck set\b|\bcollection\b|\bhang ?sell\b|\bblister\b|\btin\b|\bcase of\b|\bsealed\b/;

const ACCESSORY = /\b(card )?sleeves?\b|\bplay ?mats?\b|\bbinders?\b|\bportfolios?\b|\bdeck (box|boxes|case|cases)\b|\bcard (case|box|holder|storage)\b|\btop ?loaders?\b|\bstorage box\b|\bdice\b|\bdamage counters?\b|\bpouch\b|\bkey ?(chain|ring)\b|\bfigur(e|ine)s?\b|\bplush\b|\bt-?shirt\b|\bhoodie\b|\bposter\b|\bstickers?\b|\bpin badge\b|\balbum\b/;

/** An individual card sold on its own (already unpacked) — never bought by Auto-checkout on a watch's say. */
export function isSingle(name) {
  const n = norm(name);
  if (!n) return false;
  if (SURE_CONDITION.test(n)) return true;
  const sealed = SEALED_WORDS.test(n);
  if (OP_CARD.test(n) && !sealed) return true;
  if (!(TCG_NAME.test(n) || gameOf(name) !== 'other')) return false;
  if (SINGLE_WORDS.test(n) || CONDITION.test(n)) return true;
  return CARD_NUMBER.test(n) && !sealed;
}

/** An accessory (sleeves, a playmat, a binder, a deck box, a figure…) — never a card product. */
export function isAccessory(name) {
  return typeOf(name) === 'accessory';
}

/**
 * A sealed product Auto-checkout may buy on a watch's say (Mugibot 2.2): a booster box, pack, hangsell, blister, bundle,
 * Elite Trainer Box, deck, collection, tin or case — never a single card, an accessory, or anything it can't tell.
 */
export function isSealed(name) {
  const t = typeOf(name);
  return t !== 'other' && t !== 'single' && t !== 'accessory';
}

/** The kind of product, from a name: one of TYPES. */
export function typeOf(name) {
  const n = norm(name);
  // (An individual card first: "(Promotion Pack 2023) … OP01-079 - NM/M" is a card, not a pack.)
  if (isSingle(name)) return 'single';
  // A sealed case of booster boxes (never a deck case or a card case: accessories).
  if (/\b(booster|display|box(es)?)\b[^,()]*\bcase\b|\bcase\b[^,()]*\b(of )?\d+ ?(booster )?(boxes|displays)\b|\b\d+ ?(boxes|displays)\b|\bsealed case\b/.test(n) && !/\b(deck|card|binder|portfolio|storage|phone|carry|pencil) case\b/.test(n)) return 'case';
  if (/\belite trainer box\b|\betb\b/.test(n)) return 'elite_trainer_box';
  if (/\bbooster bundle\b/.test(n)) return 'booster_bundle';
  // A booster box or display ("Booster Box", "Booster Display", "Display Box", "(BOX)", "Box of 24 packs").
  if (/\bbooster (box|display)\b|\bdisplay (box|of)\b|\(box\)|\[box\]|\bbox (of|with) \d+ (booster )?packs?\b|\b\d+ ?(booster )?packs? (booster )?(box|display)\b|\bbooster box\b/.test(n)) return 'booster_box';
  if (/\bultra[- ]?premium\b|\bpremium collection\b|\bupc\b|\bspecial collection\b|\bsuper[- ]premium\b/.test(n)) return 'premium_collection';
  if (/\bcollection( box)?\b|\bgift (box|set)\b|\bbinder collection\b|\bbuild (&|and) battle\b|\billustration box\b|\bsurprise box\b|\btrainer'?s toolkit\b|\banniversary (box|set)\b|\bspecial set\b|\bpremium (card )?set\b/.test(n)) return 'collection';
  if (/\btin\b/.test(n)) return 'tin';
  if (/\bstarter deck\b|\bstructure deck\b|\btheme deck\b|\bbattle deck\b|\bdeck\b.*\b(st-\d{2})\b|\bst-\d{2}\b/.test(n)) return 'starter_deck';
  if (/\bhang ?sell\b|\bhanger\b/.test(n)) return 'hangsell';
  if (/\bblister\b|\bcheckl?ane\b/.test(n)) return 'blister';
  // (An accessory — sleeves, a playmat, a binder, a deck box — never a pack, whatever it's called: "Official Sleeves Pack".)
  if (ACCESSORY.test(n) && !/\bboosters?\b/.test(n)) return 'accessory';
  // A single booster ("EB-05 Booster", "Booster Pack", "Sleeved Booster", "Double Pack Set").
  if (/\bboosters?\b|\bbooster packs?\b|\bdouble pack\b|\bpack\b/.test(n)) return 'booster_pack';
  return 'other';
}

/** The set codes in a name, upper-case: ['OP-20'], ['EB-05'], ['SV10']. */
export function setCodes(name) {
  const n = norm(name);
  const out = new Set();
  for (const m of n.matchAll(OP_CODE)) out.add(`${m[1].toUpperCase()}-${m[2]}`);
  for (const m of n.matchAll(PKM_CODE)) out.add(`${m[1].toUpperCase()}${m[2].toUpperCase()}`);
  return [...out];
}

/**
 * How many Auto-checkout puts in the bag for a product, by its kind: 'max' (as many as the store allows) for a booster
 * pack, hangsell or blister; 1 for everything else — a booster box, display or case above all.
 */
export function quantityRuleFor(name) {
  const t = typeOf(name);
  return t === 'booster_pack' || t === 'hangsell' || t === 'blister' ? 'max' : 1;
}

// What members chase most: a new set's booster box, an Elite Trainer Box, a limited collection — first in Discord's line.
const HIGH_TYPES = new Set(['booster_box', 'case', 'elite_trainer_box', 'premium_collection', 'booster_bundle']);

/**
 * The whole picture: { game, type, typeLabel, codes, quantity, priority } — priority 'high' for Pokémon and One Piece's
 * boxes, cases, ETBs and premium collections and every One Piece set product (its drops sell out in minutes), 'normal'
 * for the rest of the two games' cards, 'low' for anything else.
 */
export function classify(name) {
  const game = gameOf(name);
  const type = typeOf(name);
  const codes = setCodes(name);
  const tcg = game !== 'other';
  const priority = tcg && (HIGH_TYPES.has(type) || (game === 'onepiece' && codes.some((c) => /^(OP|EB|PRB)-/.test(c)))) ? 'high' : tcg ? 'normal' : 'low';
  return { game, type, typeLabel: TYPES[type], codes, quantity: quantityRuleFor(name), priority };
}

/** A watch's quantity setting, checked: 'auto', 'max', or '1'…'10' (anything else: def). */
export function qtySetting(v, def = '1') {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'auto' || s === 'max') return s;
  const n = Number(s);
  return s !== '' && Number.isInteger(n) && n >= 1 && n <= 10 ? String(n) : def;
}

/**
 * How many a watch's find is bought in, from the watch's setting and the product's name: 'max' (as many as the store
 * allows) or a number — 'auto' by the kind of product (quantityRuleFor).
 */
export function quantityFor(setting, name) {
  const s = qtySetting(setting);
  if (s === 'auto') return quantityRuleFor(name);
  return s === 'max' ? 'max' : Number(s);
}
