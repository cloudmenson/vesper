# Simulates the house's soft furnishings in Blender.   blender -b --python scripts/cloth.py -- <outdir> [bed|sofa|drape|curtain ...]
#
#   bed      a duvet laid square on the bed and left to settle, then a  → models/bed_duvet.glb
#            throw laid straight across its foot                        → models/bed_throw.glb
#   sofa     every cushion of the sofa: a fabric box under pressure,    → models/sofa.glb
#            sat on its base so it sags and crowns like upholstery
#   drape    a pleated linen curtain hung from its rail and left alone  → models/drape.glb
#   curtain  a sheer by the sliding door, caught by the draught as the
#            door opens: every frame of the simulation is kept          → cloth/curtain.bin (+ curtain.json)
#   <outdir>/../../.bake/cloth-*.png shows each result as Blender sees it.
#
# Each piece is simulated in its own local frame (X across, Y back into the room, Z up, metres),
# so the site only has to place it.
import bpy, bmesh, json, math, os, sys
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

args = sys.argv[sys.argv.index('--') + 1:]
out = args[0]
jobs = args[1:] or ['bed', 'sofa', 'drape', 'curtain']
os.makedirs(os.path.join(out, 'models'), exist_ok=True)
os.makedirs(os.path.join(out, 'cloth'), exist_ok=True)
WORK = os.path.join(out, '..', '..', '.bake')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


def box(name, lo, hi, friction=30.0, thickness=0.012):
    """Axis-aligned collider."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=[(a + b) / 2 for a, b in zip(lo, hi)])
    o = bpy.context.active_object
    o.name = name
    o.scale = [b - a for a, b in zip(lo, hi)]
    bpy.ops.object.transform_apply(scale=True)
    collide(o, friction, thickness)
    return o


def collide(o, friction=30.0, thickness=0.012):
    """Makes an object something cloth lies against. `thickness` is how far off its surface the cloth is held."""
    o.modifiers.new('Collision', 'COLLISION')
    o.collision.thickness_outer = thickness
    o.collision.thickness_inner = 0.05
    o.collision.cloth_friction = friction


def grid(name, w, h, nx, ny, place):
    """A sheet of nx × ny quads. `place(u, v)` maps 0..1 to a rest position; UVs run 0..1 across the sheet."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    verts = [[bm.verts.new(place(i / nx, j / ny)) for i in range(nx + 1)] for j in range(ny + 1)]
    for j in range(ny):
        for i in range(nx):
            f = bm.faces.new((verts[j][i], verts[j][i + 1], verts[j + 1][i + 1], verts[j + 1][i]))
            for loop, (di, dj) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
                loop[uv].uv = ((i + di) / nx, (j + dj) / ny)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def cloth(o, mass, tension, bending, shrink=0.0, pin=None, quality=10, self_collide=True):
    mod = o.modifiers.new('Cloth', 'CLOTH')
    s = mod.settings
    s.quality = quality
    s.mass = mass
    s.tension_stiffness = tension
    s.compression_stiffness = tension
    s.shear_stiffness = tension * 0.5
    s.bending_stiffness = bending
    s.tension_damping = 5
    s.compression_damping = 5
    s.bending_damping = 0.5
    s.air_damping = 1.0
    s.shrink_min = shrink
    if pin:
        s.vertex_group_mass = pin
    c = mod.collision_settings
    c.use_collision = True
    c.distance_min = 0.012
    c.collision_quality = 4
    c.use_self_collision = self_collide
    c.self_distance_min = 0.008
    c.self_friction = 8
    return mod


def run(scene, mod, last, each=None):
    scene.frame_start = 1
    scene.frame_end = last
    mod.point_cache.frame_start = 1
    mod.point_cache.frame_end = last
    for f in range(1, last + 1):
        scene.frame_set(f)
        if each:
            each(f)


def freeze(o, thickness=0.0, subdiv=0, smooth=6):
    """Stops the simulation where it is, and gives the cloth body."""
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier='Cloth')
    if smooth:
        sm = o.modifiers.new('Smooth', 'CORRECTIVE_SMOOTH')
        sm.iterations = smooth
        sm.factor = 0.5
    if thickness:
        so = o.modifiers.new('Solidify', 'SOLIDIFY')
        so.thickness = thickness
        so.offset = 1
    if subdiv:
        sub = o.modifiers.new('Subdivision', 'SUBSURF')
        sub.levels = subdiv
        sub.render_levels = subdiv
    for p in o.data.polygons:
        p.use_smooth = True


