# Builds the sky.   blender -b --python scripts/sky.py -- <workdir> <outdir>
#
# Nothing here is a photograph of a sky. Three things are put together, each from its own source:
#
#   twilight.bin   the air itself. Blender's multiple-scattering atmosphere, rendered for a ladder of sun elevations
#                  from deep night to just after sunrise. The page slides along the ladder as the film runs, so the
#                  light goes down and comes up the way it does outside.            (half floats, W × H × N, RGBA)
#   stars.bin      the 9 110 stars of the Yale Bright Star Catalogue at their true places, brightnesses and colours,
#                  and behind them a dust of fainter ones scattered the way the Milky Way is.      (6 bytes a star)
#   milkyway.raw   the glow of the galaxy, from NASA's Deep Star Maps 2020 (Gaia DR2).   (8-bit sRGB, for sharp)
#
# Reads <workdir>/bsc5.dat and <workdir>/milkyway_2020_4k.exr (scripts/sky.mjs fetches both).
import bpy, json, math, os, sys
import numpy as np

work, out = sys.argv[sys.argv.index('--') + 1:][:2]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(7)

# ------------------------------------------------------------------ the air
ELEVATIONS = [-16, -11, -8, -6, -4.5, -3, -1.5, 0, 1.5, 3, 5]  # degrees: where the sun is, for each layer
W, H = 96, 48  # half the compass (the sky is the same either side of the sun) × horizon to zenith

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.cycles.device = 'CPU'
world = bpy.data.worlds.new('sky')
world.use_nodes = True
scene.world = world
nt = world.node_tree
sky = nt.nodes.new('ShaderNodeTexSky')
sky.sky_type = 'MULTIPLE_SCATTERING'
sky.sun_disc = False  # the page draws the disc itself, so it stays sharp
sky.altitude = 600  # a mountain lake
sky.air_density = 1.0
sky.aerosol_density = 0.55  # clean air
sky.ozone_density = 1.2
nt.links.new(sky.outputs['Color'], nt.nodes['Background'].inputs['Color'])
cam = bpy.data.cameras.new('pano')
cam.type = 'PANO'
cam.panorama_type = 'EQUIRECTANGULAR'
eye = bpy.data.objects.new('pano', cam)
scene.collection.objects.link(eye)
scene.camera = eye
eye.rotation_euler = (math.pi / 2, 0, 0)
RW, RH = 720, 360
scene.render.resolution_x = RW
scene.render.resolution_y = RH
scene.render.image_settings.file_format = 'OPEN_EXR'
scene.render.image_settings.color_depth = '32'
scene.view_settings.view_transform = 'Raw'

