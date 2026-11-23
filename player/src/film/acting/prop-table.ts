export type PropEffect = "gun" | "boat" | "sway" | "flame";

export interface PropSpec {
  icon: string;
  by: string;
  meters: number;
  faces?: 1 | -1;
  effect?: PropEffect;
  spot?: readonly [number, number];
  holes?: "open" | "solid";
  surface?: boolean;
}

export const PROP_TABLE = {
  cannon: { icon: "cannon", by: "Lorc", meters: 1.2, faces: 1, effect: "gun", spot: [0.98, 0.2] },
  mortar: { icon: "mortar", by: "Delapouite", meters: 1.1, faces: 1, effect: "gun", spot: [0.68, 0.04] },
  tank: { icon: "great-war-tank", by: "Cathelineau", meters: 2.5, faces: 1, effect: "gun", spot: [1, 0.08] },
  throne: { icon: "stone-throne", by: "Lorc", meters: 1.6 },
  armchair: { icon: "armchair", by: "Caro Asercion", meters: 1 },
  chair: { icon: "wooden-chair", by: "Delapouite", meters: 0.95 },
  stool: { icon: "bar-stool", by: "Delapouite", meters: 0.75, surface: true },
  table: { icon: "table", by: "Delapouite", meters: 0.76, surface: true },
  desk: { icon: "table", by: "Delapouite", meters: 0.76, surface: true },
  books: { icon: "book-pile", by: "Delapouite", meters: 0.25, surface: true },
  globe: { icon: "globe", by: "Lorc", meters: 0.6 },
  telescope: { icon: "telescope", by: "Delapouite", meters: 1.4, faces: 1 },
  microscope: { icon: "microscope", by: "Lord Berandas", meters: 0.35 },
  easel: { icon: "easel", by: "Caro Asercion", meters: 1.7 },
  urn: { icon: "amphora", by: "Delapouite", meters: 0.7 },
  vase: { icon: "porcelain-vase", by: "Delapouite", meters: 0.45 },
  cauldron: { icon: "cauldron", by: "Lorc", meters: 0.6 },
  tent: { icon: "camping-tent", by: "Delapouite", meters: 1.3, holes: "solid" },
  marquee: { icon: "barracks-tent", by: "Delapouite", meters: 3, holes: "solid" },
  campfire: { icon: "campfire", by: "Lorc", meters: 0.7, effect: "flame", spot: [0.5, 0.4] },
  fireplace: { icon: "fireplace", by: "Delapouite", meters: 1.3, effect: "flame", spot: [0.5, 0.7], holes: "solid" },
  ship: { icon: "galleon", by: "Lorc", meters: 2.6, faces: 1, effect: "boat" },
  sailboat: { icon: "sailboat", by: "Delapouite", meters: 1.6, faces: 1, effect: "boat" },
  schooner: { icon: "shooner-sailboat", by: "Pierre Leducq", meters: 2.2, faces: 1, effect: "boat" },
  anchor: { icon: "anchor", by: "Lorc", meters: 1.2 },
  barrel: { icon: "barrel", by: "Delapouite", meters: 0.9, surface: true },
  chest: { icon: "chest", by: "Delapouite", meters: 0.6, surface: true },
  crate: { icon: "wooden-crate", by: "Delapouite", meters: 0.8, surface: true },
  lantern: { icon: "old-lantern", by: "Delapouite", meters: 0.4, effect: "flame", spot: [0.5, 0.6] },
  candle: { icon: "candle-holder", by: "Lorc", meters: 0.25, effect: "flame", spot: [0.52, 0.08] },
  flag: { icon: "flying-flag", by: "Lorc", meters: 2.6, effect: "sway" },
  pine: { icon: "pine-tree", by: "Lorc", meters: 3, effect: "sway" },
  "fruit-tree": { icon: "fruit-tree", by: "Delapouite", meters: 3, effect: "sway" },
  palm: { icon: "palm-tree", by: "Delapouite", meters: 3.2, effect: "sway" },
  willow: { icon: "willow-tree", by: "Caro Asercion", meters: 3, effect: "sway" },
  rock: { icon: "rock", by: "Lorc", meters: 0.8 },
  wheat: { icon: "wheat", by: "Lorc", meters: 1, effect: "sway" },
  wagon: { icon: "old-wagon", by: "Delapouite", meters: 2.2, faces: 1 },
  wheelbarrow: { icon: "wheelbarrow", by: "Delapouite", meters: 0.7, faces: 1 },
  anvil: { icon: "anvil", by: "Lorc", meters: 0.8, surface: true },
  well: { icon: "well", by: "Delapouite", meters: 2 },
  guillotine: { icon: "guillotine", by: "Lorc", meters: 3.2 },
  gravestone: { icon: "tombstone", by: "Sbed", meters: 0.9 },
  ruins: { icon: "ancient-columns", by: "Delapouite", meters: 3.5 },
  obelisk: { icon: "obelisk", by: "Delapouite", meters: 3.2 },
  hourglass: { icon: "hourglass", by: "Lorc", meters: 0.3 },
  scales: { icon: "scales", by: "Lorc", meters: 0.45 },
  crown: { icon: "crown", by: "Lorc", meters: 0.15 },
  inkwell: { icon: "quill-ink", by: "Lorc", meters: 0.3 },
  piano: { icon: "grand-piano", by: "Caro Asercion", meters: 1 },
  drum: { icon: "drum", by: "Delapouite", meters: 0.6 },
  harp: { icon: "harp", by: "Delapouite", meters: 1.7 },
  cow: { icon: "cow", by: "Delapouite", meters: 1.4, faces: 1 },
  "trojan-horse": { icon: "trojan-horse", by: "Delapouite", meters: 3.2, faces: 1 },
  "server-rack": { icon: "server-rack", by: "Delapouite", meters: 2 },
  laptop: { icon: "laptop", by: "Delapouite", meters: 0.25 },
  robot: { icon: "vintage-robot", by: "Lorc", meters: 1.6 },
  "sewing-machine": { icon: "sewing-machine", by: "Caro Asercion", meters: 0.4 },
  "spinning-wheel": { icon: "spinning-wheel", by: "Caro Asercion", meters: 1 },
  telephone: { icon: "candlestick-phone", by: "Delapouite", meters: 0.3 },
  flask: { icon: "round-bottom-flask", by: "Lorc", meters: 0.3 },
  "test-tubes": { icon: "test-tubes", by: "Lorc", meters: 0.25 },
  locomotive: { icon: "steam-locomotive", by: "Delapouite", meters: 3, faces: 1 },
  fence: { icon: "wooden-fence", by: "Lorc", meters: 1.2 },
  railing: { icon: "spiked-fence", by: "Lorc", meters: 1.4, holes: "open" },
  ladder: { icon: "ladder", by: "Delapouite", meters: 3 },
} as const satisfies Record<string, PropSpec>;

export type PropName = keyof typeof PROP_TABLE;
