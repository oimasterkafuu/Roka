import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pug from 'pug';
import { format, resolveConfig } from 'prettier';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewsDir = path.join(rootDir, 'views');
const staticDir = path.join(rootDir, 'static');
const templates = (await readdir(viewsDir))
  .filter((name) => name.endsWith('.pug') && name !== 'layout.pug')
  .sort();

for (const name of templates) {
  const outputPath = path.join(staticDir, name.replace(/\.pug$/, '.html'));
  const rendered = pug.renderFile(path.join(viewsDir, name), { pretty: false });
  const prettierConfig = await resolveConfig(outputPath);
  const html = await format(rendered, { ...prettierConfig, parser: 'html', filepath: outputPath });
  await writeFile(outputPath, html);
  console.log(`Built ${path.relative(rootDir, outputPath)}`);
}
