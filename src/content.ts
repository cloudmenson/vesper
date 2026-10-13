/** All copy lives here. Swap the author block for your own details. */
import { works } from './works';

export const site = {
  /** the film on the loft's monitor, by its YouTube id: played there by YouTube's own player while one sits at the desk */
  screenVideo: '9AOmAa96Fb4',
  name: 'Vesper',
  kicker: 'A residence on still water',
  tagline: 'A house for the blue hour.',
  coords: '61.38° N · 6.12° E',
  author: 'Your Name',
  authorUrl: 'https://your-portfolio.com',
  email: 'hello@your-portfolio.com',
};

export interface Chapter {
  id: string;
  label: string;
  title: string[];
  body: string;
  /** scroll progress window in which the chapter is on screen */
  at: [number, number];
  align: 'left' | 'right';
}

export const chapters: Chapter[] = [
  {
    id: 'arrival',
    label: 'Arrival',
    title: ['You arrive', 'by water.'],
    body: 'No road reaches Vesper. The last forty metres are a cedar pier, lit low enough that the lake stays dark.',
    at: [0.095, 0.185],
    align: 'left',
  },
  {
    id: 'threshold',
    label: 'Threshold',
    title: ['The wall', 'steps aside.'],
    body: 'Three metres of glass slide into the frame without a sound. Inside and outside stop being different rooms.',
    at: [0.232, 0.298],
    align: 'left',
  },
  {
    id: 'living',
    label: 'The long room',
    title: ['Built around', 'one sofa.'],
    body: 'Everything on this floor faces the same way — toward the fire and, past it, the water.',
    at: [0.365, 0.485],
    align: 'left',
  },
  {
    id: 'table',
    label: 'Table',
    title: ['Stone, oak,', 'a low light.'],
    body: 'A three-metre island under a single slab of stone. Dinner for six beneath one line of brass.',
    at: [0.535, 0.602],
    align: 'right',
  },
  {
    id: 'ascent',
    label: 'Ascent',
    title: ['Eighteen', 'floating treads.'],
    body: 'Oak cantilevered from the concrete, each step carrying its own strip of light.',
    at: [0.652, 0.735],
    align: 'left',
  },
  {
    id: 'loft',
    label: 'The loft',
    title: ['Sleep under', 'the weather.'],
    body: 'A skylight the size of the bed. Stars when it is clear, rain when it is not.',
    at: [0.775, 0.85],
    align: 'left',
  },
];

/**
 * Inside the house the film stops and the visitor walks: each stop is a place to stand, with a few ways on from it.
 * (Where each one is, and how the camera gets there, is in src/tour.ts.)
 */
export type StopId = 'room' | 'terrace' | 'fire' | 'picture' | 'kitchen' | 'dining' | 'loft' | 'bed' | 'desk' | 'board' | 'books' | 'corner' | 'scope';
/** somewhere a way can lead: another stop, or one of the two ways back into the film — down onto the pier, or up through the skylight */
export type Place = StopId | 'pier' | 'sky';
/** something to do without going anywhere: put a log on the fire, a record on the player, call the rain, open one of the sheets on the board */
export type Act = 'log' | 'record' | 'rain' | `work:${string}`;
export const isAct = (to: Place | Act): to is Act => to === 'log' || to === 'record' || to === 'rain' || to.startsWith('work:');

export interface Way {
  to: Place | Act;
  /** offered only while its place is in sight (see `extras` in src/tour.ts): what one can see, one can go to */
  seen?: boolean;
  label: string;
  note: string;
}

export interface Stop {
  label: string;
  /** what a plate that leads here says, from anywhere it can be seen */
  go: string;
  title: string[];
  body: string;
  /** which chapter of the film this place belongs to (1-based), for the counter and the rail */
  chapter: number;
  ways: Way[];
  /** what the scroll wheel does here, if anything */
  hint?: string;
}

