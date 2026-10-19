// Zing Pop Culture — DRAFT. Same platform as EB Games, so it uses the EB
// Games flow; not tested on zingpopculture.com.au yet.
//
// zingpopculture.com.au now sends every visitor to ebgames.com.au (Zing's range is sold
// there), so there is nothing of Zing's own to search: it isn't in the live sweeps at all
// (switched on, an admin's browser only ever got "couldn't reach the store"). EB Games'
// sweeps cover its range.

import ebgames from './ebgames.js';

export default {
  ...ebgames,
  // (EB's queue page, if Zing shows it: seen on a page here too — not checked from a browser.)
  gate: { ...ebgames.gate, check: null },
  id: 'zing',
  name: 'Zing Pop Culture',
  base: 'https://www.zingpopculture.com.au',
  hosts: ['www.zingpopculture.com.au'],
  devPath: undefined,
  flowStatus: 'draft',
  flowNote: 'Uses the EB Games flow (same platform). Not tested yet.',
  productPath: /^\/product\/[^/]+\/\d+/,
  sweep: null,
};
