/**
 * The sheets pinned over the desk. Each print on the board stands for one piece of work: choose it and the camera
 * goes up to the sheet while its note opens beside it.
 *
 * As shipped they tell how this house was made, which is the one piece of work the site can speak for by itself.
 * Replace them with your own projects: a title, a line of context, a paragraph, and where to read more. `print`
 * says which sheet on the board the work hangs on (see `pin` in src/scene/interior.ts for the seven of them).
 */
export interface Work {
  id: string;
  print: 'carta' | 'rotonda' | 'rain' | 'heavens' | 'wave' | 'medusae' | 'loon';
  title: string;
  /** a line of context: year, role, client */
  meta: string;
  body: string;
  /** where to read more; left out, the note has no link */
  link?: { label: string; href: string };
}

export const works: Work[] = [
  {
    id: 'light',
    print: 'rotonda',
    title: 'Light, baked',
    meta: 'Vesper · Blender, Cycles',
    body: 'Nothing indoors is lit live. Every lamp in the house exists only in a path-traced bake, kept in three layers — lamps, fire, sky — and mixed on the GPU as the evening goes, so dusk, night and dawn share one calculation and cost nothing to draw.',
  },
  {
    id: 'sky',
    print: 'heavens',
    title: 'A sky from data',
    meta: 'Vesper · Yale BSC5, NASA SVS',
    body: 'The air is a scattering model rendered for eleven heights of the sun. Over it stand the nine thousand stars of the Yale Bright Star Catalogue, each in its true place, brightness and colour, and NASA’s map of the Milky Way. The telescope by the window reads the same catalogue.',
  },
  {
    id: 'water',
    print: 'wave',
    title: 'Water that keeps still',
    meta: 'Vesper · three.js',
    body: 'The lake is a planar reflection bent by wave tiles from an ocean simulation, laid over themselves at four scales so no pattern repeats. Thin bright things shimmer when a camera moves; most of the work was making sure these do not.',
  },
  {
    id: 'walk',
    print: 'carta',
    title: 'A walk, not a scroll',
    meta: 'Vesper · interaction',
    body: 'The film carries the visitor to the door and no further. Inside, every choice hangs in the room over the thing it leads to, and the camera is steered as a walker is: a path for the feet, a heading for the head, and time for every turn.',
  },
  {
    id: 'found',
    print: 'medusae',
    title: 'Found, not modelled',
    meta: 'Vesper · Poly Haven, Sketchfab, Commons',
    body: 'Almost nothing here was drawn by hand. Furniture, books, carpets and cushions are scans; the clouds were cut out of a photograph of a real sky; the paintings, prints and recordings are in the public domain or free to share. The craft is in the fitting.',
  },
  {
    id: 'forest',
    print: 'loon',
    title: 'A forest of two trees',
    meta: 'Vesper · Blender, GLSL',
    body: 'Two spruce were grown from photographed twigs. The few by the house are those meshes; the other 3,600 are single quads showing a photograph of the same tree from wherever the camera stands. All of them sway in one wind.',
  },
];
