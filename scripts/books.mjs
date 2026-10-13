// The library: Poly Haven's decorative book set (CC0), re-packed in Blender so that a hundred covers share one
// texture (see scripts/books.py).   node scripts/books.mjs   → public/assets/models/books.glb
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const ID = 'decorative_book_set_01';
const WORK = `.bake/${ID}`;
const OUT = 'public/assets/models/books.glb';
const BLENDER = existsSync('/Applications/Blender.app/Contents/MacOS/Blender') ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender';

const files = await (await fetch(`https://api.polyhaven.com/files/${ID}`)).json();
const blend = files.blend['1k'].blend;
const save = async (rel, url) => {
  const file = `${WORK}/${rel}`;
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
};
await save(`${ID}.blend`, blend.url);
const includes = Object.entries(blend.include);
for (let i = 0; i < includes.length; i += 8) await Promise.all(includes.slice(i, i + 8).map(([rel, f]) => save(rel, f.url)));
console.log(`fetched ${ID}: ${includes.length} textures`);

execFileSync(BLENDER, ['-b', `${WORK}/${ID}.blend`, '--python-exit-code', '1', '--python', 'scripts/books.py', '--', `${WORK}/books.glb`], { stdio: ['ignore', 'inherit', 'inherit'] });
execFileSync('npx', ['gltf-transform', 'optimize', `${WORK}/books.glb`, OUT, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '4096', '--instance', 'false', '--join', 'false', '--flatten', 'false', '--simplify-ratio', '0.3', '--simplify-error', '0.002', '--simplify-lock-border', 'true'], { stdio: 'ignore' });
console.log(`${OUT}  ${Math.round(statSync(OUT).size / 1024)} KB`);