def outward(o):
    """Turns a closed shape's faces to look out of it. (A pillow sewn here can come out of the simulation inside out:
    it still looks right in a clay render, but lit in the house every face of it is in its own shadow.)"""
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def write(objs, path, materials=False):
    """`materials`: keep the ones the objects came with (the scanned pillows bring their fabric); cloth made here has none."""
    for o in objs:
        if o.name.startswith('pillow_white'):
            outward(o)
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_materials='EXPORT' if materials else 'NONE', export_yup=True)
    print('wrote', path, f'{os.path.getsize(path) / 1024:.0f} KB', flush=True)


def export(o, path, thickness, subdiv=0):
    freeze(o, thickness, subdiv)
    write([o], path)


TINTS = {'rust': (0.55, 0.16, 0.06), 'ochre': (0.7, 0.45, 0.1), 'forest': (0.08, 0.17, 0.1), 'grey': (0.36, 0.35, 0.33), 'lumbar': (0.55, 0.16, 0.06), 'frame': (0.12, 0.08, 0.05)}


def preview(name, objs, eye=(2.6, -3.2, 1.9), aim=(0, 0, 0.3), lens=50, more=()):
    """Quick clay renders: the only way to see what the simulation did without loading the site.
    `more` is further views of the same set-up, as (suffix, eye, aim, lens)."""
    scene = bpy.context.scene

    def clay(colour):
        mat = bpy.data.materials.new('clay')
        mat.use_nodes = True
        mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (*colour, 1)
        mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
        return mat

    plain = clay((0.72, 0.68, 0.62))
    for o in objs:
        o.hide_render = False
        if not o.data.materials:
            tint = next((c for key, c in TINTS.items() if key in o.name), None)
            o.data.materials.append(clay(tint) if tint else plain)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    for pos, energy in (((3.0, -2.0, 4.0), 900), ((-3.5, -3.0, 2.0), 250), ((-2.0, 3.5, 3.0), 500)):
        light = bpy.data.objects.new('key', bpy.data.lights.new('key', 'AREA'))
        light.data.energy = energy
        light.data.size = 2.5
        light.location = pos
        light.rotation_euler = (Vector((0, 0, 0.3)) - Vector(pos)).to_track_quat('-Z', 'Y').to_euler()
        scene.collection.objects.link(light)
    world = bpy.data.worlds.new('w')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.05, 0.05, 0.06, 1)
    scene.world = world
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 24
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 960
    scene.render.resolution_y = 600
    scene.render.image_settings.file_format = 'PNG'
    for suffix, e, a, l in (('', eye, aim, lens), *more):
        cam.data.lens = l
        cam.location = e
        cam.rotation_euler = (Vector(a) - Vector(e)).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(out, '..', '..', '.bake', f'cloth-{name}{suffix}.png')
        bpy.ops.render.render(write_still=True)
        print('preview', scene.render.filepath, flush=True)


def settle(scene, parts, frames, smooth=3, friction=60.0, thickness=0.004):
    """Runs a batch of cloth pieces (object, modifier) to rest, then freezes them into something the next batch
    can lie against. Pieces of one batch pass through each other; pieces of different batches do not."""
    scene.frame_set(1)
    scene.frame_start = 1
    scene.frame_end = frames
    for o, mod in parts:
        mod.point_cache.frame_start = 1
        mod.point_cache.frame_end = frames
    for f in range(1, frames + 1):
        scene.frame_set(f)
    for o, mod in parts:
        freeze(o, smooth=smooth)
        if smooth:
            bpy.ops.object.modifier_apply(modifier='Smooth')  # what later pieces touch is the shape that is drawn
        collide(o, friction, thickness)
    scene.frame_set(1)
    return [o for o, _ in parts]


