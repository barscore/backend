import fs from 'fs';
import { findNearbyBars } from './src/lib/osm.js';
findNearbyBars(45.4654, 9.1859, 2).then(bars => {
  console.log("Bars:", bars.length);
}).catch(console.error);
