// Zing Pop Culture — DRAFT. Same platform as EB Games, so it uses the EB
// Games flow; not tested on zingpopculture.com.au yet.

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
};