def scans():
    """
    The two scanned throw pillows (Poly Haven, CC0; scripts/cloth.mjs fetches them), each turned into a standard
    pose whatever way it was photographed: width along X, thickness along Y, standing on Z = 0.
    """
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(WORK, 'throw_pillows_01', 'throw_pillows_01.gltf'))
    found = {}
    for o in sorted((o for o in bpy.data.objects if o not in before and o.type == 'MESH'), key=lambda o: o.name):
        me = o.data
        me.transform(o.matrix_world)
        o.parent = None
        o.matrix_world = Matrix.Identity(4)
        co = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get('co', co)
        co = co.reshape(-1, 3)
        centre = co.mean(axis=0)
        _, axes = np.linalg.eigh(np.cov((co - centre).T))  # least spread first: that is the way through the pillow
        n = axes[:, 0]
        # a square pillow has no long side to tell its top by: keep the way up it was scanned
        up = np.array([0.0, 0.0, 1.0]) - n[2] * n
        up /= np.linalg.norm(up)
        width = np.cross(n, up)
        local = (co - centre) @ np.stack([width, n, up], axis=1)
        local[:, 0] -= (local[:, 0].min() + local[:, 0].max()) / 2
        local[:, 1] -= (local[:, 1].min() + local[:, 1].max()) / 2
        local[:, 2] -= local[:, 2].min()
        me.vertices.foreach_set('co', local.ravel())
        me.update()
        o.hide_render = True
        found[o.name.split('_')[-1]] = o
        print(f'  scan {o.name}: {np.ptp(local[:, 0]):.2f} wide, {np.ptp(local[:, 1]):.2f} thick, {np.ptp(local[:, 2]):.2f} tall', flush=True)
    return found


def surroundings(objs):
    """Everything a rigid thing can come to rest against, as one tree (world space, as it will be drawn)."""
    verts, polys = [], []
    dg = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        base = len(verts)
        verts += [o.matrix_world @ v.co for v in me.vertices]
        polys += [tuple(base + i for i in p.vertices) for p in me.polygons]
        ev.to_mesh_clear()
    return BVHTree.FromPolygons(verts, polys)


def rest(name, scan, around, at, yaw=0.0, toward=-1, scale=1.0):
    """
    Stands a copy of a scanned pillow on whatever is under `at`, then tips it toward ∓Y, a little at a time, until
    it touches something: a rigid pillow leaning where a real one would. Nothing is ever pushed into anything.
    """
    o = scan.copy()
    o.data = scan.data.copy()
    o.name = name
    o.hide_render = False
    link(o)
    tree = surroundings(around)
    local = np.array([v.co[:] for v in o.data.vertices]) * scale
    low = local[:, 2] < 0.1 * scale       # the part that sits
    probe = local[::2]                    # every other vertex is plenty to feel for contact with

    def pose(theta, lift, shift):
        return Matrix.Translation((at[0], at[1] - toward * shift, at[2] + lift)) @ Matrix.Rotation(math.radians(yaw), 4, 'Z') @ Matrix.Rotation(-toward * math.radians(theta), 4, 'X')

    def seated(theta, shift):
        """the pose lowered until its underside touches what is below it"""
        M = pose(theta, 0.4, shift)
        gap = 1e9
        for p in local[low][::2]:
            w = M @ Vector(p)
            hit = tree.ray_cast(w, Vector((0, 0, -1)), 2.0)
            if hit[0] is not None:
                gap = min(gap, w.z - hit[0].z)
        return pose(theta, 0.4 - gap + 0.003, shift)

    def touching(M):
        for p in probe:
            w = M @ Vector(p)
            loc, normal, _, _ = tree.find_nearest(w, 0.1)
            if loc is not None and (w - loc).dot(normal) < -0.002 and abs(normal.z) < 0.8:  # (what it stands on does not count)
                return True
        return False

    theta, shift = 4.0, 0.0
    while touching(seated(theta, shift)) and shift < 0.3:   # no room to stand: start a little further out
        shift += 0.01
    while theta < 45 and not touching(seated(theta + 0.5, shift)):
        theta += 0.5
    M = seated(theta, shift)
    o.data.transform(M @ Matrix.Scale(scale, 4))
    o.data.update()
    print(f'  {name}: leans {theta:.1f}°, {shift * 100:.0f} cm out', flush=True)
    collide(o, 60, 0.004)
    return o