export const stops: Record<StopId, Stop> = {
  room: {
    label: 'The long room',
    go: 'Go to the sofa',
    title: ['Built around', 'one sofa.'],
    body: 'Everything on this floor faces the same way — toward the fire and, past it, the water. The house is yours for the evening.',
    chapter: 3,
    ways: [
      { to: 'fire', label: 'Sit by the hearth', note: 'the chaise, an arm’s length from the fire' },
      { to: 'picture', label: 'Look at the picture', note: 'on the long wall, under its own lamp' },
      { to: 'kitchen', label: 'Walk through to the kitchen', note: 'stone, oak, three globes of light' },
      { to: 'loft', label: 'Climb to the loft', note: 'eighteen floating treads' },
      { to: 'terrace', label: 'Go out to the fire bowl', note: 'two chairs on the terrace, a step above the lake' },
    ],
    hint: 'or scroll back to leave the way you came',
  },
  terrace: {
    label: 'The terrace',
    go: 'Go out to the fire bowl',
    title: ['A fire', 'beside the water.'],
    body: 'Two low chairs and a bowl of burning birch, a step above the lake. Behind you the house glows; in front there is only the dusk.',
    chapter: 2,
    ways: [
      { to: 'room', label: 'Go back inside', note: 'the door is still open' },
      { to: 'pier', label: 'Walk down to the pier', note: 'and look back at the house' },
      { to: 'log', label: 'Put a log on', note: 'the bowl takes one more' },
    ],
  },
  fire: {
    label: 'The hearth',
    go: 'Sit by the hearth',
    title: ['Split birch,', 'an hour of light.'],
    body: 'The fire is the only thing in the room that moves. Stay until the logs settle.',
    chapter: 3,
    ways: [
      { to: 'picture', label: 'Look at the picture', note: 'behind you, over the sideboard' },
      { to: 'kitchen', label: 'Walk through to the kitchen', note: 'past the stair' },
      { to: 'room', label: 'Stand up', note: 'back to the door' },
      { to: 'log', label: 'Put a log on', note: 'from the rack beside it' },
    ],
  },
  picture: {
    label: 'The picture',
    go: 'Look at the picture',
    title: ['One frame', 'on the long wall.'],
    body: 'Hung where the last daylight used to fall, and given a lamp of its own for after dark.',
    chapter: 3,
    ways: [
      { to: 'fire', label: 'Sit by the hearth', note: 'the chaise is free' },
      { to: 'loft', label: 'Climb to the loft', note: 'the stair is just along the wall' },
      { to: 'room', label: 'Turn round', note: 'back to the door' },
    ],
  },
  kitchen: {
    label: 'Kitchen',
    go: 'Walk through to the kitchen',
    title: ['Stone, oak,', 'a low light.'],
    body: 'A three-metre island under a single slab of stone. Breakfast is already out on the board.',
    chapter: 4,
    ways: [
      { to: 'dining', label: 'Sit down at the table', note: 'tea for two, set and waiting' },
      { to: 'loft', label: 'Climb to the loft', note: 'the stair starts here' },
      { to: 'room', label: 'Go back to the sofa', note: 'and the fire' },
    ],
  },
  dining: {
    label: 'Table',
    go: 'Sit down at the table',
    title: ['Dinner for six,', 'tea for two.'],
    body: 'Oak on steel beneath one line of brass. The pot is still warm.',
    chapter: 4,
    ways: [
      { to: 'kitchen', label: 'Go to the island', note: 'fruit, bread, the tap running cold' },
      { to: 'loft', label: 'Climb to the loft', note: 'eighteen floating treads' },
      { to: 'room', label: 'Go back to the sofa', note: 'and the fire' },
    ],
  },
  loft: {
    label: 'The loft',
    go: 'Step back to the stair',
    title: ['One room', 'under the roof.'],
    body: 'A bed, a desk, a wall of books and a chair by the glass — and over all of it, a window onto the weather.',
    chapter: 6,
    ways: [
      { to: 'bed', label: 'Go to the bed', note: 'it lies under the skylight' },
      { to: 'desk', label: 'Sit at the desk', note: 'the oceans are turning on the screen' },
      { to: 'books', label: 'Browse the shelves', note: 'four bays of them, along the wall' },
      { to: 'corner', label: 'Take the chair by the glass', note: 'a lamp, a ukulele, the lake below' },
      { to: 'room', label: 'Go back down', note: 'to the long room' },
      { to: 'record', label: 'Put a record on', note: 'the player on the sideboard' },
    ],
  },
  bed: {
    label: 'The loft',
    go: 'Go to the bed',
    title: ['Sleep under', 'the weather.'],
    body: 'A skylight the size of the bed. Stars when it is clear, rain when it is not.',
    chapter: 6,
    ways: [
      { to: 'sky', label: 'Open the skylight', note: 'and go out into the night' },
      { to: 'rain', label: 'Let it rain', note: 'on the glass overhead' },
      { to: 'scope', label: 'Look through the telescope', note: 'by the window' },
      { to: 'corner', label: 'Take the chair by the glass', note: 'a few steps away' },
      { to: 'loft', label: 'Step back', note: 'to the top of the stair' },
    ],
    hint: 'or scroll on, and the skylight opens',
  },
  desk: {
    label: 'The desk',
    go: 'Sit at the desk',
    title: ['Where the house', 'was drawn.'],
    body: 'Four centuries of prints pinned over it — a wave, a map of the north, the heavens — and on the screen, the currents of the sea, still turning.',
    chapter: 6,
    ways: [
      { to: 'board', label: 'Look at the board', note: 'six sheets, six pieces of work' },
      { to: 'books', label: 'Turn to the shelves', note: 'on your left' },
      { to: 'bed', label: 'Go to the bed', note: 'under the skylight' },
      { to: 'loft', label: 'Step back', note: 'to the top of the stair' },
    ],
  },
  books: {
    label: 'The library',
    go: 'Browse the shelves',
    title: ['Four bays', 'of other worlds.'],
    body: 'Steel and oak, floor to head height. Spines out, in no order anyone else would understand.',
    chapter: 6,
    ways: [
      { to: 'desk', label: 'Sit at the desk', note: 'to your right' },
      { to: 'bed', label: 'Go to the bed', note: 'under the skylight' },
      { to: 'loft', label: 'Step back', note: 'to the top of the stair' },
    ],
  },
  board: {
    label: 'The board',
    go: 'Look at the board',
    title: ['Six sheets,', 'six pieces of work.'],
    body: 'Every print pinned here stands for something made. Choose a sheet to read its note.',
    chapter: 6,
    ways: [
      ...works.map((w) => ({ to: `work:${w.id}` as const, label: w.title, note: w.meta })),
      { to: 'desk', label: 'Sit back', note: 'at the desk' },
    ],
  },
  scope: {
    label: 'The telescope',
    go: 'Look through the telescope',
    title: ['The sky', 'over the lake.'],
    body: 'The same nine thousand stars, nearer. Move the pointer to sweep the tube across them.',
    chapter: 6,
    ways: [
      { to: 'corner', label: 'Step back', note: 'to the chair by the glass' },
      { to: 'bed', label: 'Go to the bed', note: 'under the skylight' },
    ],
  },
  corner: {
    label: 'The corner',
    go: 'Take the chair by the glass',
    title: ['A chair', 'that faces the lake.'],
    body: 'Close enough to the glass to hear the water when the wind drops.',
    chapter: 6,
    ways: [
      { to: 'scope', label: 'Look through the telescope', note: 'by the window' },
      { to: 'bed', label: 'Go to the bed', note: 'under the skylight' },
      { to: 'desk', label: 'Sit at the desk', note: 'across the room' },
      { to: 'loft', label: 'Step back', note: 'to the top of the stair' },
    ],
  },
};

export const outro = {
  label: 'Morning',
  title: ['Then the lake', 'gives the light back.'],
  body: 'Vesper is one of one. Viewings are by appointment, and best at dusk.',
  cta: 'Request a viewing',
  at: 0.972,
};

/** [scroll progress, minutes since midnight] — the clock in the corner follows the sky. */
export const clock: [number, number][] = [
  [0, 21 * 60 + 38],
  [0.3, 21 * 60 + 54],
  [0.62, 25 * 60 + 12],
  [0.868, 27 * 60 + 36],
  [1, 28 * 60 + 58],
];
