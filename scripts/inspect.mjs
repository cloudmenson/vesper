import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { readdirSync } from 'node:fs';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const f of readdirSync('public/assets/models')) {
  const doc = await io.read('public/assets/models/' + f);
  const root = doc.getRoot();
  const out = [];
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    let min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9], tris = 0;
    const wm = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      tris += (prim.getIndices()?.getCount() ?? pos.getCount()) / 3;
      const v = [0, 0, 0];
      for (let i = 0; i < pos.getCount(); i += Math.max(1, Math.floor(pos.getCount() / 3000))) {
        pos.getElement(i, v);
        const x = wm[0] * v[0] + wm[4] * v[1] + wm[8] * v[2] + wm[12];
        const y = wm[1] * v[0] + wm[5] * v[1] + wm[9] * v[2] + wm[13];
        const z = wm[2] * v[0] + wm[6] * v[1] + wm[10] * v[2] + wm[14];
        min = [Math.min(min[0], x), Math.min(min[1], y), Math.min(min[2], z)];
        max = [Math.max(max[0], x), Math.max(max[1], y), Math.max(max[2], z)];
      }
    }
    const mats = mesh.listPrimitives().map((p) => `${p.getMaterial()?.getName()}${p.getMaterial()?.getAlphaMode() !== 'OPAQUE' ? '(' + p.getMaterial()?.getAlphaMode() + ')' : ''}`);
    out.push(`   ${node.getName().padEnd(34)} tris ${String(Math.round(tris)).padStart(6)}  x[${min[0].toFixed(2)},${max[0].toFixed(2)}] y[${min[1].toFixed(2)},${max[1].toFixed(2)}] z[${min[2].toFixed(2)},${max[2].toFixed(2)}]  ${[...new Set(mats)].join(',')}`);
  }
  console.log(f + '\n' + out.join('\n'));
}