def plump(name, w, h, t, at, lean, yaw=0.0, toward=-1, n=0.02, corner=5.0):
    """
    A cushion made in its filled shape — fat in the middle, thinning to a seam all round, the corners taken off —
    and stood on its edge: the middle of that edge at `at`, tipped `lean` degrees toward ∓Y, turned `yaw` degrees.
    (A flat bag blown up has more cloth round its rim than a filled cushion has, and it shows: the edges buckle.
    Cut to the filled shape, the cloth has nowhere it needs to wrinkle; it only gives where something presses on it.)
    """
    nx = max(4, round(w / n))
    ny = max(4, round(h / n))
    cx, cy, cz = at
    a = math.radians(lean)
    yw = math.radians(yaw)

    def point(i, j, side):
        u, v = 2 * i / nx - 1, 2 * j / ny - 1
        x, y = u * w / 2, v * h / 2
        m = max(abs(u), abs(v))
        if m > 1e-6:
            k = m / (abs(u) ** corner + abs(v) ** corner) ** (1 / corner)
            x *= k
            y *= k
        z = side * 0.5 * t * ((1 - abs(u) ** 2.4) * (1 - abs(v) ** 2.4)) ** 0.55
        up = y + h / 2
        py = toward * up * math.sin(a) + z * math.cos(a)
        pz = up * math.cos(a) - toward * z * math.sin(a)
        return (cx + x * math.cos(yw) - py * math.sin(yw), cy + x * math.sin(yw) + py * math.cos(yw), cz + pz), (x + w / 2, up)

    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    rim = lambda i, j: i in (0, nx) or j in (0, ny)
    top = [[bm.verts.new(point(i, j, 1)[0]) for i in range(nx + 1)] for j in range(ny + 1)]
    bot = [[top[j][i] if rim(i, j) else bm.verts.new(point(i, j, -1)[0]) for i in range(nx + 1)] for j in range(ny + 1)]
    for sheet, flip in ((top, False), (bot, True)):
        for j in range(ny):
            for i in range(nx):
                quad = [(i, j), (i + 1, j), (i + 1, j + 1), (i, j + 1)]
                if flip:
                    quad.reverse()
                f = bm.faces.new([sheet[q][p] for p, q in quad])
                for loop, (p, q) in zip(f.loops, quad):
                    loop[uv].uv = point(p, q, 0)[1]  # metres: the fabric keeps its scale on every cushion
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def filled(o, firmness=15.0, mass=0.03, bending=40.0, gravity=0.6, gap=0.006, puff=0.0):
    """Stuffing for a cushion cut to shape. Springs run through it from one face to the other, as a filling does:
    it can be pressed in a little where something leans on it, and it cannot sag, dent or balloon."""
    mod = cloth(o, mass=mass, tension=60, bending=bending, quality=14, self_collide=False)
    s = mod.settings
    s.compression_stiffness = 30
    s.use_internal_springs = True
    s.internal_spring_max_length = 0.0
    s.internal_spring_max_diversion = math.radians(40)
    s.internal_spring_normal_check = True
    s.internal_tension_stiffness = firmness
    s.internal_compression_stiffness = firmness
    s.internal_tension_stiffness_max = firmness
    s.internal_compression_stiffness_max = firmness
    if puff:
        s.use_pressure = True
        s.uniform_pressure_force = puff
        s.pressure_factor = 1.0
    s.air_damping = 4.0
    s.effector_weights.gravity = gravity
    mod.collision_settings.distance_min = gap
    return mod


def stuffed(o, pressure, mass=0.15, tension=60, bending=0.4, gravity=0.3, gap=0.012):
    """Fills a box of fabric: air pressure stands in for the foam."""
    mod = cloth(o, mass=mass, tension=tension, bending=bending, quality=14, self_collide=False)
    mod.settings.compression_stiffness = tension * 0.3
    mod.settings.use_pressure = True
    mod.settings.uniform_pressure_force = pressure
    mod.settings.pressure_factor = 1.0
    mod.settings.air_damping = 4.0
    mod.settings.effector_weights.gravity = gravity
    mod.collision_settings.distance_min = gap
    return mod


def bed_colliders():
    # local frame: origin at the centre of the mattress top, head of the bed toward +Y
    box('mattress', (-1.06, -1.09, -0.26), (1.06, 1.09, 0.0))
    box('platform', (-1.28, -1.45, -0.46), (1.28, 1.19, -0.26))
    box('floor', (-4, -4, -0.9), (4, 4, -0.86))
    box('pillows', (-1.0, 0.5, 0.0), (1.0, 1.09, 0.2))


