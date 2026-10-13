# Vesper

A film you scroll, around a house you walk. The scroll carries the camera in over the water at dusk and through the sliding glass; indoors it stops, and the visitor chooses where to go — sit by the fire, look at the picture, walk through to the kitchen, out to the fire bowl on the terrace, up to the loft with its desk, its shelves and its bed. Opening the skylight hands the camera back to the film: out under the Milky Way, round the shore at sunrise, and back to where it began.

Three.js, TypeScript and Vite on the page; Blender (driven headless, by script) behind it for everything that has to be computed rather than drawn: bounced light, cloth and upholstery, trees, mountains, waves, the sky.

```
npm install
npm run dev        # http://localhost:5173
npm run build      # type-check and bundle to dist/
```

## How it works

- **One number drives everything.** Scroll position becomes a progress value 0–1 (`src/scene/experience.ts`). The camera path, time of day, the door and skylight, the curtain, the lamps and the sound mix are all functions of it, so scrolling back plays the film in reverse.
- **The walk** — between the door (0.345) and the skylight (0.862) the scroll is parked and `src/tour.ts` takes the camera. Each stop is a pose and a moment of the film (`at`), so walking deeper into the house still walks into the night; the ways between stops are short curves routed round the furniture — a path for the feet and, separately, a heading and a tilt for the head, with time shared out so that a turn is taken slowly — and the two exits (down to the pier, up through the skylight) end exactly on the film's own camera, so the hand-back cannot be seen. The choices are not a list: each is a plate fixed in the house, in the air over the place it leads to — over the bed, over the monitor, at the top of the picture — and stays there as the view moves, like a thing in the room (`ui.ts` projects them every frame). A place that is out of sight has its plate wait in a column at that side of the screen, with an arrow, and glide out to the place when the head turns far enough to see it. So that a plate can be caught, the head stops turning as the pointer closes on one. Some plates are things to do rather than places to go: put a log on the fire, a record on the player (the platter turns, the arm swings in, the music changes), call the rain onto the skylight, look through the telescope, read one of the sheets on the board. Standing still, the mouse turns the head. Stops, their captions and the choices are copy, in `src/content.ts`.
- **Camera** — keyframes in `src/scene/camera.ts`, joined by monotone cubic curves so the move never overshoots into a wall.
- **House** — the building is described in code as boxes by their extents (`house.ts`, `interior.ts`) and merged into one mesh per material and room by `builder.ts`, which also unwraps every piece into a shared lightmap atlas. What stands in it is found, not modelled: scanned furniture, lamps, books, carpets and cushions (see Assets), with bed linen and curtains simulated in Blender.
- **Light** — nothing indoors is lit live. Cycles bakes it (`scripts/bake.mjs` → `bake.py`) in three layers — *lamps*, *fire*, *sky* — into the atlas for the building, and into the vertices of every loose object, so a cushion sits in the room's light and shadow exactly as the wall behind it does. The layers are mixed on the GPU as the lamps dim, the fire breathes and the sky changes colour, so dusk, night and dawn share one bake (`lightmap.ts`). Each room also gets a cube map shot from its middle, which its surfaces keep for good: stone and metal reflect the room they are in.
- **Cloth** — the sofa's seats and backs are boxes of fabric inflated and settled on its frame; the duvet and runner are laid on the bed and left to settle; curtains hang from their rails. The throw cushions are scans, each leant by the script against whatever is behind it until it touches. The sheer by the door keeps all 48 frames of its simulation in a texture array, and the vertex shader scrubs through them as the door opens (`scripts/cloth.py`, `cloth.ts`).
- **Forest** — two spruce are grown in Blender from photographed fir twigs (`scripts/trees.py`). The trees nearest the house are those meshes; the other 3,600 are impostors — one quad each, showing a photograph of the same mesh from whichever of 24 directions is closest, with normals to light it by (`landscape.ts`). All of them sway: a bend from the foot, most at the top, in the vertex shader that meshes and impostors share, with gusts crossing the forest as slow waves; the sound of the wind rises and falls with the same gusts.
- **Mountains, water** — the range is ridged terrain raised in Blender, with a winding pass where the sun sets. The lake is a planar reflection (multisampled, blurred through its mips where the water is rough) bent by wave tiles from Blender's ocean simulation, laid over themselves at four scales and headings and ruffled in drifting patches; in the shallows it thins and the bed shows through (`scripts/landscape.py`, `landscape.ts`).
- **Sky** — assembled, not photographed (`scripts/sky.mjs` → `sky.py`). The air is Blender's multiple-scattering atmosphere rendered for a ladder of sun elevations, which the film slides along; the stars are the 9,096 of the Yale Bright Star Catalogue at their true places, brightnesses and colours, over NASA's map of the Milky Way's light. Fog and mountain haze are read from the same data, so far things fade into the sky that is actually behind them (`atmosphere.ts`). The clouds are real cumulus, cut out of a photographed sky (`scripts/clouds.mjs`: where the picture is blue there is sky, where it is white there is cloud) and lit again by this sky at this hour.
- **Fire** — a scanned pile of logs on a bed of embers, with a 64-frame loop of a real flame on cards that turn to face the camera; its light is the baked *fire* layer, flickering. Indoors it burns behind ceramic glass; outdoors in an iron bowl, with sparks. By morning both have burnt out, and the bowl is left smoking.
- **Steadiness** — thin bright things shimmer when a camera moves, so the pipeline is built not to: bloom is a 13-tap pyramid that weighs down single hot pixels (`bloom.ts`), stars are soft dots that slide between pixels, shadows are drawn once per light direction. `node scripts/flicker.mjs <dir> 0.2: 0.86:` measures what is left, frame against frame.
- **The telescope** — at the window of the loft. Through it the same catalogue of stars is seen closer, with the figures of the constellations drawn over them and the bright stars named (`createChart` in `landscape.ts`, names set by `ui.ts`); the pointer sweeps the tube across the sky.
- **Weather and wildlife** — in the small hours the northern lights hang over the lake (a shader on its own dome; the house stands at 61° N). Rain, when the visitor calls it, closes the cloud, falls everywhere but under a roof, and rings on the skylight. A cat sleeps in its basket and is found somewhere else whenever one has been away on the other floor; a stag comes down to the west shore at first light; a fish rises off the pier now and then.
- **The board** — the prints over the desk stand for pieces of work (`src/works.ts`): choosing one takes the camera up to the sheet and opens its note. As shipped the notes tell how this house was made; they are meant to be replaced with the owner's own projects.
- **Sound** — field recordings mixed by where the camera is, over Satie's first Gymnopédie (`src/audio.ts`).

