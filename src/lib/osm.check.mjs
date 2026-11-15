// Self-check: a cancelled signal stops findBarsInBox without its second pass.
// Run: node src/lib/osm.check.mjs
import assert from 'node:assert/strict';

process.env.OVERPASS_URL = 'http://10.255.255.1:9/api'; // unroutable
const { findBarsInBox } = await import('./osm.js');

const ctrl = new AbortController();
const started = Date.now();
setTimeout(() => ctrl.abort(), 300);
await assert.rejects(findBarsInBox({ s: 45, w: 11, n: 45.1, e: 11.1 }, ctrl.signal));
// Uncancelled it would wait out the retry pause and a whole second pass.
assert.ok(Date.now() - started < 3000, 'the query went on after the cancel');
console.log('osm.check ok');