# ------------------------------------------------------------------ bed
def bed():
    """The duvet settles first; the throw is then laid across it, so it drapes over the real folds."""
    scene = reset()
    bed_colliders()
    # laid square: the same overhang on both sides, its head edge straight across below the pillows
    W, L = 2.5, 2.06
    o = grid('bed_duvet', W, L, 70, 58, lambda u, v: (-W / 2 + u * W, -1.56 + v * L, 0.07))
    mod = cloth(o, mass=0.5, tension=30, bending=14.0)
    run(scene, mod, 60)
    export(o, os.path.join(out, 'models', 'bed_duvet.glb'), thickness=0.06)

    # the duvet as it now lies (thickness applied) is what the throw rests on
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    for name in ('Smooth', 'Solidify'):
        bpy.ops.object.modifier_apply(modifier=name)
    collide(o, 40)
    for c in bpy.data.objects:
        if c.name == 'pillows':
            bpy.data.objects.remove(c)

    # a runner across the foot of the bed, hanging the same on both sides
    TW, TL = 2.86, 0.66
    t = grid('bed_throw', TW, TL, 96, 22, lambda u, v: (-TW / 2 + u * TW, -1.02 + v * TL, 0.22))
    mod = cloth(t, mass=0.35, tension=22, bending=2.0)
    scene.frame_set(1)
    run(scene, mod, 70)
    freeze(t, 0.018)
    write([t], os.path.join(out, 'models', 'bed_throw.glb'))

    # Two sleeping pillows stood against the headboard and let fall back onto it, and three scanned cushions leant
    # on them: every one rests on the mattress and on its neighbour, and none passes through another.
    head = box('headboard', (-1.95, 1.19, -0.56), (1.95, 1.41, 0.56), 60, 0.004)
    bpy.data.objects['mattress'].collision.thickness_outer = 0.004
    pillows = []

    def rank(specs, frames=80):
        parts = []
        for name, w, h, th, x, y, lean, yaw in specs:
            p = plump(name, w, h, th, (x, y, 0.03), lean, yaw, toward=1)
            parts.append((p, filled(p)))
        return settle(scene, parts, frames, smooth=14)

    pillows += rank([('pillow_white_0', 0.78, 0.54, 0.17, -0.5, 0.99, 10, 3), ('pillow_white_1', 0.78, 0.54, 0.17, 0.5, 0.99, 10, -3)])
    # in front of them, three scanned cushions: a pair leaning on the pillows and one between, leaning on the pair
    pillow = scans()
    lying = [o, bpy.data.objects['mattress']]
    for name, which, x, y, yaw, scale in (
        ('pillow_square_0', 'pillow02', -0.46, 0.8, 5, 1.0),
        ('pillow_square_1', 'pillow02', 0.46, 0.8, -6, 1.0),
        ('pillow_accent', 'pillow01', 0.02, 0.62, 4, 0.86),
    ):
        pillows.append(rest(name, pillow[which], pillows + lying, (x, y, 0.0), yaw, toward=1, scale=scale))
    write(pillows, os.path.join(out, 'models', 'bed_pillows.glb'), materials=True)
    preview(
        'bed',
        [o, t, head] + pillows + [c for c in bpy.data.objects if c.name in ('mattress', 'platform')],
        eye=(2.9, -3.6, 2.0),
        aim=(0, -0.3, 0),
        more=(('-pillows', (0.0, -1.3, 0.9), (0.0, 0.9, 0.2), 45), ('-side', (2.6, 0.75, 0.35), (0.0, 0.8, 0.2), 60)),
    )


