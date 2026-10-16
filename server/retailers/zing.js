// Zing Pop Culture — DRAFT. Same platform as EB Games, so it uses the EB
// Games flow; not tested on zingpopculture.com.au yet.
//
// zingpopculture.com.au now sends every visitor to ebgames.com.au (Zing's range is sold
// there), so there is nothing of Zing's own to search: its live sweeps are off unless an
// admin switches them on. EB Games' sweeps cover it.

import ebgames from './ebgames.js';

export default {
  ...ebgames,
  id: 'zing',
  name: 'Zing Pop Culture',
  base: 'https://www.zingpopculture.com.au',
  hosts: ['www.zingpopculture.com.au'],
  devPath: undefined,
  flowStatus: 'draft',
  flowNote: 'Uses the EB Games flow (same platform). Not tested yet.',
  productPath: /^\/product\/[^/]+\/\d+/,
  sweep: { ...ebgames.sweep, from: 'off', formerDefault: 'browser' },
};
