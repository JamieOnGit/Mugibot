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

/** The kind of product, from a name: one of TYPES. */
export function typeOf(name) {
  const n = norm(name);
  // A sealed case of booster boxes (never a deck case or a card case: accessories).
  if (/\b(booster|display|box(es)?)\b[^,()]*\bcase\b|\bcase\b[^,()]*\b(of )?\d+ ?(booster )?(boxes|displays)\b|\b\d+ ?(boxes|displays)\b|\bsealed case\b/.test(n) && !/\b(deck|card|binder|portfolio|storage|phone|carry|pencil) case\b/.test(n)) return 'case';
  if (/\belite trainer box\b|\betb\b/.test(n)) return 'elite_trainer_box';
  if (/\bbooster bundle\b/.test(n)) return 'booster_bundle';
  // A booster box or display ("Booster Box", "Booster Display", "Display Box", "(BOX)", "Box of 24 packs").
  if (/\bbooster (box|display)\b|\bdisplay (box|of)\b|\(box\)|\[box\]|\bbox (of|with) \d+ (booster )?packs?\b|\b\d+ ?(booster )?packs? (booster )?(box|display)\b|\bbooster box\b/.test(n)) return 'booster_box';
  if (/\bultra[- ]?premium\b|\bpremium collection\b|\bupc\b|\bspecial collection\b|\bsuper[- ]premium\b/.test(n)) return 'premium_collection';
  if (/\bcollection( box)?\b|\bgift (box|set)\b|\bbinder collection\b/.test(n)) return 'collection';
  if (/\btin\b/.test(n)) return 'tin';
  if (/\bstarter deck\b|\bstructure deck\b|\btheme deck\b|\bbattle deck\b|\bdeck\b.*\b(st-\d{2})\b|\bst-\d{2}\b/.test(n)) return 'starter_deck';
  if (/\bhang ?sell\b|\bhanger\b/.test(n)) return 'hangsell';
  if (/\bblister\b|\bcheckl?ane\b/.test(n)) return 'blister';
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
