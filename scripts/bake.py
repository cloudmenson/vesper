# Bakes the house's lighting with Cycles.   blender -b --python scripts/bake.py -- <workdir> <samples>
#
# Reads   <workdir>/house.glb    the building (lm_*, atlas in their 2nd UV set) and emitters (glow_*)
#         <workdir>/props_*.bin  loose objects as plain arrays: positions, normals, triangles
#         <workdir>/scene.json   lamps, emitter strengths, atlas size, vertex count and colour of every loose object
# Writes  <workdir>/{sky,lamps,fire}.bin   float32 RGB, bottom row first: the atlas, one file per layer
#           sky    light from an even white sky: how much of the sky each texel sees
#           lamps  every lamp and LED strip
#           fire   the hearth and the fire bowl
#         <workdir>/props.bin              float32 × 7 per vertex of the loose objects, in order: lamps rgb, sky, fire rgb
# All direct + bounced. Values are Cycles' diffuse pass without colour, i.e. irradiance / pi.
import bpy, json, math, os, sys, time
import numpy as np
from mathutils import Vector

work, samples = sys.argv[sys.argv.index('--') + 1:][:2]
cfg = json.load(open(os.path.join(work, 'scene.json')))
SIZE = cfg['size']

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.join(work, 'house.glb'))
scene = bpy.context.scene

# ---------------------------------------------------------------- renderer
scene.render.engine = 'CYCLES'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'METAL'
prefs.get_devices()
for d in prefs.devices:
    d.use = d.type == 'METAL'
cy = scene.cycles
cy.device = 'GPU'
cy.samples = int(samples)
cy.use_adaptive_sampling = False
cy.max_bounces = 8
cy.diffuse_bounces = 6
cy.glossy_bounces = 2
cy.caustics_reflective = False
cy.caustics_refractive = False
cy.sample_clamp_indirect = 8.0
cy.use_denoising = True
try:
    cy.denoiser = 'OPENIMAGEDENOISE'
except Exception as e:
    print('denoiser:', e)

# ---------------------------------------------------------------- scene
def to_blender(p):
    """three.js is Y-up, Blender Z-up"""
    return Vector((p[0], -p[2], p[1]))

meshes = [o for o in scene.objects if o.type == 'MESH']
lm = [o for o in meshes if o.name.startswith('lm_')]
print(f'meshes: {len(meshes)}, lightmapped: {len(lm)}')

image = bpy.data.images.new('bake', SIZE, SIZE, alpha=False, float_buffer=True)
image.colorspace_settings.name = 'Non-Color'

for o in lm:
    o.data.uv_layers.active_index = 1  # the atlas
    for slot in o.material_slots:
        nt = slot.material.node_tree
        node = nt.nodes.new('ShaderNodeTexImage')
        node.image = image
        nt.nodes.active = node

# ---------------------------------------------------------------- loose objects
# One mesh, vertex for vertex as the page numbered them, built from the page's own arrays: one bake call lights them all.
def raw(name, dtype):
    return np.fromfile(os.path.join(work, name), dtype=dtype)

base = int(sum(cfg['counts']))
props = None
if base:
    # three.js is Y-up, Blender Z-up: (x, y, z) → (x, −z, y)
    turn = lambda a: np.stack([a[:, 0], -a[:, 2], a[:, 1]], axis=1)
    co = turn(raw('props_pos.bin', np.float32).reshape(-1, 3).astype(np.float64))
    no = turn(raw('props_nor.bin', np.float32).reshape(-1, 3).astype(np.float64))
    tri = raw('props_idx.bin', np.uint32).astype(np.int32)
    assert len(co) == base, f'{len(co)} vertices in the file, {base} expected'
    T = len(tri) // 3
    props_me = bpy.data.meshes.new('props')
    mat_index = np.zeros(T, dtype=np.int32)
    start = 0
    for k, (end, colour) in enumerate(zip(cfg['triangles'], cfg['colors'])):
        mat = bpy.data.materials.new(f'occ_{k}')
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes['Principled BSDF']
        bsdf.inputs['Base Color'].default_value = (*colour, 1)
        bsdf.inputs['Roughness'].default_value = 1
        props_me.materials.append(mat)
        mat_index[start:end] = k
        start = end
    props_me.vertices.add(base)
    props_me.loops.add(T * 3)
    props_me.polygons.add(T)
    props_me.vertices.foreach_set('co', co.astype(np.float32).ravel())
    props_me.loops.foreach_set('vertex_index', tri)
    props_me.polygons.foreach_set('loop_start', np.arange(T, dtype=np.int32) * 3)
    props_me.polygons.foreach_set('loop_total', np.full(T, 3, dtype=np.int32))
    props_me.polygons.foreach_set('material_index', mat_index)
    props_me.polygons.foreach_set('use_smooth', np.ones(T, dtype=bool))
    props_me.update()
    assert len(props_me.vertices) == base
    props_me.normals_split_custom_set_from_vertices(no.tolist())
    attr = props_me.color_attributes.new('bake', 'FLOAT_COLOR', 'POINT')
    props_me.color_attributes.active_color = attr
    props = bpy.data.objects.new('props', props_me)
    scene.collection.objects.link(props)
    # vertices that sit at the same place with the same normal (UV seams) must end up with the same light
    key = np.round(np.concatenate([co, no], axis=1) / [1e-4, 1e-4, 1e-4, 0.02, 0.02, 0.02]).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.ravel()
    print(f'loose objects: {len(cfg["counts"])}, {base} vertices ({weld.max() + 1} distinct), {T} triangles', flush=True)

