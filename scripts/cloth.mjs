// Simulates the soft furnishings in Blender (bed linen, pillows, the sofa's cushions, curtains), then compresses the results.
//   node scripts/cloth.mjs [bed sofa drape curtain]
import { execFileSync } from 'node:child_process';
import { existsSync, statSync, renameSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const BLENDER = existsSync('/Applications/Blender.app/Contents/MacOS/Blender') ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender';
const jobs = process.argv.slice(2).length ? process.argv.slice(2) : ['bed', 'sofa', 'drape', 'curtain'];
// the scanned throw pillows the sofa and bed are dressed with (Poly Haven, CC0), as plain glTF for Blender to read
if (jobs.includes('sofa') || jobs.includes('bed')) {
  const id = 'throw_pillows_01';
  const dir = `.bake/${id}`;
  if (!existsSync(`${dir}/${id}.gltf`)) {
    const g = (await (await fetch(`https://api.polyhaven.com/files/${id}`)).json()).gltf['1k'].gltf;
    const save = async (rel, url) => {
      mkdirSync(dirname(`${dir}/${rel}`), { recursive: true });
      writeFileSync(`${dir}/${rel}`, Buffer.from(await (await fetch(url)).arrayBuffer()));
    };
    await save(`${id}.gltf`, g.url);
    for (const [rel, f] of Object.entries(g.include)) await save(rel, f.url);
    console.log(`fetched ${id}`);
  }
}
execFileSync(BLENDER, ['-b', '--python-exit-code', '1', '--python', 'scripts/cloth.py', '--', 'public/assets', ...jobs], { stdio: ['ignore', 'ignore', 'inherit'] });
const MADE = { bed: ['bed_duvet', 'bed_throw', 'bed_pillows'], sofa: ['sofa'], drape: ['drape'] };
for (const [job, names] of Object.entries(MADE)) for (const name of names) {
  if (jobs.length && !jobs.includes(job)) continue;
  const file = `public/assets/models/${name}.glb`;
  execFileSync('npx', ['gltf-transform', 'optimize', file, `${file}.tmp.glb`, '--compress', 'meshopt', '--texture-compress', 'webp', '--texture-size', '1024', '--instance', 'false', '--simplify', 'false', '--join', 'false'], { stdio: 'ignore' });
  renameSync(`${file}.tmp.glb`, file);
  console.log(`${file}  ${Math.round(statSync(file).size / 1024)} KB`);
}
if (existsSync('public/assets/cloth/curtain.bin')) console.log(`public/assets/cloth/curtain.bin  ${Math.round(statSync('public/assets/cloth/curtain.bin').size / 1024)} KB`);