layers = []
for el in ELEVATIONS:
    sky.sun_elevation = math.radians(el)
    sky.sun_rotation = 0
    scene.render.filepath = os.path.join(work, 'twilight.exr')
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(scene.render.filepath)
    px = np.empty(RW * RH * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    px = px.reshape(RH, RW, 4)[RH // 2:, :, :3]  # the dome: row 0 is the horizon
    # put the sun's side of the sky at column 0
    glow = px[: RH // 8].sum(axis=(0, 2))
    px = np.roll(px, -int(np.argmax(np.convolve(np.concatenate([glow, glow]), np.ones(31), 'same')[RW // 2: RW // 2 + RW]) + RW // 2) % RW, axis=1)
    # fold the two halves together and resample: columns are 0..180° from the sun, rows run as sqrt(elevation)
    folded = 0.5 * (px + np.roll(px[:, ::-1], 1, axis=1))
    layer = np.empty((H, W, 3), dtype=np.float32)
    for j in range(H):
        e = (j / (H - 1)) ** 2 * (RH // 2 - 1)
        e0 = int(e)
        e1 = min(e0 + 1, RH // 2 - 1)
        row = folded[e0] * (1 - (e - e0)) + folded[e1] * (e - e0)
        for i in range(W):
            a = i / (W - 1) * (RW / 2)
            a0 = int(a)
            a1 = min(a0 + 1, RW - 1)
            layer[j, i] = row[a0] * (1 - (a - a0)) + row[a1] * (a - a0)
    layers.append(layer)
    print(f'sun {el:+.1f}°  zenith {layer[-1, 0]}  horizon toward the sun {layer[1, 0]}  away {layer[1, -1]}', flush=True)

atlas = np.stack(layers)  # N × H × W × 3
rgba = np.ones((len(ELEVATIONS), H, W, 4), dtype=np.float16)
rgba[..., :3] = np.minimum(atlas, 60000).astype(np.float16)
rgba.tofile(os.path.join(out, 'twilight.bin'))

# ------------------------------------------------------------------ the galaxy
img = bpy.data.images.load(os.path.join(work, 'milkyway_2020_4k.exr'))
mw_w, mw_h = img.size
mw = np.empty(mw_w * mw_h * 4, dtype=np.float32)
img.pixels.foreach_get(mw)
mw = mw.reshape(mw_h, mw_w, 4)[::-1, :, :3]  # top row first
bpy.data.images.remove(img)
MW, MH = 2048, 1024
small = mw.reshape(MH, mw_h // MH, MW, mw_w // MW, 3).mean(axis=(1, 3))
(np.clip(small, 0, 1) ** (1 / 2.2) * 255 + 0.5).astype(np.uint8).tofile(os.path.join(work, 'milkyway.raw'))

# where the map puts a known place: the galactic centre, the brightest part of the sky
lum = small.mean(axis=2)
blur = lum.reshape(MH // 16, 16, MW // 16, 16).mean(axis=(1, 3))
gy, gx = np.unravel_index(np.argmax(blur), blur.shape)
print(f'brightest part of the map: u {(gx + 0.5) / blur.shape[1]:.3f}  v(from top) {(gy + 0.5) / blur.shape[0]:.3f}   (the galactic centre is at RA 266.4°, Dec -28.9°)', flush=True)

# ------------------------------------------------------------------ the stars
ra, dec, mag, bv = [], [], [], []
for line in open(os.path.join(work, 'bsc5.dat'), encoding='latin-1'):
    try:
        a = (int(line[75:77]) + int(line[77:79]) / 60 + float(line[79:83]) / 3600) * 15
        d = (int(line[84:86]) + int(line[86:88]) / 60 + int(line[88:90]) / 3600) * (-1 if line[83] == '-' else 1)
        m = float(line[102:107])
    except ValueError:
        continue  # a handful of entries are novae and clusters with no place of their own
    try:
        c = float(line[109:114])
    except ValueError:
        c = 0.6
    ra.append(a)
    dec.append(d)
    mag.append(m)
    bv.append(c)
real = len(ra)

# Fainter than the eye can pick out one by one, but a dark sky is full of them: three times as many again for
# every magnitude deeper. They follow the galaxy's own light, so they thicken into the band exactly where it glows.
FAINT = 26000
weight = (lum ** 0.8 + 0.006) * np.cos((np.arange(MH) + 0.5) / MH * math.pi - math.pi / 2)[:, None]
pick = rng.choice(MW * MH, size=FAINT, p=(weight / weight.sum()).ravel())
py, pxl = np.divmod(pick, MW)
u = (pxl + rng.random(FAINT)) / MW
v = (py + rng.random(FAINT)) / MH
# the map: RA increases to the left, 0h in the middle; north at the top
ra += list(((0.5 - u) * 360) % 360)
dec += list(90 - v * 180)
# magnitudes 6.5 → 9, crowding toward the faint end as the real sky does
mag += list(6.5 + 2.5 * np.log10(1 + rng.random(FAINT) * (10 ** 1.0 - 1)))
bv += list(rng.normal(0.65, 0.35, FAINT))

n = len(ra)
packed = np.zeros(n, dtype=[('ra', '<u2'), ('dec', '<u2'), ('mag', 'u1'), ('bv', 'u1')])
packed['ra'] = np.round(np.array(ra) / 360 * 65535)
packed['dec'] = np.round((np.array(dec) + 90) / 180 * 65535)
packed['mag'] = np.clip(np.round((np.array(mag) + 2) / 12 * 255), 0, 255)
packed['bv'] = np.clip(np.round((np.array(bv) + 0.4) / 2.4 * 255), 0, 255)
packed.tofile(os.path.join(out, 'stars.bin'))
print(f'stars: {real} catalogued + {FAINT} faint', flush=True)

json.dump({'elevations': ELEVATIONS, 'size': [W, H, len(ELEVATIONS)], 'milkyway': [MW, MH], 'stars': n}, open(os.path.join(work, 'sky.json'), 'w'))