# emitters: LED strips, bulbs, the glow above the slat ceiling
emissions = []
for name, g in cfg['glows'].items():
    mat = bpy.data.materials.get(name)
    if not mat:
        continue
    nt = mat.node_tree
    nt.nodes.clear()
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = (*g['color'], 1)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    emissions.append((em, g['strength'], g.get('group', 'lamps')))

# the lake and the ground: keep the sky from lighting the house from below
bpy.ops.mesh.primitive_plane_add(size=600, location=(0, 0, 0.02))
ground = bpy.context.active_object
gm = bpy.data.materials.new('ground')
gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.03, 0.035, 0.04, 1)
ground.data.materials.append(gm)

world = bpy.data.worlds.new('sky')
world.use_nodes = True
scene.world = world
background = world.node_tree.nodes['Background']
background.inputs['Color'].default_value = (1, 1, 1, 1)

lamps = {'lamps': [], 'fire': []}
for i, L in enumerate(cfg['lights']):
    spot = L['kind'] == 'spot'
    data = bpy.data.lights.new(f'lamp_{i}', 'SPOT' if spot else 'POINT')
    data.color = L['color']
    # Cycles: a point or spot of P watts has a radiant intensity of P / 4pi, so candela map straight across
    data.energy = L['intensity'] * 4 * math.pi
    data.shadow_soft_size = L['radius']
    obj = bpy.data.objects.new(f'lamp_{i}', data)
    obj.location = to_blender(L['pos'])
    if spot:
        data.spot_size = min(math.pi * 0.98, 2 * L['angle'])
        data.spot_blend = 1.0  # no edge to the cone: a downlight's pool fades out, it does not stop
        aim = to_blender(L['target']) - obj.location
        obj.rotation_euler = aim.to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(obj)
    lamps[L['group']].append(obj)

# ---------------------------------------------------------------- denoise
# Cycles does not denoise bakes itself, so each layer is passed through OpenImageDenoise in the compositor.
tree = bpy.data.node_groups.new('denoise', 'CompositorNodeTree')
scene.compositing_node_group = tree
n_img = tree.nodes.new('CompositorNodeImage')
n_img.image = image
n_dn = tree.nodes.new('CompositorNodeDenoise')
tree.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
n_out = tree.nodes.new('NodeGroupOutput')
tree.links.new(n_img.outputs['Image'], n_dn.inputs['Image'])
tree.links.new(n_dn.outputs['Image'], n_out.inputs['Image'])
scene.render.resolution_x = SIZE
scene.render.resolution_y = SIZE
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'OPEN_EXR'
scene.render.image_settings.color_depth = '32'
scene.view_settings.view_transform = 'Raw'

def denoised(name):
    scene.render.filepath = os.path.join(work, name + '.exr')
    bpy.ops.render.render(write_still=True)
    out = bpy.data.images.load(scene.render.filepath)
    px = np.empty(SIZE * SIZE * 4, dtype=np.float32)
    out.pixels.foreach_get(px)
    bpy.data.images.remove(out)
    return np.ascontiguousarray(px.reshape(-1, 4)[:, :3])

# ---------------------------------------------------------------- bake
vertex_samples = int(samples) * 3  # nothing denoises a vertex: it has to converge on its own

def light(sky, group):
    background.inputs['Strength'].default_value = sky
    for g, objs in lamps.items():
        for o in objs:
            o.hide_render = g != group
    for em, strength, g in emissions:
        em.inputs['Strength'].default_value = strength if g == group else 0

def select(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]

layers = {}
def bake(name, sky, group):
    light(sky, group)
    t = time.time()
    cy.samples = int(samples)
    select(lm)
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=8, margin_type='EXTEND', use_clear=True, target='IMAGE_TEXTURES')
    image.update()
    rgb = denoised(name)
    rgb.tofile(os.path.join(work, name + '.bin'))
    print(f'baked {name}: atlas {time.time() - t:.0f}s  mean {rgb.mean():.4f}  max {rgb.max():.2f}', flush=True)
    if props:
        t = time.time()
        cy.samples = vertex_samples
        select([props])
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, use_clear=True, target='VERTEX_COLORS')
        col = np.empty(base * 4, dtype=np.float32)
        props_me.color_attributes['bake'].data.foreach_get('color', col)
        col = np.maximum(col.reshape(-1, 4)[:, :3], 0).astype(np.float64)
        # average over welded vertices
        acc = np.zeros((weld.max() + 1, 3))
        np.add.at(acc, weld, col)
        col = (acc / np.bincount(weld)[:, None])[weld]
        layers[name] = col.astype(np.float32)
        print(f'baked {name}: vertices {time.time() - t:.0f}s  mean {col.mean():.4f}  max {col.max():.2f}', flush=True)

bake('sky', 1, None)
bake('lamps', 0, 'lamps')
bake('fire', 0, 'fire')
if props:
    out = np.concatenate([layers['lamps'], layers['sky'][:, :1], layers['fire']], axis=1).astype(np.float32)
    out.tofile(os.path.join(work, 'props.bin'))