Copy lives in `src/content.ts`.

## Rebuilding what Blender makes

Needs Blender 4.2+ (written against 5.2), and the dev server running for the light bake.

```
npm run blender:light       # ~13 min on an M1 Pro: export → bake 3 layers, atlas and vertices → denoise → encode
npm run blender:cloth       # sofa cushions, pillows, bed linen, drapes and the door curtain
npm run blender:sky         # atmosphere ladder, star catalogue, Milky Way, clouds
npm run assets:books        # the book set, re-packed: one atlas of covers, each volume its own object
npm run blender:trees       # grow two spruce, photograph them, pack the impostor atlases
npm run blender:landscape   # mountains and wave tiles
```

**Re-run `blender:light` after changing anything in the house** — geometry, furniture, lamps. The lightmap atlas is laid out from the geometry and the vertex light is stored per vertex, so a stale bake would land on the wrong surfaces; the page notices a mismatch, says so in the console and falls back to flat light for loose objects. `?off=bake` shows the house without the bake.

## Performance

The renderer shades a fixed pixel budget rather than the display's full resolution, and drops resolution further if the frame rate falls. `node scripts/profile.mjs 0 0.2 0.45 0.8 1` prints the GPU frame cost at those scroll positions (dev server must be running).

`?p=0.42` pins the film to one frame; `?p=0.42&cam=x,y,z,tx,ty,tz` parks the camera anywhere; `?stop=fire` pins one stop of the walk.

Checks, all against a running dev server (`VESPER_URL=http://localhost:5173` by default): `scripts/audit.mjs` shoots a close-up of every object in the house, `scripts/tour.mjs` walks every stop and both exits, `scripts/flow.mjs` goes through the loader as a visitor does, `scripts/flicker.mjs` measures shimmer.

## Assets

`npm run assets` downloads and compresses everything third-party in `public/assets` (needs `ffmpeg`).

- Textures, most models (furniture, the book set, the throw cushions), fir twigs, the radiance map for reflections, the sky the clouds are cut from (*Kloofendal 48d Partly Cloudy*) — [Poly Haven](https://polyhaven.com), CC0
- Models under CC BY 4.0, from Sketchfab (fetched through the [Objaverse](https://objaverse.allenai.org) mirror) and Khronos:
  - table lamps — *Iridescence Lamp*, © 2022 Wayfair, [glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
  - computer — *Nzxt PC* by umkhero; keyboard — *Logitech mechanical gaming keyboard* by blackcube4; mouse — *Computer Mouse* by PoneMyintMyat
  - bedside tables — *nightstand* by fenik0; side tables — *Tucson Side Table A* by cc0archviz, *Side Table* by trijoko.maryadi
  - carpets — *Carpet* by nocyde
  - the loft's sofa, armchair and glass table — *The Sofa, The Chair and the Table* by isaackgamma; floor lamp — *Wooden floor lamp* by DuduPav; ficus — *Ficus* by gilles.schaeck
  - record player — *Yamaha TT-300 Record Player* by AleixoAlonso; telescope — *Telescope* by topfrank2013
  - the cat — *Sleeping cat* by Smart3DScan; the stag — *Deer* by aeonfitzgerald
  - fire bowl — *Brazier Bowl* by JDegville; burning logs — *Campfire Wood Survival Warm and Light* by digrafstudio
- Prints over the desk — Hokusai, Hiroshige, Haeckel, Audubon, Olaus Magnus, de Wit, Palladio; paintings in the frames — Friedrich, Balke, Bierstadt, Shishkin, Hammershøi, Monet, Sohlberg: all public domain, from Wikimedia Commons
- On the monitor — *Perpetual Ocean*, NASA/Goddard Scientific Visualization Studio (public domain). Sitting at the desk, the visitor sees instead the film named in `site.screenVideo` (`src/content.ts`), played over the monitor by YouTube's own embedded player: nothing of it is copied into the site, and whether it may be embedded is the uploader's setting
- Stars — Yale Bright Star Catalogue, 5th ed. (public domain); Milky Way — NASA/Goddard SVS, *Deep Star Maps 2020*
- The framed picture over the sideboard (`public/assets/tex/painting.webp`) is the owner's own file, not a free-licence asset: swap it before publishing if that matters
- Constellation figures and star names — [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn, BSD 3-Clause
- Field recordings (lake, night, wind, fire, dawn, rain, footsteps, a fish rising, a needle on vinyl) — [Freesound](https://freesound.org), CC0
- Flame footage — Wikimedia Commons, CC0
- Music — Erik Satie, *Gymnopédie No. 1*, performed by Robin Alciatore ([Musopen](https://musopen.org), public domain); on the record player, Satie's *Gnossienne No. 1*, performed by La Pianista (Wikimedia Commons, public domain)
