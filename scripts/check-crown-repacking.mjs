import assert from 'node:assert/strict';
import { megaFamilies, repackMegaCrowns } from '../src/map/mega-random-map-generator.ts';

function* teamSizes(left, smallest = 1) {
  if (!left) yield [];
  for (let size = smallest; size <= left; size++)
    for (const rest of teamSizes(left - size, size)) yield [size, ...rest];
}

const families = process.argv.length > 2 ? process.argv.slice(2) : megaFamilies;
for (const family of families) {
  assert.ok(megaFamilies.includes(family), family);
  let cases = 0;
  for (let players = 2; players <= 16; players++) {
    for (const sizes of teamSizes(players)) {
      const teams = sizes.flatMap((size, team) => Array(size).fill(team + 1));
      const map = repackMegaCrowns(family, teams);
      assert.equal(map.generals.length, players);
      cases++;
    }
    console.log(`PASS ${family}/${players}: ${cases} cumulative packings`);
  }
  assert.equal(cases, 913);
}