# ------------------------------------------------------------------ sofa
def soft_box(name, size, at, n=0.03):
    """A fabric box, subdivided evenly. UVs are laid in metres before it is filled."""
    sx, sy, sz = size
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    bm = bmesh.new()
    bm.from_mesh(o.data)
    for axis, length in enumerate(size):
        along = [e for e in bm.edges if abs((e.verts[0].co - e.verts[1].co).normalized()[axis]) > 0.99]
        bmesh.ops.subdivide_edges(bm, edges=along, cuts=max(1, round(length / n) - 1), use_grid_fill=True)
    bm.to_mesh(o.data)
    bm.free()
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.cube_project(cube_size=1.0, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    return o


def sofa():
    """
    Local frame: X along the sofa, Y toward the room (the back is at −Y), Z up from the floor.
    Three seats, the one at −X running out into a chaise; a low arm at either end; a back cushion behind each seat;
    three scatter cushions. Every piece is fabric under pressure, and they are settled one after another, each
    against the frame and everything already in place — so cushions press on each other and never pass through.
    """
    scene = reset()
    SEAT = 0.2   # top of the frame
    frame = [
        box('frame', (-2.1, -0.62, 0.06), (2.1, 0.5, SEAT), 80, 0.004),
        box('frame_chaise', (-1.76, 0.5, 0.06), (-0.6, 1.5, SEAT), 80, 0.004),
        box('frame_back', (-2.1, -0.66, SEAT), (2.1, -0.5, 0.74), 80, 0.004),
    ]
    done = []

    def piece(name, size, at, pressure, tilt=0.0):
        o = soft_box(name, size, at)
        o.rotation_euler = (math.radians(tilt), 0, 0)
        bpy.ops.object.transform_apply(rotation=True)
        return o, stuffed(o, pressure, mass=0.15, tension=90, bending=5.0, gravity=0.6, gap=0.006)

    z = SEAT + 0.115
    done += settle(scene, [piece('sofa_seat_2', (1.14, 1.92, 0.2), (-1.17, 0.54, z), 1.7)], 40)
    done += settle(scene, [piece('sofa_seat_0', (1.14, 0.92, 0.2), (0.0, 0.04, z), 1.7)], 40)
    done += settle(scene, [piece('sofa_seat_1', (1.14, 0.92, 0.2), (1.17, 0.04, z), 1.7)], 40)
    done += settle(scene, [piece(f'sofa_arm_{i}', (0.27, 1.02, 0.34), (x, -0.01, SEAT + 0.185), 1.5) for i, x in enumerate((-1.925, 1.925))], 40)
    # the back cushions are dropped onto the rear of the seats and come to rest leaning on the frame
    for i, x in enumerate((-1.17, 0.0, 1.17)):
        done += settle(scene, [piece(f'sofa_back_{i}', (1.15, 0.2, 0.44), (x, -0.36, 0.8), 1.5, 3)], 55)
    # scatter cushions: real ones, scanned, stood on the seat and leant back until they touch
    pillow = scans()
    for name, which, x, yaw, scale in (
        ('sofa_cushion_a', 'pillow01', 1.42, -9, 1.0),
        ('sofa_cushion_b', 'pillow02', 0.9, 8, 0.94),
        ('sofa_cushion_c', 'pillow02', -1.22, -6, 1.0),
    ):
        done.append(rest(name, pillow[which], done + frame, (x, 0.0, 0.45), yaw, scale=scale))
    write(done, os.path.join(out, 'models', 'sofa.glb'), materials=True)
    for o in done:
        b = [o.matrix_world @ v.co for v in o.data.vertices]
        print(f'  {o.name:20s} x[{min(v.x for v in b):.2f},{max(v.x for v in b):.2f}] y[{min(v.y for v in b):.2f},{max(v.y for v in b):.2f}] z[{min(v.z for v in b):.2f},{max(v.z for v in b):.2f}]', flush=True)
    preview(
        'sofa',
        done + frame,
        eye=(-2.9, 3.6, 1.9),
        aim=(0, 0.2, 0.3),
        lens=40,
        more=(
            ('-left', (0.9, 1.5, 0.95), (1.2, -0.3, 0.6), 50),      # the pair at the end
            ('-right', (-0.9, 1.5, 0.95), (-1.2, -0.3, 0.6), 50),   # the one on the chaise
            ('-side', (2.9, 0.1, 0.75), (0.0, -0.1, 0.6), 60),      # along the seat: who touches whom
            ('-joint', (0.6, 0.5, 0.75), (0.6, -0.4, 0.45), 85),    # where two back cushions meet the seat
        ),
    )


# ------------------------------------------------------------------ drape
def drape():
    """A heavy linen curtain, gathered on its rail, hanging still."""
    scene = reset()
    W, H = 1.12, 3.0
    NX, NY = 64, 76
    FULLNESS = 1.8
    PLEATS = 8
    amp = math.sqrt(FULLNESS ** 2 - 1) * W / (PLEATS * math.pi * 2)
    o = grid('drape', W, H, NX, NY, lambda u, v: ((u - 0.5) * W, amp * math.sin(u * PLEATS * 2 * math.pi), H * (1 - v)))
    pin = o.vertex_groups.new(name='pin')
    pin.add(list(range(NX + 1)), 1.0, 'REPLACE')
    mod = cloth(o, mass=0.3, tension=14, bending=0.6, pin='pin', quality=8, self_collide=False)
    mod.settings.air_damping = 2.5
    box('floor', (-2, -1, -0.1), (2, 1, 0.0), friction=5)
    run(scene, mod, 50)
    freeze(o, 0.0, 0, 3)
    write([o], os.path.join(out, 'models', 'drape.glb'))
    preview('drape', [o], eye=(1.6, -4.2, 1.6), aim=(0, 0, 1.5), lens=40)


# ------------------------------------------------------------------ curtain
def curtain():
    scene = reset()
    W, H = 1.25, 3.02          # width along the rail, drop
    NX, NY = 40, 60
    FULLNESS = 1.55            # metres of cloth per metre of rail
    PLEATS = 9
    # local frame: X along the rail, Y into the room, Z up from the floor; the glass is just behind, at Y = -0.3
    amp = math.sqrt(FULLNESS ** 2 - 1) * W / (PLEATS * math.pi * 2) * 1.05

    def place(u, v):
        z = H * (1 - v)  # v = 0 at the rail
        return (u * W, amp * math.sin(u * PLEATS * 2 * math.pi), z)

    o = grid('curtain', W, H, NX, NY, place)
    pin = o.vertex_groups.new(name='pin')
    pin.add([i for i in range(NX + 1)], 1.0, 'REPLACE')  # the first row hangs from the rail
    mod = cloth(o, mass=0.12, tension=8, bending=0.08, pin='pin', quality=8, self_collide=False)
    mod.settings.air_damping = 2.0

    box('glass', (-3, -0.33, -0.2), (4, -0.3, 3.4), friction=2)
    box('floor', (-3, -1, -0.1), (4, 3, 0.0), friction=5)

    # the draught: comes in through the door (to the -X side of the curtain) and pushes into the room
    bpy.ops.object.effector_add(type='WIND', location=(-1.2, -1.5, 1.4), rotation=(math.radians(-90), 0, math.radians(-22)))
    wind = bpy.context.active_object
    wind.field.flow = 0.6
    wind.field.noise = 1.2
    wind.field.seed = 4
    for frame, strength in ((1, 0), (24, 0), (48, 260), (80, 330), (120, 240), (160, 300)):
        wind.field.strength = strength
        wind.field.keyframe_insert('strength', frame=frame)
    bpy.ops.object.effector_add(type='TURBULENCE', location=(0.6, 0.4, 1.4))
    turb = bpy.context.active_object
    turb.field.size = 0.9
    turb.field.flow = 0.4
    for frame, strength in ((1, 0), (30, 0), (60, 14), (160, 14)):
        turb.field.strength = strength
        turb.field.keyframe_insert('strength', frame=frame)

    FIRST, LAST, STEP = 18, 160, 3
    frames = []

    def grab(f):
        if f >= FIRST and (f - FIRST) % STEP == 0:
            ev = o.evaluated_get(bpy.context.evaluated_depsgraph_get())
            co = np.empty(len(ev.data.vertices) * 3, dtype=np.float32)
            ev.data.vertices.foreach_get('co', co)
            frames.append(co.copy())

    run(scene, mod, LAST, grab)
    data = np.stack(frames)  # frames × (verts × 3), metres
    # millimetres in 16 bits is plenty for cloth
    np.round(data * 1000).astype(np.int16).tofile(os.path.join(out, 'cloth', 'curtain.bin'))
    meta = {'cols': NX + 1, 'rows': NY + 1, 'frames': len(frames), 'width': W, 'height': H, 'scale': 0.001}
    json.dump(meta, open(os.path.join(out, 'cloth', 'curtain.json'), 'w'))
    reach = data.reshape(len(frames), -1, 3)[:, :, 1]
    print('curtain', meta, f'reach into room: rest {reach[0].max():.2f} m, peak {reach.max():.2f} m', flush=True)


for job in jobs:
    {'bed': bed, 'sofa': sofa, 'drape': drape, 'curtain': curtain}[job]()
