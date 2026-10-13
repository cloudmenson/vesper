# Grows spruce trees in Blender and photographs them from all round.   blender -b --python scripts/trees.py -- <workdir> <assets>
#
# Each tree is a trunk plus a few thousand cards carrying photographed fir twigs (Poly Haven, CC0).
# Two things come out per variant:
#   <assets>/models/spruce_N.glb          the real mesh, for the handful of trees the camera passes close to
#   <workdir>/trees/N_<row>_<col>_c.png   colour + alpha, lit only by an even sky (so it carries its own soft shadowing)
#   <workdir>/trees/N_<row>_<col>_n.png   world-space normals, rounded off so the crown shades as one volume
# seen from 8 directions at 3 heights; scripts/trees.mjs packs those into impostor atlases for the rest of the forest.
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector

work, assets = sys.argv[sys.argv.index('--') + 1:][:2]
os.makedirs(os.path.join(work, 'trees'), exist_ok=True)

H = 18.0                 # every variant is grown at this height and scaled per instance on the site
FRAME_H = H * 1.06       # what one impostor frame covers, metres
FRAME_PX = (256, 512)
AZIMUTHS = 8
ELEVATIONS = (4, 30, 62)  # degrees above the horizon

# twig sprites in the 1024² atlas: x, y (from the top), w, h — stem at the bottom centre, tip up
SPRITES = [(314, 404, 346, 396), (650, 462, 332, 392), (196, 40, 246, 282), (672, 40, 296, 344)]


def sprite_uv(k):
    x, y, w, h = SPRITES[k]
    return x / 1024, (x + w) / 1024, 1 - (y + h) / 1024, 1 - y / 1024  # u0, u1, v_stem, v_tip


def grow(seed, crown, slim):
    """Returns (trunk, needles) mesh objects for one spruce."""
    rng = np.random.default_rng(seed)
    tw = bmesh.new()
    tw_uv = tw.loops.layers.uv.new('UVMap')
    tr = bmesh.new()
    tr_uv = tr.loops.layers.uv.new('UVMap')

    # --- trunk: a tapering, slightly wandering column
    rings, sides = 22, 7
    wander = lambda z: Vector((0.12 * math.sin(z * 0.31 + seed), 0.1 * math.sin(z * 0.23 + seed * 2.0), 0))
    radius = lambda z: 0.25 * (1 - z / H) ** 0.85 + 0.012
    loop = []
    for k in range(rings + 1):
        z = H * k / rings
        c = wander(z) + Vector((0, 0, z))
        loop.append([tr.verts.new(c + Vector((math.cos(a), math.sin(a), 0)) * radius(z)) for a in (i * 2 * math.pi / sides for i in range(sides))])
    for k in range(rings):
        for i in range(sides):
            j = (i + 1) % sides
            f = tr.faces.new((loop[k][i], loop[k][j], loop[k + 1][j], loop[k + 1][i]))
            for lp, (u, v) in zip(f.loops, ((i / sides, k / rings), ((i + 1) / sides, k / rings), ((i + 1) / sides, (k + 1) / rings), (i / sides, (k + 1) / rings))):
                lp[tr_uv].uv = (u, v)

    def card(base, direction, across, length, width):
        """One twig: a quad from `base` along `direction`, `width` wide across `across`."""
        u0, u1, v0, v1 = sprite_uv(int(rng.integers(len(SPRITES))))
        if rng.random() < 0.5:
            u0, u1 = u1, u0
        a = across.normalized() * width / 2
        tip = base + direction.normalized() * length
        f = tw.faces.new([tw.verts.new(p) for p in (base - a, base + a, tip + a, tip - a)])
        for lp, uv in zip(f.loops, ((u0, v0), (u1, v0), (u1, v1), (u0, v1))):
            lp[tw_uv].uv = uv

    up = Vector((0, 0, 1))

    def branch(z0, az, length, pitch):
        out = Vector((math.cos(az), math.sin(az), 0))
        side = Vector((-math.sin(az), math.cos(az), 0))
        p = wander(z0) + Vector((0, 0, z0)) + out * radius(z0)
        segs = max(2, int(length / 0.42))
        step = length / segs
        for s in range(segs):
            u = s / segs
            # boughs sag under their own weight, then the growing tip turns back up
            ang = pitch - 0.3 * math.sin(math.pi * u) + 0.45 * u * u
            d = out * math.cos(ang) + up * math.sin(ang)
            fade = 1 - 0.45 * u
            twig = (0.55 + 0.35 * rng.random()) * fade * (0.6 + 0.4 * min(1.0, length / 2.5))
            for sgn in (-1, 1, -1, 1):
                # side twigs, fanning out and slightly down
                a = sgn * (0.55 + 0.75 * rng.random())
                sd = (d * math.cos(a) + side * math.sin(a) - up * (0.05 + 0.3 * rng.random())).normalized()
                card(p + d * step * rng.random(), sd, sd.cross(up) + up * 0.3 * rng.uniform(-1, 1), twig * 1.25, twig * 1.1)
            if u > 0.15:
                # the curtain of twigs hanging under the bough
                hang = (d * 0.35 - up).normalized()
                card(p + d * step * rng.random(), hang, side + d * 0.3 * rng.uniform(-1, 1), twig * 1.1, twig * 0.95)
            p = p + d * step
        card(p - d * 0.1, d, side, 0.7 * (0.6 + 0.4 * min(1.0, length / 2.5)), 0.6)

    z = 0.085 * H
    while z < H * 0.985:
        t = (z - 0.085 * H) / (0.9 * H)
        n = int(rng.integers(5, 8)) if t < 0.88 else 4
        reach = crown * (1 - t) ** (0.78 if not slim else 0.95) + 0.22
        pitch = -0.5 + 0.95 * t  # low boughs droop, the top ones reach up
        start = rng.random() * 6.28
        for b in range(n):
            branch(z + rng.uniform(-0.06, 0.06), start + b * 2 * math.pi / n + rng.uniform(-0.35, 0.35), reach * rng.uniform(0.72, 1.12), pitch + rng.uniform(-0.14, 0.14))
        z += (0.4 - 0.22 * t) * rng.uniform(0.8, 1.25)
    for k in range(4):  # the leader
        a = k * math.pi / 2 + 0.4
        card(Vector((0, 0, H - 0.75)) + wander(H), up, Vector((math.cos(a), math.sin(a), 0)), 0.95, 0.5)

    objs = []
    for name, bm in (('trunk', tr), ('needles', tw)):
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        o = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(o)
        objs.append(o)
    print(f'spruce {seed}: {len(objs[1].data.polygons)} twigs', flush=True)
    return objs


