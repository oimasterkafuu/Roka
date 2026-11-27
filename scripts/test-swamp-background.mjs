import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

const { chromium } = createRequire(import.meta.url)(process.env.ROKA_PLAYWRIGHT_MODULE || 'playwright');
const origin = 'http://roka.test';
const assets = new Set([
  '/styles/base.css',
  '/styles/map.css',
  '/swamp.png',
  '/mountain.png',
  '/city.png',
  '/crown.png',
]);
const output = process.env.ROKA_SWAMP_OUTPUT;
const viewports = [
  { name: 'desktop', width: 1440, height: 900, scale: 's4', mobile: false },
  { name: 'mobile', width: 390, height: 844, scale: 's3', mobile: true },
];

function fixture(scale) {
  return `<!doctype html>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/styles/base.css">
    <link rel="stylesheet" href="/styles/map.css">
    <div id="map" class="blink-slow" style="left: 50%; top: 50%">
      <table><tbody>
        <tr>
          <td id="empty" class="${scale} empty"></td>
          <td id="neutral" class="${scale} swamp"></td>
          <td id="red" class="${scale} c1 swamp">12</td>
          <td id="green" class="${scale} c2 swamp">8</td>
        </tr>
        <tr>
          <td class="${scale} mountain empty"></td>
          <td class="${scale} c1 city">20</td>
          <td class="${scale} c2 general">10</td>
          <td class="${scale} empty"></td>
        </tr>
        <tr>
          <td id="fogged" class="${scale} swamp fog"></td>
          <td id="unexplored" class="${scale} empty fog-unexplored"></td>
          <td id="isolated" class="${scale} c1 swamp isolated">4</td>
          <td class="${scale} empty"></td>
        </tr>
      </tbody></table>
    </div>`;
}

test('swamp background in Chromium', async (suite) => {
  if (output) await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    for (const { name, width, height, scale, mobile } of viewports) {
      await suite.test(name, async () => {
        const page = await browser.newPage({
          viewport: { width, height },
          isMobile: mobile,
          hasTouch: mobile,
          deviceScaleFactor: mobile ? 2 : 1,
        });
        try {
          await page.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== origin) return route.abort();
            if (url.pathname === '/')
              return route.fulfill({ contentType: 'text/html', body: fixture(scale) });
            if (assets.has(url.pathname)) return route.fulfill({ path: `static${url.pathname}` });
            return route.abort();
          });
          await page.goto(origin);
          await page.evaluate(async (texture) => {
            const image = new Image();
            image.src = texture;
            await image.decode();
          }, `${origin}/swamp.png`);
          if (output) await page.locator('#map').screenshot({ path: join(output, `${name}.png`) });

          const tiles = await page.locator('#map td[id]').evaluateAll((cells) =>
            Object.fromEntries(
              cells.map((cell) => {
                const { backgroundColor, backgroundImage, boxShadow, filter, opacity } =
                  getComputedStyle(cell);
                return [cell.id, { backgroundColor, backgroundImage, boxShadow, filter, opacity }];
              }),
            ),
          );
          const colors = { neutral: 'rgb(230, 230, 230)', red: 'rgb(255, 0, 0)', green: 'rgb(0, 128, 0)' };
          for (const [tile, backgroundColor] of Object.entries(colors)) {
            assert.deepEqual(
              tiles[tile],
              {
                backgroundColor,
                backgroundImage: `url("${origin}/swamp.png")`,
                boxShadow: 'none',
                filter: 'none',
                opacity: '1',
              },
              tile,
            );
          }
          assert.equal(tiles.empty.backgroundColor, 'rgb(220, 220, 220)');
          assert.equal(tiles.fogged.backgroundColor, 'rgba(0, 0, 0, 0)');
          assert.match(tiles.fogged.boxShadow, /inset/);
          assert.equal(tiles.unexplored.backgroundColor, 'rgb(85, 85, 85)');
          assert.equal(tiles.unexplored.backgroundImage, 'none');
          assert.equal(tiles.isolated.backgroundColor, colors.red);
          assert.equal(tiles.isolated.opacity, '0.45');
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});
