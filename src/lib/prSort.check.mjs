// Run: node src/lib/prSort.check.mjs
import assert from 'node:assert/strict';
import { sortPrs } from './prSort.js';

const ids = (l) => sortPrs(l).map((p) => p.id).join('');
// Nearest with presales first; unknown distance after; sold out last, even if nearest.
assert.equal(
  ids([
    { id: 'a', presales_available: 0, distance_km: 1 },
    { id: 'b', presales_available: 5, distance_km: 9 },
    { id: 'c', presales_available: null, distance_km: 3 },
    { id: 'd', presales_available: 2, distance_km: null },
  ]),
  'cbda',
);
// No distances at all: the order it came in.
assert.equal(ids([{ id: 'x' }, { id: 'y' }]), 'xy');
console.log('prSort.check ok');