def material(name, image, alpha, normal_pass):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = image
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    if normal_pass:
        # needles: a normal that leans out from the trunk and up, so the whole crown shades like a cone
        geo = nt.nodes.new('ShaderNodeNewGeometry')
        if alpha:
            sep = nt.nodes.new('ShaderNodeSeparateXYZ')
            nt.links.new(geo.outputs['Position'], sep.inputs[0])
            comb = nt.nodes.new('ShaderNodeCombineXYZ')
            nt.links.new(sep.outputs['X'], comb.inputs['X'])
            nt.links.new(sep.outputs['Y'], comb.inputs['Y'])
            comb.inputs['Z'].default_value = 1.6
            norm = nt.nodes.new('ShaderNodeVectorMath')
            norm.operation = 'NORMALIZE'
            nt.links.new(comb.outputs[0], norm.inputs[0])
            src = norm.outputs[0]
        else:
            src = geo.outputs['Normal']
        enc = nt.nodes.new('ShaderNodeVectorMath')
        enc.operation = 'MULTIPLY_ADD'
        enc.inputs[1].default_value = (0.5, 0.5, 0.5)
        enc.inputs[2].default_value = (0.5, 0.5, 0.5)
        nt.links.new(src, enc.inputs[0])
        surf = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(enc.outputs[0], surf.inputs['Color'])
        shader = surf.outputs[0]
    else:
        surf = nt.nodes.new('ShaderNodeBsdfDiffuse')
        nt.links.new(tex.outputs['Color'], surf.inputs['Color'])
        shader = surf.outputs[0]
    if alpha:
        clear = nt.nodes.new('ShaderNodeBsdfTransparent')
        mix = nt.nodes.new('ShaderNodeMixShader')
        cut = nt.nodes.new('ShaderNodeMath')
        cut.operation = 'GREATER_THAN'
        cut.inputs[1].default_value = 0.35
        nt.links.new(tex.outputs['Alpha'], cut.inputs[0])
        nt.links.new(cut.outputs[0], mix.inputs[0])
        nt.links.new(clear.outputs[0], mix.inputs[1])
        nt.links.new(shader, mix.inputs[2])
        shader = mix.outputs[0]
    nt.links.new(shader, out.inputs['Surface'])
    return mat


