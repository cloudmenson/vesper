# Makes the far landscape in Blender.   blender -b --python scripts/landscape.py -- <workdir> <assets>
#
#   water      two tiles of wave heights from Blender's ocean simulation (a broad swell and a fine chop);
#              scripts/landscape.mjs turns them into the normal maps the lake is shaded with      → <workdir>/wave_*.bin
#   mountains  the range around the lake as real terrain: ridged fractal relief on a ring of ground,
#              opened toward the lake and toward the valley the sun sets in                         → <assets>/models/mountains.glb
import bpy, bmesh, math, os, sys
import numpy as np
from mathutils import Vector, noise

work, assets = sys.argv[sys.argv.index('--') + 1:][:2]


def waves(name, size, wind, scale, seed, time):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_plane_add(size=2)
    o = bpy.context.active_object
    mod = o.modifiers.new('Ocean', 'OCEAN')
    mod.geometry_mode = 'GENERATE'
    mod.resolution = 16
    mod.viewport_resolution = 16
    mod.spatial_size = size
    mod.wind_velocity = wind
    mod.wave_scale = scale
    mod.wave_scale_min = 0.01
    mod.choppiness = 0.0
    mod.wave_alignment = 0.15
    mod.damping = 0.6
    mod.depth = 40
    mod.random_seed = seed
    mod.time = time
    dg = bpy.context.evaluated_depsgraph_get()
    me = o.evaluated_get(dg).to_mesh()
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get('co', co)
    co = co.reshape(-1, 3)
    n = int(round(math.sqrt(len(co))))
    order = np.lexsort((co[:, 0], co[:, 1]))  # rows of constant y, x ascending
    h = co[order, 2].reshape(n, n)[:-1, :-1]  # the simulation repeats: drop the duplicated edge
    h.astype(np.float32).tofile(os.path.join(work, f'wave_{name}.bin'))
    print(f'waves {name}: {h.shape[0]}² over {size} m, height ±{np.abs(h).max():.3f} m', flush=True)


def mountains():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    SEG, RINGS = 900, 120
    R0, R1 = 330.0, 2600.0
    dusk = math.atan2(1.0, -0.16)   # Blender (x, y) of the site's sunset direction (−0.16, ·, −1) → (−0.16, +1)
    lake = math.atan2(-1.0, 0.0)    # the lake lies toward the site's +Z, Blender's −Y

    def gap(a, centre, width):
        d = abs((a - centre + math.pi) % (2 * math.pi) - math.pi)
        return math.exp(-(d / width) ** 2)

    def step(x, lo, hi):
        t = min(1.0, max(0.0, (x - lo) / (hi - lo)))
        return t * t * (3 - 2 * t)

    def height(x, y):
        r = math.hypot(x, y)
        a = math.atan2(y, x)
        q = Vector((x, y, 0.0))
        p = q * 0.00105
        p = p + noise.noise_vector(p * 0.8) * 0.4 + noise.noise_vector(p * 3.1) * 0.07  # bend the ridges so none runs straight
        ridge = noise.ridged_multi_fractal(p, 1.0, 2.15, 7, 1.0, 2.0)
        spurs = noise.ridged_multi_fractal(p * 3.3 + Vector((7.1, 2.3, 0.0)), 1.0, 2.2, 5, 1.0, 2.0)  # the buttresses that run down from a ridge
        detail = noise.fractal(p * 9.0, 1.0, 2.0, 4)
        rise = min(1.0, max(0.0, (r - R0) / 520.0)) ** 1.25              # foothills first
        far = 1.0 + 0.75 * step(r, 900.0, 1900.0)                        # the back ranges stand taller
        # The lake runs out through a clear gap; a long way off, a low far shore closes the horizon.
        across = gap(a, lake, 0.5) * (1.0 if r < 1250.0 else 0.6)
        # The valley the sun sets in is a pass, not a slot: it winds, narrows as it climbs, and ends against a far range,
        # so the eye goes up it past spur after spur instead of out through a hole.
        wind = noise.noise(Vector((r * 0.0021, 3.7, 0.0))) * 0.2 + noise.noise(Vector((r * 0.0057, 9.1, 0.0))) * 0.07
        valley = gap(a + wind, dusk, 0.2 - 0.07 * step(r, 500.0, 1500.0)) * (1.0 - 0.72 * step(r, 1250.0, 1900.0))
        openings = (1 - across) * (1 - 0.86 * valley)
        # the big shapes sink into the pass; the small ones do not, so its floor and flanks stay broken ground
        h = ridge ** 1.22 * 118.0 * rise * far * openings
        h += (spurs ** 1.6 * 34.0 + detail * 9.0) * rise * (0.3 + 0.7 * far * 0.5) * (0.4 + 0.6 * openings) * (1 - across)
        h -= 6.0
        # nothing may hover at the waterline: what is not clearly land goes well under
        return h if h > 5.0 else h - (5.0 - h) * 2.5

    bm = bmesh.new()
    rows = []
    for j in range(RINGS + 1):
        t = j / RINGS
        r = R0 * (R1 / R0) ** t  # rings bunch up near the lake, where the relief is seen closest
        rows.append([bm.verts.new((r * math.cos(a), r * math.sin(a), height(r * math.cos(a), r * math.sin(a)))) for a in (i * 2 * math.pi / SEG for i in range(SEG))])
    for j in range(RINGS):
        for i in range(SEG):
            k = (i + 1) % SEG
            bm.faces.new((rows[j][i], rows[j + 1][i], rows[j + 1][k], rows[j][k]))  # wound to face the sky
    me = bpy.data.meshes.new('mountains')
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    o = bpy.data.objects.new('mountains', me)
    bpy.context.scene.collection.objects.link(o)
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    out = os.path.join(assets, 'models', 'mountains.glb')
    bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', use_selection=True, export_materials='NONE', export_yup=True)
    zs = [v.co.z for v in me.vertices]
    print(f'mountains: {len(me.vertices)} vertices, peaks to {max(zs):.0f} m, wrote {os.path.getsize(out) / 1024:.0f} KB', flush=True)


waves('a', 24, 4.0, 0.5, 2, 3.0)   # the swell
waves('b', 6, 2.5, 0.25, 9, 1.0)   # the chop
mountains()
