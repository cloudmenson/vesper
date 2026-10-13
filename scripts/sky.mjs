// Builds the sky from its sources (see scripts/sky.py).   node scripts/sky.mjs
//   Yale Bright Star Catalogue, 5th ed. (public domain)                      → .sky/bsc5.dat
//   NASA/Goddard SVS, Deep Star Maps 2020: the Milky Way (public domain)     → .sky/milkyway_2020_4k.exr
//   Poly Haven, Kloofendal 48d Partly Cloudy (Pure Sky), CC0                 → .sky/cloudy_sky.jpg
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const WORK = '.sky';
const OUT = 'public/assets/sky';
const BLENDER = existsSync('/Applications/Blender.app/Contents/MacOS/Blender') ? '/Applications/Blender.app/Contents/MacOS/Blender' : 'blender';
mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

const fetched = async (file, url, unzip = false) => {
  if (existsSync(`${WORK}/${file}`)) return;
  console.log('fetch  ', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${WORK}/${file}`, unzip ? gunzipSync(buf) : buf);
};
await fetched('bsc5.dat', 'https://cdsarc.cds.unistra.fr/ftp/cats/V/50/catalog.gz', true);
await fetched('milkyway_2020_4k.exr', 'https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/milkyway_2020_4k.exr');
await fetched('cloudy_sky.jpg', 'https://dl.polyhaven.org/file/ph-assets/HDRIs/extra/Tonemapped%20JPG/kloofendal_48d_partly_cloudy_puresky.jpg');
// the clouds that drift over the lake are real ones, cut out of that photograph (see scripts/clouds.mjs)
if (!existsSync(`${OUT}/clouds.webp`)) execFileSync('node', ['scripts/clouds.mjs', `${WORK}/cloudy_sky.jpg`, `${OUT}/clouds.webp`], { stdio: 'inherit' });

// The chart for the telescope: the figures of the constellations, their names and the names of the bright stars,
// from d3-celestial's data (Olaf Frohn, BSD 3-Clause). Angles in radians, right ascension then declination.
{
  const D3 = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/';
  for (const f of ['constellations.lines.json', 'constellations.json', 'starnames.json', 'stars.6.json']) await fetched(f, D3 + f);
  const read = (f) => JSON.parse(readFileSync(`${WORK}/${f}`, 'utf8'));
  const rad = ([lon, lat]) => [+((((lon + 360) % 360) * Math.PI) / 180).toFixed(4), +((lat * Math.PI) / 180).toFixed(4)];
  const lines = read('constellations.lines.json').features.flatMap((f) => f.geometry.coordinates.map((line) => line.flatMap(rad)));
  const figures = read('constellations.json').features.map((f) => [...rad(f.geometry.coordinates), f.properties.name]);
  const names = read('starnames.json');
  const stars = read('stars.6.json')
    .features.filter((f) => f.properties.mag <= 3.2 && names[f.id]?.name)
    .map((f) => [...rad(f.geometry.coordinates), f.properties.mag, names[f.id].name]);
  writeFileSync(`${OUT}/chart.json`, JSON.stringify({ lines, figures, stars }));
  console.log(`wrote   ${OUT}/chart.json  ${lines.length} lines, ${figures.length} constellations, ${stars.length} named stars`);
}
if (process.argv.includes('--chart')) process.exit(0); // only the chart: no need to render the air again

execFileSync(BLENDER, ['-b', '--python-exit-code', '1', '--python', 'scripts/sky.py', '--', WORK, OUT], { stdio: ['ignore', 'inherit', 'inherit'] });

const meta = JSON.parse(readFileSync(`${WORK}/sky.json`, 'utf8'));
const [w, h] = meta.milkyway;
await sharp(readFileSync(`${WORK}/milkyway.raw`), { raw: { width: w, height: h, channels: 3 } }).webp({ quality: 86, effort: 5 }).toFile(`${OUT}/milkyway.webp`);
writeFileSync('src/scene/sky.json', JSON.stringify({ elevations: meta.elevations, size: meta.size, stars: meta.stars }) + '\n');
for (const f of ['twilight.bin', 'stars.bin', 'milkyway.webp', 'clouds.webp']) console.log(`wrote   ${OUT}/${f}  ${Math.round(statSync(`${OUT}/${f}`).size / 1024)} KB`);