for variant, (seed, crown, slim) in enumerate(((3, 3.9, False), (8, 3.1, True))):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    trunk, needles = grow(seed, crown, slim)

    # --- the mesh itself, for close-ups
    bpy.ops.object.select_all(action='DESELECT')
    for o in (trunk, needles):
        o.select_set(True)
    glb = os.path.join(assets, 'models', f'spruce_{variant}.glb')
    bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB', use_selection=True, export_materials='NONE', export_yup=True)
    print('wrote', glb, f'{os.path.getsize(glb) / 1024:.0f} KB', flush=True)

    # --- the photographs
    # PNG copies made by scripts/trees.mjs: Blender reads their alpha reliably
    twig = bpy.data.images.load(os.path.abspath(os.path.join(work, 'fir_twig.png')))
    twig.alpha_mode = 'STRAIGHT'
    bark = bpy.data.images.load(os.path.abspath(os.path.join(work, 'bark.png')))
    print('twig image', twig.size[:], 'channels', twig.channels, 'depth', twig.depth, flush=True)
    looks = {
        'c': (material('needles', twig, True, False), material('bark', bark, False, False)),
        'n': (material('needles_n', twig, True, True), material('bark_n', bark, False, True)),
    }
    scene.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    prefs.compute_device_type = 'METAL'
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == 'METAL'
    scene.cycles.device = 'GPU'
    scene.cycles.samples = 48
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 3
    scene.cycles.transparent_max_bounces = 24
    scene.render.film_transparent = True
    scene.render.resolution_x, scene.render.resolution_y = FRAME_PX
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.color_depth = '8'

    # an even sky, a darker ground: the only light, so the frames hold soft self-shadowing and nothing directional
    world = bpy.data.worlds.new('sky')
    world.use_nodes = True
    scene.world = world
    wn = world.node_tree
    bg = wn.nodes['Background']
    geo = wn.nodes.new('ShaderNodeNewGeometry')
    sep = wn.nodes.new('ShaderNodeSeparateXYZ')
    ramp = wn.nodes.new('ShaderNodeMapRange')
    ramp.inputs['From Min'].default_value = -0.25
    ramp.inputs['From Max'].default_value = 0.25
    ramp.inputs['To Min'].default_value = 0.28
    ramp.inputs['To Max'].default_value = 1.0
    wn.links.new(geo.outputs['Incoming'], sep.inputs[0])
    wn.links.new(sep.outputs['Z'], ramp.inputs['Value'])
    wn.links.new(ramp.outputs[0], bg.inputs['Strength'])
    bg.inputs['Color'].default_value = (1, 1, 1, 1)

    cam_data = bpy.data.cameras.new('cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = FRAME_H
    cam_data.clip_end = 200
    cam = bpy.data.objects.new('cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    centre = Vector((0, 0, H / 2))

    for row, el in enumerate(ELEVATIONS):
        e = math.radians(el)
        for col in range(AZIMUTHS):
            a = col * 2 * math.pi / AZIMUTHS
            # azimuth is measured the way the site does: from its +Z (Blender −Y) toward +X
            d = Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e)))
            cam.location = centre + d * 60
            cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
            for key, (m_needles, m_bark) in looks.items():
                needles.data.materials.clear()
                needles.data.materials.append(m_needles)
                trunk.data.materials.clear()
                trunk.data.materials.append(m_bark)
                scene.view_settings.view_transform = 'Standard' if key == 'c' else 'Raw'
                scene.render.filepath = os.path.join(work, 'trees', f'{variant}_{row}_{col}_{key}.png')
                bpy.ops.render.render(write_still=True)
        print(f'variant {variant}: elevation {el}° done', flush=True)
