import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
for (const f of process.argv.slice(2)) {
  const doc = await io.read(`public/assets/models/${f}.glb`);
  console.log(f);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const mn = pos.getMin([0, 0, 0]), mx = pos.getMax([0, 0, 0]);
      const m = prim.getMaterial();
      console.log(`  ${node.getName()} / ${m.getName()}  alpha=${m.getAlphaMode()} base=${m.getBaseColorFactor().map((v) => v.toFixed(2))} emis=${m.getEmissiveFactor()} tex=${!!m.getBaseColorTexture()}  y[${mn[1].toFixed(2)},${mx[1].toFixed(2)}] x[${mn[0].toFixed(2)},${mx[0].toFixed(2)}] verts=${pos.getCount()} scale=${node.getScale()}`);
    }
  }
}
