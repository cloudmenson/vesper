# Turns Poly Haven's "decorative book set" (CC0: a hundred-odd real books, each with its own printed cover) into
# something a web page can afford.   blender -b <set>.blend --python scripts/books.py -- <out.glb>
#
# The set ships one texture per cover. Here every cover is shrunk into one shared atlas and the books' UVs are
# moved to match, so the whole library draws with a single material; each book is left as its own object, stood
# on the origin with its spine toward the viewer, for the page to shelve as it likes.
import bpy, math, os, sys
import numpy as np
from mathutils import Matrix, Vector

out = sys.argv[sys.argv.index('--') + 1]
CELL = 256

books = [o for o in bpy.context.scene.objects if o.type == 'MESH']
print(f'{len(books)} objects', flush=True)


def cover(mat):
    """The image a material paints its surface with."""
    if not mat or not mat.use_nodes:
        return None
    for node in mat.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            link = node.inputs['Base Color'].links
            if link and link[0].from_node.type == 'TEX_IMAGE':
                return link[0].from_node.image
    for node in mat.node_tree.nodes:
        if node.type == 'TEX_IMAGE' and node.image:
            return node.image
    return None


images = []
for o in books:
    for slot in o.material_slots:
        img = cover(slot.material)
        if img and img not in images:
            images.append(img)
cols = math.ceil(math.sqrt(len(images)))
rows = math.ceil(len(images) / cols)
print(f'{len(images)} covers → atlas {cols} × {rows} cells of {CELL}px', flush=True)

atlas = np.zeros((rows * CELL, cols * CELL, 4), dtype=np.float32)
atlas[..., 3] = 1
cell = {}
for k, img in enumerate(images):
    small = img.copy()
    small.scale(CELL, CELL)
    px = np.empty(CELL * CELL * 4, dtype=np.float32)
    small.pixels.foreach_get(px)
    bpy.data.images.remove(small)
    r, c = divmod(k, cols)
    atlas[r * CELL:(r + 1) * CELL, c * CELL:(c + 1) * CELL] = px.reshape(CELL, CELL, 4)
    cell[img] = (c, r)
sheet = bpy.data.images.new('books', cols * CELL, rows * CELL, alpha=False)
sheet.pixels.foreach_set(atlas.ravel())
sheet.filepath_raw = os.path.splitext(out)[0] + '_atlas.png'
sheet.file_format = 'PNG'
sheet.save()

mat = bpy.data.materials.new('books')
mat.use_nodes = True
nodes = mat.node_tree.nodes
nodes.clear()
bsdf = nodes.new('ShaderNodeBsdfPrincipled')
surface = nodes.new('ShaderNodeOutputMaterial')
mat.node_tree.links.new(bsdf.outputs['BSDF'], surface.inputs['Surface'])
tex = nodes.new('ShaderNodeTexImage')
tex.image = sheet
mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
bsdf.inputs['Roughness'].default_value = 0.78

INSET = 0.5 / CELL  # keep samples half a texel inside each cover, so neighbours never bleed in
kept = []
for o in books:
    me = o.data
    if not me.uv_layers or not me.polygons:
        continue
    slots = [cell.get(cover(s.material)) for s in o.material_slots]
    if not any(slots):
        continue
    # the layer the covers are painted through is the one that renders; any other would only get exported in its place
    layer = next((l for l in me.uv_layers if l.active_render), me.uv_layers.active)
    for other in [l for l in me.uv_layers if l != layer]:
        me.uv_layers.remove(other)
    layer = me.uv_layers[0]
    uv = layer.data
    for poly in me.polygons:
        where = slots[poly.material_index] if poly.material_index < len(slots) else None
        if where is None:
            where = next(s for s in slots if s)
        c, r = where
        for li in poly.loop_indices:
            u, v = uv[li].uv
            u = min(max(u % 1.0 if not 0 <= u <= 1 else u, INSET), 1 - INSET)
            v = min(max(v % 1.0 if not 0 <= v <= 1 else v, INSET), 1 - INSET)
            uv[li].uv = ((c + u) / cols, (r + v) / rows)
    me.materials.clear()
    me.materials.append(mat)
    # stand it on the origin: centred across, its back on Y = 0, its foot on Z = 0
    me.transform(o.matrix_world)
    o.parent = None
    o.matrix_world = Matrix.Identity(4)
    co = np.array([v.co[:] for v in me.vertices])
    lo, hi = co.min(axis=0), co.max(axis=0)
    me.transform(Matrix.Translation((-(lo[0] + hi[0]) / 2, -hi[1], -lo[2])))
    kept.append((lo[0], o, hi - lo))
kept.sort(key=lambda k: k[0])
for i, (_, o, size) in enumerate(kept):
    o.name = f'book_{i:03d}'
    o.data.name = o.name
print(f'{len(kept)} books; sizes from {min(k[2][0] for k in kept) * 100:.1f} to {max(k[2][0] for k in kept) * 100:.1f} cm thick, {min(k[2][2] for k in kept) * 100:.0f}–{max(k[2][2] for k in kept) * 100:.0f} cm tall, {max(k[2][1] for k in kept) * 100:.0f} cm deep', flush=True)

bpy.ops.object.select_all(action='DESELECT')
for _, o, _ in kept:
    o.select_set(True)
bpy.context.view_layer.objects.active = kept[0][1]
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_apply=True, export_yup=True)
print('wrote', out, f'{os.path.getsize(out) / 1e6:.1f} MB', flush=True)
