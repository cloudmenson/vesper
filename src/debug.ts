import * as THREE from 'three';

/** Dev aid: what is under this pixel? `x`, `y` in normalised device coordinates. */
export function pick(scene: THREE.Scene, camera: THREE.Camera, x: number, y: number) {
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(x, y), camera);
  return ray
    .intersectObjects(scene.children, true)
    .filter((h) => h.object.visible && !(h.object as THREE.Points).isPoints)
    .slice(0, 4)
    .map((h) => {
      const mesh = h.object as THREE.Mesh;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial;
      const chain: string[] = [];
      for (let o: THREE.Object3D | null = mesh; o; o = o.parent) chain.push(o.name || o.type);
      return {
        d: +h.distance.toFixed(2),
        at: h.point.toArray().map((v) => +v.toFixed(2)),
        chain: chain.slice(0, 4).join(' < '),
        mat: `${mat?.type} ${mat?.name ?? ''} #${mat?.color?.getHexString?.() ?? ''} map=${!!mat?.map} transparent=${mat?.transparent} op=${mat?.opacity}`,
        verts: mesh.geometry?.attributes.position.count,
        order: mesh.renderOrder,
      };
    });
}
