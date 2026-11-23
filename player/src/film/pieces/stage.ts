import { clamp01, type Drawable, fail, integerField, type LabDef, type LabOp, lerp, type Paint, type Point, rangeField, stringField } from "../../lab";
import { textWidth } from "../../text-metrics";
import { COSTUMES, type CostumeName, drawFigure, type Holding, type Item, ITEMS, type Look } from "../acting/body";
import { alive, arrivingPose, jittered, POSE_NAMES, POSES, type PoseName, walkingPose } from "../acting/poses";
import { type Gait, GAITS, type GaitName, type Ground, lerpPose, type Pose, posed, type Skeleton, smooth, travelled, travelSeconds, walking } from "../acting/rig";
import { BOATS, drawProp, type FireMoment, GUNS, muzzleOf, PROP_NAMES, propCredit, type PropName, type PropPlace, propSize, SURFACES } from "../acting/props";
import { clipToStage, GENERAL_MARKS, SET_NAMES, type Setting, settingOf, STAGE_H, STAGE_W } from "../acting/sets";

const TONES = ["lead", "plain", "dim", "lit"] as const;
type Tone = (typeof TONES)[number];
type Facing = 1 | -1;
const COSTUME_NAMES = Object.keys(COSTUMES) as CostumeName[];
const PACES = Object.keys(GAITS) as GaitName[];
const SIDES = ["left", "right"] as const;

interface Actor {
  id: string;
  as: CostumeName;
  x: number;
  facing: Facing;
  pose: PoseName;
  holding: Item | null;
  label: string;
  tone: Tone;
  count: number;
  rows: number;
  scale: number;
  on: boolean;
}

interface Thing {
  id: string;
  kind: PropName;
  x: number;
  facing: Facing;
  atop: string | null;
  on: boolean;
}

interface StageState {
  objectId: string;
  set: string;
  steps: string[];
  caption: string;
  actors: Actor[];
  things: Thing[];
}

const TURN_SECONDS = 0.5;
const SETTLE_SECONDS = 0.3;
const POSE_SECONDS = 0.7;
const GIVE_SECONDS = 2.2;
const HOLD_SECONDS = 0.8;
const DROP_SECONDS = 0.9;
const FIRE_SECONDS = 1.8;
const LIGHT_SECONDS = 0.8;
const FADE_SECONDS = 0.9;
const CROWD_STAGGER = 0.45;
const MAX_CROWD = 60;
const MAX_WORDS = 16;
const FACE_GAP = 250;
const SIDE_BY_SIDE = 0.8;
const CROWD_ROW = 6;
const MAX_ROWS = 6;
const MUZZLE_CLEAR = 420;
const FIGURE_SCALE = 1.25;
const LABEL_SIZE = 44;
const LABEL_HALO = 8;
const SPEECH_SIZE = 44;
const SPEECH_LINE = 56;
const SPEECH_TAIL = 34;
const SPEECH_WIDTH = 660;
const CAPTION_SIZE = 42;
const ROW_LIFT = 46;
const RANK_RISE = 18;
const RANK_STEP = 26;
const ROW_SHRINK = 0.9;
const POOL_Z = 2;
const FIGURE_Z = 3;
const TOP_Z = 5;
const CENTER = STAGE_W / 2;
const ALIGNED: readonly CostumeName[] = ["soldier", "grenadier", "cadet"];
const RESERVED_IDS = ["set", "caption"];
const CAST_KEYS = ["as", "at", "label", "facing", "pose", "holding", "tone", "count", "rows", "scale", "hidden"];
const THING_KEYS = ["kind", "at", "atop", "facing", "hidden"];
const ID = /^[A-Za-z][\w-]*$/;

const SHADES: readonly Paint[] = ["highlight", "accent", "muted", "edge", "rule"];
const TONE_SHADE: Record<Tone, number> = { lit: 0, lead: 1, plain: 2, dim: 3 };
const TONE_TRIM: Record<Tone, Paint> = { lit: "ink", lead: "highlight", plain: "accent", dim: "muted" };
const SEPARATION = 3;
const lookOf = (tone: Tone, row: number, opacity: number): Look => ({
  line: "ground", fill: SHADES[Math.min(SHADES.length - 1, TONE_SHADE[tone] + row)]!, detail: "ground", trim: TONE_TRIM[tone], width: SEPARATION, opacity,
});
const thingLook = (opacity: number): Look => ({ line: "ground", fill: "edge", detail: "ground", trim: "accent", width: SEPARATION, opacity });

const SETTING_CACHE = new Map<string, Setting>();

function placeOf(thing: Thing, things: Thing[], setting: Setting): PropPlace {
  const support = things.find((entry) => entry.id === thing.atop);
  const below = support && placeOf(support, things, setting);
  const ground = below ? below.ground : setting.ground(thing.x);
  const base = below ? below.base - propSize(below.name, FIGURE_SCALE).h : ground;
  return { name: thing.kind, x: thing.x, base, ground, facing: thing.facing, scale: FIGURE_SCALE };
}

function settingFor(state: Pick<StageState, "set" | "steps">): Setting {
  const key = `${state.set}|${state.steps.join("|")}`;
  const cached = SETTING_CACHE.get(key);
  if (cached) return cached;
  const setting = settingOf(state.set, state.steps);
  SETTING_CACHE.set(key, setting);
  return setting;
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], where: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) fail(`${where} must be one of ${options.join(", ")}, got ${JSON.stringify(value)}`);
  return value as T;
}

function onlyKeys(field: Record<string, unknown>, keys: string[], where: string): void {
  const unknown = Object.keys(field).filter((key) => !keys.includes(key));
  if (unknown.length) fail(`${where} has unknown ${unknown.map((key) => `"${key}"`).join(", ")}: use ${keys.join(", ")}`);
}

function markX(value: unknown, setting: Setting, where: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= STAGE_W) return value;
  if (typeof value === "string" && Object.hasOwn(setting.marks, value)) return setting.marks[value]!;
  fail(`${where} must be a mark (${Object.keys(setting.marks).join(", ")}) or an x from 0 to ${STAGE_W}, got ${JSON.stringify(value)}`);
}

const towardCenter = (x: number): Facing => (x < CENTER ? 1 : -1);
const toward = (from: number, to: number, otherwise: Facing): Facing => (to > from ? 1 : to < from ? -1 : otherwise);

function seeded(n: number): number {
  const x = Math.sin(n * 12.9898 + 4.1414) * 43758.5453;
  return x - Math.floor(x);
}

function hashOf(text: string): number {
  let hash = 7;
  for (const char of text) hash = (hash * 31 + char.charCodeAt(0)) % 100_003;
  return hash;
}

interface Member {
  index: number;
  dx: number;
  row: number;
  scale: number;
  seed: number;
  delay: number;
  screened: boolean;
}

const MEMBER_CACHE = new Map<string, Member[]>();

function membersOf(actor: Actor): Member[] {
  const key = `${actor.id}|${actor.as}|${actor.count}|${actor.rows}`;
  const cached = MEMBER_CACHE.get(key);
  if (cached) return cached;
  const base = hashOf(actor.id);
  const aligned = ALIGNED.includes(actor.as);
  const perRow = Math.ceil(actor.count / actor.rows);
  const ranks = Math.ceil(actor.count / perRow);
  const echelon = aligned && perRow > 1 ? RANK_STEP : 0;
  const spacing = aligned ? 112 - (echelon * (ranks - 1)) / (perRow - 1 || 1) : 128;
  const frontEnd = ((perRow - 1) / 2) * spacing - ((ranks - 1) / 2) * echelon;
  const members = Array.from({ length: actor.count }, (_, index): Member => {
    if (actor.count === 1) return { index, dx: 0, row: 0, scale: 1, seed: seeded(base), delay: 0, screened: false };
    const row = Math.floor(index / perRow);
    const inRow = Math.min(perRow, actor.count - row * perRow);
    const column = index % perRow;
    const stagger = aligned ? (row - (ranks - 1) / 2) * echelon : (row % 2 ? spacing / 2 : 0) + (seeded(base + index * 3) - 0.5) * 36;
    const dx = (column - (inRow - 1) / 2) * spacing + stagger;
    return {
      index,
      dx,
      row,
      scale: aligned ? 1 : 0.92 + seeded(base + index * 5) * 0.13,
      seed: seeded(base + index * 11),
      delay: aligned ? 0 : seeded(base + index * 7) * CROWD_STAGGER,
      screened: echelon > 0 && row > 0 && dx <= frontEnd,
    };
  });
  MEMBER_CACHE.set(key, members);
  return members;
}

const spreadOf = (actor: Actor) => Math.max(0, ...membersOf(actor).map((member) => member.delay));
const halfWidth = (actor: Actor) => Math.max(...membersOf(actor).map((member) => Math.abs(member.dx))) * actor.scale + 70 * actor.scale;
const inside = (actor: Actor, x: number) => {
  const half = Math.min(CENTER, halfWidth(actor));
  return Math.min(STAGE_W - half, Math.max(half, x));
};
const offX = (actor: Actor, side: Facing) => (side < 0 ? GENERAL_MARKS["off left"]! - halfWidth(actor) : GENERAL_MARKS["off right"]! + halfWidth(actor));
const ranked = (actor: Actor) => actor.count > 1 && ALIGNED.includes(actor.as);
const sizeOf = (actor: Actor, member: Member) => actor.scale * member.scale * (ranked(actor) ? 1 : ROW_SHRINK ** member.row);
const memberX = (actor: Actor, member: Member, x = actor.x) => x + member.dx * actor.scale;
const groundOf = (setting: Setting, actor: Actor, member: Member): Ground => (x) => setting.ground(x) - member.row * (ranked(actor) ? RANK_RISE : ROW_LIFT) * actor.scale;
const held = (actor: Actor): Holding | null => (actor.holding ? { item: actor.holding } : null);

function restPose(actor: Actor, member: Member, clock: number): Pose {
  const pose = actor.count > 1 ? jittered(POSES[actor.pose], member.seed, ALIGNED.includes(actor.as) ? 2 : 7) : POSES[actor.pose];
  return alive(pose, actor.pose, clock, member.seed);
}

interface Shot {
  key: string;
  skeleton: Skeleton;
  holding: Holding | null;
  look: Look;
  row: number;
  ground: Ground;
  cut: number | null;
}

interface Speech {
  words: string;
  fade: number;
}

interface Showing {
  actor: Actor;
  shots: Shot[];
  speech?: Speech;
  glow?: number;
}

interface ThingShowing {
  thing: Thing;
  opacity: number;
  fire: FireMoment | null;
}

interface Cue {
  op: LabOp;
  before: StageState;
  after: StageState;
  progress: number;
  clock: number;
  setting: Setting;
}

interface Acting {
  actors?: Map<string, Showing>;
  things?: Map<string, ThingShowing>;
}

interface StageOp {
  doc: string;
  seconds(op: LabOp, state: StageState): number;
  apply(state: StageState, op: LabOp): StageState;
  act(cue: Cue): Acting;
}

function shot(actor: Actor, member: Member, setting: Setting, skeleton: Skeleton, holding: Holding | null, opacity = 1, tone: Tone = actor.tone, key = `m${member.index}`): Shot {
  const cut = member.screened ? skeleton.pelvis.y + member.row * RANK_RISE * actor.scale : null;
  return { key, skeleton, holding, row: member.row, ground: groundOf(setting, actor, member), look: lookOf(tone, member.row, opacity), cut };
}

function standing(actor: Actor, member: Member, setting: Setting, clock: number, pose = restPose(actor, member, clock), facing: number = actor.facing): Skeleton {
  return posed(pose, memberX(actor, member), groundOf(setting, actor, member), facing, sizeOf(actor, member));
}

function resting(actor: Actor, setting: Setting, clock: number): Showing {
  return { actor, shots: membersOf(actor).map((member) => shot(actor, member, setting, standing(actor, member, setting, clock), held(actor))), glow: actor.tone === "lit" ? 1 : 0 };
}

function findActor(state: StageState, id: string | undefined, opName: string): Actor {
  const actor = id === undefined ? undefined : state.actors.find((entry) => entry.id === id);
  if (!actor) {
    const names = state.actors.map((entry) => `${state.objectId}[${entry.id}]`).join(", ");
    fail(id === undefined ? `op "${opName}" names who acts in "on", such as "on": ["${state.objectId}[${state.actors[0]?.id ?? "name"}]"]` : `op "${opName}": ${state.objectId}[${id}] is not in the cast: use ${names}`);
  }
  return actor;
}

function findThing(state: StageState, id: string | undefined, opName: string): Thing {
  const thing = id === undefined ? undefined : state.things.find((entry) => entry.id === id);
  if (!thing) fail(`op "${opName}" acts on a thing: use ${state.things.map((entry) => `${state.objectId}[${entry.id}]`).join(", ") || "a stage with \"things\""}`);
  return thing;
}

function onStage(actor: Actor, state: StageState, opName: string): Actor {
  if (!actor.on) fail(`op "${opName}": ${state.objectId}[${actor.id}] is not on stage: bring them on with "enter" or "appear" first`);
  return actor;
}

const withActor = (state: StageState, actor: Actor): StageState => ({ ...state, actors: state.actors.map((entry) => (entry.id === actor.id ? actor : entry)) });
const withThing = (state: StageState, thing: Thing): StageState => ({ ...state, things: state.things.map((entry) => (entry.id === thing.id ? thing : entry)) });

function facingArg(value: unknown, from: number, state: StageState, where: string): Facing {
  if (value === "left") return -1;
  if (value === "right") return 1;
  const other = typeof value === "string" ? [...state.actors, ...state.things].find((entry) => entry.id === value) : undefined;
  if (!other) fail(`${where} must be left, right or a cast id, got ${JSON.stringify(value)}`);
  return toward(from, other.x, 1);
}

const sideName = (facing: Facing) => SIDES[facing === -1 ? 0 : 1];

function poseArg(value: unknown, fallback: PoseName, where: string): PoseName {
  return value === undefined ? fallback : oneOf(value, POSE_NAMES, where);
}

function paceArg(op: LabOp, fallback: GaitName = "walk"): GaitName {
  return op.args.pace === undefined ? fallback : oneOf(op.args.pace, PACES, `op "${op.name}" "pace"`);
}

interface Goal {
  x: number;
  facing: Facing | null;
}

function destination(state: StageState, mover: Actor, from: number, value: unknown, opName: string): Goal {
  const setting = settingFor(state);
  const other = typeof value === "string" ? state.actors.find((entry) => entry.id === value && entry.id !== mover.id) : undefined;
  if (other) {
    const side = toward(other.x, from, (-other.facing) as Facing);
    const gap = FACE_GAP * Math.max(mover.scale, other.scale) + (other.count > 1 ? halfWidth(other) : 0) + (mover.count > 1 ? halfWidth(mover) : 0);
    return { x: inside(mover, other.x + side * gap), facing: (-side) as Facing };
  }
  if (value === undefined) fail(`op "${opName}" needs "to": a mark, an x or a cast id to walk up to`);
  if (value === "off left" || value === "off right") fail(`op "${opName}" walks on stage, so "to" cannot be "${value}": use "exit" to walk ${state.objectId}[${mover.id}] off`);
  return { x: inside(mover, markX(value, setting, `op "${opName}" "to"`)), facing: null };
}

interface Travel {
  from: number;
  to: number;
  distance: number;
  dir: Facing;
  gait: Gait;
  lead: number;
  walk: number;
  tail: number;
  total: number;
}

function travelOf(before: Actor, after: Actor, pace: GaitName, from = before.x, to = after.x, startFacing = before.facing, settle = true): Travel {
  const gait = { ...GAITS[pace], stride: GAITS[pace].stride * before.scale, speed: GAITS[pace].speed * before.scale };
  const distance = Math.abs(to - from);
  const dir = toward(from, to, startFacing);
  const lead = startFacing !== dir ? TURN_SECONDS : SETTLE_SECONDS;
  const tail = after.facing !== dir ? TURN_SECONDS : settle ? SETTLE_SECONDS : 0;
  const walk = travelSeconds(distance, gait);
  return { from, to, distance, dir, gait, lead, walk, tail, total: lead + walk + tail + spreadOf(before) };
}

function travelling(cue: Cue, before: Actor, after: Actor, travel: Travel, startFacing: number = before.facing): Showing {
  const elapsed = cue.progress * travel.total;
  const stride = walkingPose(before.pose, before.holding !== null);
  const shots = membersOf(before).map((member) => {
    const t = elapsed - member.delay;
    const size = sizeOf(before, member);
    const ground = groundOf(cue.setting, before, member);
    const base = before.count > 1 ? jittered(POSES[stride.pose], member.seed, 3) : POSES[stride.pose];
    let skeleton: Skeleton;
    if (t < travel.lead) {
      const u = smooth(t / travel.lead);
      skeleton = posed(lerpPose(restPose(before, member, cue.clock), base, u), memberX(before, member, travel.from), ground, lerp(startFacing, travel.dir, u), size);
    } else if (t < travel.lead + travel.walk) {
      skeleton = walking({
        base, start: memberX(before, member, travel.from), facing: travel.dir, distance: travel.distance,
        covered: travelled(travel.distance, travel.gait, t - travel.lead), gait: travel.gait, ground, scale: size, freeArms: stride.swing,
      });
    } else {
      const u = travel.tail > 0 ? smooth((t - travel.lead - travel.walk) / travel.tail) : 1;
      skeleton = posed(lerpPose(base, restPose(after, member, cue.clock), u), memberX(after, member, travel.to), ground, lerp(travel.dir, after.facing, u), size);
    }
    return shot(before, member, cue.setting, skeleton, held(before));
  });
  return { actor: after, shots, glow: after.tone === "lit" ? 1 : 0 };
}

function blending(cue: Cue, before: Actor, after: Actor, seconds: number, dress: (member: Member, skeleton: Skeleton, u: number) => Shot[] = (member, skeleton) => [shot(after, member, cue.setting, skeleton, held(after))]): Showing {
  const elapsed = cue.progress * (seconds + spreadOf(before) * 0.6);
  const shots = membersOf(after).flatMap((member) => {
    const u = smooth((elapsed - member.delay * 0.6) / seconds);
    const pose = lerpPose(restPose(before, member, cue.clock), restPose(after, member, cue.clock), u);
    return dress(member, standing(after, member, cue.setting, cue.clock, pose, lerp(before.facing, after.facing, u)), u);
  });
  return { actor: after, shots, glow: after.tone === "lit" ? 1 : 0 };
}

const crowdSeconds = (state: StageState, op: LabOp, seconds: number) => seconds + spreadOf(findActor(state, op.parts[0], op.name)) * 0.6;
const only = (id: string, showing: Showing): Acting => ({ actors: new Map([[id, showing]]) });

function arc(from: Point, to: Point, u: number): Point {
  const s = smooth(u);
  const lift = Math.min(170, Math.hypot(to.x - from.x, to.y - from.y) * 0.3);
  return { x: lerp(from.x, to.x, s), y: lerp(from.y, to.y, s) - Math.sin(Math.PI * s) * lift };
}

interface Handover {
  giver: string;
  receiver: string;
  item: Item;
}

function handover(state: StageState, op: LabOp, giverIndex: number): { state: StageState; handover: Handover } {
  const giver = onStage(findActor(state, op.parts[giverIndex], op.name), state, op.name);
  const receiver = onStage(findActor(state, op.parts[1 - giverIndex], op.name), state, op.name);
  if (giver.id === receiver.id) fail(`op "${op.name}" needs two different people in "on"`);
  if (giver.count > 1) fail(`op "${op.name}": a crowd cannot hand something over; one person gives, and a crowd may receive`);
  const item = op.args.item === undefined
    ? giver.holding ?? fail(`op "${op.name}": ${state.objectId}[${giver.id}] holds nothing, so name the "item": ${ITEMS.join(", ")}`)
    : oneOf(op.args.item, ITEMS, `op "${op.name}" "item"`);
  const keeps = op.args.keep === true || receiver.count > 1 || giver.holding !== item;
  const giverAfter: Actor = {
    ...giver,
    facing: toward(giver.x, receiver.x, giver.facing),
    holding: keeps ? giver.holding : null,
    pose: !keeps && giver.pose === "hold" ? "stand" : giver.pose,
  };
  const receiverAfter: Actor = { ...receiver, facing: toward(receiver.x, giver.x, receiver.facing), holding: item, pose: receiver.pose === "stand" ? "hold" : receiver.pose };
  return { state: withActor(withActor(state, giverAfter), receiverAfter), handover: { giver: giver.id, receiver: receiver.id, item } };
}

function handing(cue: Cue, giverIndex: number): Acting {
  const { handover: hand } = handover(cue.before, cue.op, giverIndex);
  const g0 = findActor(cue.before, hand.giver, cue.op.name);
  const g1 = findActor(cue.after, hand.giver, cue.op.name);
  const r0 = findActor(cue.before, hand.receiver, cue.op.name);
  const r1 = findActor(cue.after, hand.receiver, cue.op.name);
  const p = cue.progress;
  const receiverLeads = giverIndex === 1;
  const reach = (start: number) => smooth((p - start) / 0.3) * (1 - smooth((p - 0.7) / 0.3));
  const turn = smooth(p / 0.22);
  const body = (before: Actor, after: Actor, member: Member, amount: number) => {
    const rest = p < 0.7 ? restPose(before, member, cue.clock) : restPose(after, member, cue.clock);
    return standing(after, member, cue.setting, cue.clock, lerpPose(rest, POSES.reach, amount), lerp(before.facing, after.facing, turn));
  };
  const giverMember = membersOf(g1)[0]!;
  const giverSkeleton = body(g0, g1, giverMember, reach(receiverLeads ? 0.12 : 0));
  const giverHolds: Holding | null = p < 0.32
    ? { item: hand.item, fade: g0.holding === hand.item ? 1 : smooth(p / 0.2) }
    : held(g1);
  const giverShot = shot(g1, giverMember, cue.setting, giverSkeleton, g1.holding === hand.item ? { item: hand.item } : giverHolds);
  const start = giverSkeleton.near.hand;
  const receiverShots = membersOf(r1).map((member) => {
    const lag = r1.count > 1 ? member.delay * 0.3 : 0;
    const skeleton = body(r0, r1, member, reach((receiverLeads ? 0 : 0.12) + lag));
    const u = clamp01((p - 0.32 - lag) / 0.36);
    const holding: Holding | null = u <= 0 ? held(r0) : u < 1 ? { item: hand.item, at: arc(start, skeleton.near.hand, u) } : { item: hand.item };
    return shot(r1, member, cue.setting, skeleton, holding);
  });
  return {
    actors: new Map([
      [hand.giver, { actor: g1, shots: [giverShot], glow: g1.tone === "lit" ? 1 : 0 }],
      [hand.receiver, { actor: r1, shots: receiverShots, glow: r1.tone === "lit" ? 1 : 0 }],
    ]),
  };
}

function wordsOf(op: LabOp): string {
  const words = op.args.words;
  if (typeof words !== "string" || !words.trim()) fail(`op "say" needs "words": what they said, quoted from the sources`);
  const count = words.trim().split(/\s+/).length;
  if (count > MAX_WORDS) fail(`op "say" words are ${count} long: keep a spoken line to ${MAX_WORDS} words or fewer`);
  return words.trim();
}

const sayingSeconds = (words: string) => Math.min(5.5, Math.max(2.2, 1.2 + 0.32 * words.split(/\s+/).length));

function target(state: StageState, setting: Setting, value: unknown): Point | null {
  if (value === undefined) return null;
  const actor = typeof value === "string" ? state.actors.find((entry) => entry.id === value) : undefined;
  if (actor) return { x: actor.x, y: setting.ground(actor.x) - 230 * actor.scale };
  const x = markX(value, setting, `op "fire" "at"`);
  return { x, y: setting.ground(x) - 170 };
}

function fading(cue: Cue, appearing: boolean): Acting {
  const id = cue.op.parts[0];
  const amount = appearing ? smooth(cue.progress) : 1 - smooth(cue.progress);
  const thing = cue.after.things.find((entry) => entry.id === id);
  if (thing) return { things: new Map([[thing.id, { thing, opacity: amount, fire: null }]]) };
  const actor = findActor(cue.after, id, cue.op.name);
  const showing = resting(actor, cue.setting, cue.clock);
  showing.shots = membersOf(actor).map((member) => shot(actor, member, cue.setting, standing(actor, member, cue.setting, cue.clock), held(actor), amount));
  return only(actor.id, { ...showing, glow: (showing.glow ?? 0) * amount });
}

function shownAs(state: StageState, op: LabOp, shown: boolean): StageState {
  const id = op.parts[0];
  const thing = state.things.find((entry) => entry.id === id);
  if (thing) {
    if (thing.on === shown) fail(`op "${op.name}": ${state.objectId}[${thing.id}] is already ${shown ? "shown" : "gone"}`);
    return withThing(state, { ...thing, on: shown });
  }
  const actor = findActor(state, id, op.name);
  if (actor.on === shown) fail(`op "${op.name}": ${state.objectId}[${actor.id}] is already ${shown ? "on stage" : "gone"}`);
  return withActor(state, { ...actor, on: shown });
}

const who = (state: StageState, entry: { id: string }) => `${state.objectId}[${entry.id}]`;

interface Reach {
  from: number;
  to: number;
}

const reachOf = (actor: Actor): Reach => ({ from: actor.x - halfWidth(actor), to: actor.x + halfWidth(actor) });
const between = (a: number, b: number): Reach => ({ from: Math.min(a, b), to: Math.max(a, b) });
const meets = (a: Reach, b: Reach) => a.from < b.to && b.from < a.to;

function crowding(state: StageState, a: Actor, b: Actor): string | null {
  const apart = Math.abs(a.x - b.x);
  const room = halfWidth(a) + halfWidth(b);
  if (a.count > 1 && b.count > 1 && apart < room) {
    return `the crowds ${who(state, a)} and ${who(state, b)} overlap and would read as one crowd: keep their centers at least ${Math.ceil(room)} apart, make a crowd smaller, or walk one up to the other by its cast id`;
  }
  if (a.count === 1 && b.count === 1 && apart < room * SIDE_BY_SIDE) {
    return `${who(state, a)} and ${who(state, b)} stand on top of each other: keep two people at least ${Math.ceil(room * SIDE_BY_SIDE)} apart, or walk one up to the other by its cast id`;
  }
  if (a.count === 1 && b.count > 1 && apart < halfWidth(b)) {
    return `${who(state, a)} stands inside the crowd ${who(state, b)} and is hidden behind it: list the crowd before ${a.id} in the cast so ${a.id} stands in front, or move ${a.id} clear of it`;
  }
  return null;
}

const muzzleX = (state: StageState, gun: Thing) => muzzleOf(placeOf(gun, state.things, settingFor(state)))?.x ?? null;

function inFrontOfMuzzle(state: StageState, actor: Actor): string | null {
  const gun = state.things.find((thing) => {
    const muzzle = thing.on ? muzzleX(state, thing) : null;
    return muzzle !== null && meets(reachOf(actor), between(muzzle, muzzle + thing.facing * MUZZLE_CLEAR));
  });
  if (!gun) return null;
  const [faces, behind] = gun.facing > 0 ? ["right", "left"] : ["left", "right"];
  return `${who(state, actor)} stands in front of the muzzle of ${who(state, gun)}: people stand beside or behind a gun (this one faces ${faces}, so to its ${behind}), never in front of it`;
}

function roomy(state: StageState): StageState {
  const shown = state.actors.filter((actor) => actor.on);
  for (const [index, actor] of shown.entries()) {
    const problem = inFrontOfMuzzle(state, actor) ?? shown.slice(index + 1).reduce<string | null>((found, other) => found ?? crowding(state, actor, other), null);
    if (problem) fail(problem);
  }
  return state;
}

function lineOfFire(state: StageState, gun: Thing, at: Point | null): void {
  const muzzle = muzzleX(state, gun)!;
  const end = at?.x ?? muzzle + gun.facing * STAGE_W;
  const struck = state.actors.find((actor) => {
    const reach = reachOf(actor);
    const isTarget = reach.from <= end && end <= reach.to;
    return actor.on && !isTarget && meets(reach, between(muzzle, end));
  });
  if (struck) fail(`op "fire": ${who(state, struck)} stands in the line of fire between ${who(state, gun)} and what it fires at: walk them behind the gun first, or fire "at" them`);
}

const STAGE_OPS: Record<string, StageOp> = {
  enter: {
    doc: 'walks a person or crowd in from the side they wait on ("at": "off left" or "off right") to "to": a mark, an x or a cast id to walk up to; optional "pace" (walk, run or march), "face" and "pose" to end in, else they arrive standing',
    seconds(op, state) {
      const before = findActor(state, op.parts[0], op.name);
      const after = findActor(this.apply(state, op), op.parts[0], op.name);
      const start = offX(before, before.x < CENTER ? -1 : 1);
      return travelOf(before, after, paceArg(op), start, after.x, toward(start, after.x, 1)).total;
    },
    apply(state, op) {
      const mover = findActor(state, op.parts[0], op.name);
      if (mover.on) fail(`op "enter": ${state.objectId}[${mover.id}] is already on stage: use "walk" to move them`);
      const start = offX(mover, mover.x < CENTER ? -1 : 1);
      const goal = destination(state, mover, start, op.args.to, op.name);
      const facing = op.args.face === undefined ? goal.facing ?? toward(start, goal.x, 1) : facingArg(op.args.face, goal.x, state, `op "enter" "face"`);
      return withActor(state, { ...mover, on: true, x: goal.x, facing, pose: poseArg(op.args.pose, arrivingPose(mover.pose), `op "enter" "pose"`) });
    },
    act(cue) {
      const before = findActor(cue.before, cue.op.parts[0], cue.op.name);
      const after = findActor(cue.after, cue.op.parts[0], cue.op.name);
      const start = offX(before, before.x < CENTER ? -1 : 1);
      const facing = toward(start, after.x, 1);
      return only(after.id, travelling(cue, before, after, travelOf(before, after, paceArg(cue.op), start, after.x, facing), facing));
    },
  },
  walk: {
    doc: 'walks a person or crowd on stage to "to": a mark, an x or a cast id to walk up to and face; optional "pace" (walk, run or march), "face" (left, right or a cast id) and "pose" to end in, else they arrive standing',
    seconds(op, state) {
      const before = findActor(state, op.parts[0], op.name);
      return travelOf(before, findActor(this.apply(state, op), op.parts[0], op.name), paceArg(op)).total;
    },
    apply(state, op) {
      const mover = onStage(findActor(state, op.parts[0], op.name), state, op.name);
      const goal = destination(state, mover, mover.x, op.args.to, op.name);
      const facing = op.args.face === undefined ? goal.facing ?? toward(mover.x, goal.x, mover.facing) : facingArg(op.args.face, goal.x, state, `op "walk" "face"`);
      return withActor(state, { ...mover, x: goal.x, facing, pose: poseArg(op.args.pose, arrivingPose(mover.pose), `op "walk" "pose"`) });
    },
    act(cue) {
      const before = findActor(cue.before, cue.op.parts[0], cue.op.name);
      const after = findActor(cue.after, cue.op.parts[0], cue.op.name);
      return only(after.id, travelling(cue, before, after, travelOf(before, after, paceArg(cue.op))));
    },
  },
  exit: {
    doc: 'walks a person or crowd off stage; optional "to" (left or right, else the nearer side) and "pace" (walk, run or march; run for a crowd that flees)',
    seconds(op, state) {
      const before = findActor(state, op.parts[0], op.name);
      return travelOf(before, findActor(this.apply(state, op), op.parts[0], op.name), paceArg(op), before.x, undefined, before.facing, false).total;
    },
    apply(state, op) {
      const mover = onStage(findActor(state, op.parts[0], op.name), state, op.name);
      const side: Facing = op.args.to === undefined ? (mover.x < CENTER ? -1 : 1) : oneOf(op.args.to, SIDES, `op "exit" "to"`) === "left" ? -1 : 1;
      return withActor(state, { ...mover, on: false, x: offX(mover, side), facing: side });
    },
    act(cue) {
      const before = findActor(cue.before, cue.op.parts[0], cue.op.name);
      const after = findActor(cue.after, cue.op.parts[0], cue.op.name);
      return only(after.id, travelling(cue, before, after, travelOf(before, after, paceArg(cue.op), before.x, after.x, before.facing, false)));
    },
  },
  turn: {
    doc: 'turns a person or crowd to "face": left, right or a cast id',
    seconds: (op, state) => crowdSeconds(state, op, TURN_SECONDS),
    apply(state, op) {
      const actor = onStage(findActor(state, op.parts[0], op.name), state, op.name);
      const facing = facingArg(op.args.face, actor.x, state, `op "turn" "face"`);
      if (facing === actor.facing) fail(`op "turn": ${state.objectId}[${actor.id}] already faces ${sideName(facing)}, so nothing moves; turn them the other way, or pose, walk or give`);
      return withActor(state, { ...actor, facing });
    },
    act: (cue) => only(cue.op.parts[0]!, blending(cue, findActor(cue.before, cue.op.parts[0], cue.op.name), findActor(cue.after, cue.op.parts[0], cue.op.name), TURN_SECONDS)),
  },
  pose: {
    doc: `moves a person or crowd into "pose": ${POSE_NAMES.join(", ")}; optional "face"`,
    seconds: (op, state) => crowdSeconds(state, op, POSE_SECONDS),
    apply(state, op) {
      const actor = onStage(findActor(state, op.parts[0], op.name), state, op.name);
      const pose = poseArg(op.args.pose ?? fail(`op "pose" needs "pose": ${POSE_NAMES.join(", ")}`), actor.pose, `op "pose" "pose"`);
      const facing = op.args.face === undefined ? actor.facing : facingArg(op.args.face, actor.x, state, `op "pose" "face"`);
      if (pose === actor.pose && facing === actor.facing) fail(`op "pose": ${state.objectId}[${actor.id}] already holds "${pose}" facing ${sideName(facing)}, so nothing moves; pick a pose they are not in, or walk, turn or give`);
      return withActor(state, { ...actor, pose, facing });
    },
    act: (cue) => only(cue.op.parts[0]!, blending(cue, findActor(cue.before, cue.op.parts[0], cue.op.name), findActor(cue.after, cue.op.parts[0], cue.op.name), POSE_SECONDS)),
  },
  give: {
    doc: 'the first person in "on" hands what they hold (or "item") to the second; both turn to each other and reach. To a crowd, every member receives a copy. Optional "keep": true when the giver keeps theirs, as when authority is shared',
    seconds: () => GIVE_SECONDS,
    apply: (state, op) => handover(state, op, 0).state,
    act: (cue) => handing(cue, 0),
  },
  take: {
    doc: 'the first person in "on" reaches out and takes what the second holds (or "item")',
    seconds: () => GIVE_SECONDS,
    apply: (state, op) => handover(state, op, 1).state,
    act: (cue) => handing(cue, 1),
  },
  hold: {
    doc: `puts "item" in a person's hand: ${ITEMS.join(", ")}`,
    seconds: (op, state) => crowdSeconds(state, op, HOLD_SECONDS),
    apply(state, op) {
      const actor = onStage(findActor(state, op.parts[0], op.name), state, op.name);
      const item = oneOf(op.args.item, ITEMS, `op "hold" "item"`);
      return withActor(state, { ...actor, holding: item, pose: actor.pose === "stand" ? "hold" : actor.pose });
    },
    act(cue) {
      const after = findActor(cue.after, cue.op.parts[0], cue.op.name);
      return only(after.id, blending(cue, findActor(cue.before, cue.op.parts[0], cue.op.name), after, HOLD_SECONDS, (member, skeleton, u) => [shot(after, member, cue.setting, skeleton, { item: after.holding!, fade: u })]));
    },
  },
  drop: {
    doc: "a person lets what they hold fall to the ground",
    seconds: (op, state) => crowdSeconds(state, op, DROP_SECONDS),
    apply(state, op) {
      const actor = onStage(findActor(state, op.parts[0], op.name), state, op.name);
      if (!actor.holding) fail(`op "drop": ${state.objectId}[${actor.id}] holds nothing`);
      return withActor(state, { ...actor, holding: null, pose: actor.pose === "hold" ? "stand" : actor.pose });
    },
    act(cue) {
      const before = findActor(cue.before, cue.op.parts[0], cue.op.name);
      const after = findActor(cue.after, cue.op.parts[0], cue.op.name);
      return only(after.id, blending(cue, before, after, DROP_SECONDS, (member, skeleton) => {
        const release = standing(before, member, cue.setting, 0).near.hand;
        const t = clamp01(cue.progress * 1.25 - member.delay * 0.4);
        const fall = clamp01((t - 0.1) / 0.5) ** 2;
        const floor = groundOf(cue.setting, before, member)(release.x) - 14 * sizeOf(before, member);
        const at = { x: release.x + before.facing * 30 * fall, y: lerp(release.y, floor, fall) };
        return [shot(after, member, cue.setting, skeleton, { item: before.holding!, at, angle: 90 * fall, fade: 1 - clamp01((t - 0.65) / 0.35) })];
      }));
    },
  },
  say: {
    doc: `shows a person's real spoken "words" in a bubble, quoted from the sources, at most ${MAX_WORDS} words; never invent a line`,
    seconds: (op) => sayingSeconds(wordsOf(op)),
    apply(state, op) {
      onStage(findActor(state, op.parts[0], op.name), state, op.name);
      wordsOf(op);
      return state;
    },
    act(cue) {
      const actor = findActor(cue.after, cue.op.parts[0], cue.op.name);
      const words = wordsOf(cue.op);
      const seconds = sayingSeconds(words);
      const fade = Math.min(1, (cue.progress * seconds) / 0.25, ((1 - cue.progress) * seconds) / 0.3);
      const shots = membersOf(actor).map((member) => {
        const pose = restPose(actor, member, cue.clock);
        const talking = { ...pose, head: pose.head + 3 * Math.sin(cue.clock * 7 + member.seed * 9), arm: { ...pose.arm, a: pose.arm.a + 5 * Math.sin(cue.clock * 3.1) } };
        return shot(actor, member, cue.setting, standing(actor, member, cue.setting, cue.clock, talking), held(actor));
      });
      return only(actor.id, { actor, shots, speech: { words, fade }, glow: actor.tone === "lit" ? 1 : 0 });
    },
  },
  fire: {
    doc: `fires a gun from "things" (${GUNS.join(", ")}): flash, recoil, smoke and a shot that arcs to optional "at" (a mark, an x or a cast id) and bursts there`,
    seconds: () => FIRE_SECONDS,
    apply(state, op) {
      const gun = findThing(state, op.parts[0], op.name);
      if (!GUNS.includes(gun.kind)) fail(`op "fire": ${state.objectId}[${gun.id}] is a ${gun.kind}, which cannot fire: only a ${GUNS.join(", ")} fires`);
      if (!gun.on) fail(`op "fire": ${state.objectId}[${gun.id}] is not shown`);
      lineOfFire(state, gun, target(state, settingFor(state), op.args.at));
      return state;
    },
    act(cue) {
      const gun = findThing(cue.after, cue.op.parts[0], cue.op.name);
      return { things: new Map([[gun.id, { thing: gun, opacity: 1, fire: { progress: cue.progress, target: target(cue.after, cue.setting, cue.op.args.at) } }]]) };
    },
  },
  light: {
    doc: 'changes how a person or crowd stands out, by "tone": lead (gold, the protagonist), plain, dim or lit (spotlit); default lit',
    seconds: (op, state) => crowdSeconds(state, op, LIGHT_SECONDS),
    apply(state, op) {
      const actor = findActor(state, op.parts[0], op.name);
      return withActor(state, { ...actor, tone: op.args.tone === undefined ? "lit" : oneOf(op.args.tone, TONES, `op "light" "tone"`) });
    },
    act(cue) {
      const before = findActor(cue.before, cue.op.parts[0], cue.op.name);
      const after = findActor(cue.after, cue.op.parts[0], cue.op.name);
      const showing = blending(cue, before, after, LIGHT_SECONDS, (member, skeleton, u) => [
        ...(u < 1 ? [shot(after, member, cue.setting, skeleton, held(after), 1, before.tone, `m${member.index}~was`)] : []),
        shot(after, member, cue.setting, skeleton, held(after), u),
      ]);
      const u = smooth(cue.progress);
      return only(after.id, { ...showing, glow: (before.tone === "lit" ? 1 - u : 0) + (after.tone === "lit" ? u : 0) });
    },
  },
  appear: {
    doc: "fades a hidden person, crowd or thing into view where they stand",
    seconds: () => FADE_SECONDS,
    apply: (state, op) => shownAs(state, op, true),
    act: (cue) => fading(cue, true),
  },
  vanish: {
    doc: "fades a person, crowd or thing out of the scene, as when someone falls from power or dies",
    seconds: () => FADE_SECONDS,
    apply: (state, op) => shownAs(state, op, false),
    act: (cue) => fading(cue, false),
  },
};

function wrap(words: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of words.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, SPEECH_SIZE, "read") > SPEECH_WIDTH) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  lines.push(line);
  return lines;
}

interface Tag {
  showing: Showing;
  x: number;
  labelX: number;
  half: number;
  top: number;
  opacity: number;
}

interface FigureInk {
  showing: Showing;
  entry: Shot;
  drawables: Drawable[];
}

interface Obstacle {
  left: number;
  right: number;
  clear: number;
  weight: number;
}

interface Part {
  showing: Showing;
  own: boolean;
  solid: number;
  obstacle: Obstacle;
}

const TAG_ROW = LABEL_SIZE + 14;
const LABEL_CLEARANCE = 30;
const LABEL_MARGIN = 28;
const FAINT_INK = 0.25;
const INK_RAMP = 0.5;

const inkWeight = (opacity: number) => smooth(clamp01((opacity - FAINT_INK) / INK_RAMP));

function partOf(drawable: Drawable, weight: number): Obstacle | null {
  const { x, y, points, r, x2, y2 } = drawable;
  if (points) {
    const xs = points.filter((_, i) => i % 2 === 0);
    const ys = points.filter((_, i) => i % 2 === 1);
    return { left: Math.min(...xs), right: Math.max(...xs), clear: Math.min(...ys) - LABEL_CLEARANCE, weight };
  }
  if (r !== undefined) return { left: x - r, right: x + r, clear: y - r - LABEL_CLEARANCE, weight };
  if (x2 !== undefined && y2 !== undefined) return { left: Math.min(x, x2), right: Math.max(x, x2), clear: Math.min(y, y2) - LABEL_CLEARANCE, weight };
  return null;
}

function partsOf({ showing, entry, drawables }: FigureInk): Part[] {
  return drawables.flatMap((drawable) => {
    const solid = inkWeight(drawable.opacity ?? 1);
    const obstacle = solid > 0 ? partOf(drawable, inkWeight((drawable.opacity ?? 1) * entry.look.opacity)) : null;
    return obstacle ? [{ showing, own: !entry.key.endsWith("~was"), solid, obstacle }] : [];
  });
}

function tagOf(showing: Showing, own: Part[]): Tag | null {
  const visible = showing.shots.filter((entry) => !entry.key.endsWith("~was") && entry.look.opacity > 0.01);
  const body = own.filter((part) => part.solid >= 1);
  if (!visible.length || !body.length) return null;
  const front = visible.filter((entry) => entry.row === 0);
  const xs = (front.length ? front : visible).map((entry) => entry.skeleton.head.x);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const { label } = showing.actor;
  const half = label ? textWidth(label, LABEL_SIZE, "read") / 2 + LABEL_MARGIN : 0;
  return {
    showing,
    x,
    labelX: Math.min(STAGE_W - half, Math.max(half, x)),
    half,
    top: Math.min(...body.map((part) => part.obstacle.clear)),
    opacity: Math.max(...(front.length ? front : visible).map((entry) => entry.look.opacity)),
  };
}

function liftedOver(tag: Tag, obstacles: Obstacle[]): number {
  if (!tag.half) return tag.top;
  return obstacles.reduce((top, obstacle) => {
    const overlap = Math.min(tag.labelX + tag.half, obstacle.right) - Math.max(tag.labelX - tag.half, obstacle.left);
    if (overlap <= 0 || obstacle.clear >= tag.top) return top;
    return Math.min(top, lerp(tag.top, obstacle.clear, smooth(clamp01(overlap / LABEL_MARGIN)) * obstacle.weight));
  }, tag.top);
}

function overheads(figures: FigureInk[]): Drawable[] {
  const parts = figures.flatMap(partsOf);
  const showings = [...new Set(figures.map((figure) => figure.showing))];
  const tags = showings.flatMap((showing) => tagOf(showing, parts.filter((part) => part.showing === showing && part.own)) ?? []);
  const othersOf = (showing: Showing) => parts.filter((part) => part.showing !== showing).map((part) => part.obstacle);
  const placed: Obstacle[] = [];
  const out: Drawable[] = [];
  const speakers: { tag: Tag; speech: Speech }[] = [];
  for (const tag of tags.sort((a, b) => b.top - a.top)) {
    const { showing, labelX, half, opacity } = tag;
    const fading = parts.filter((part) => part.showing === showing && part.own && part.solid < 1).map((part) => ({ ...part.obstacle, weight: part.solid }));
    const top = liftedOver(tag, [...othersOf(showing), ...fading, ...placed]);
    const { actor, speech } = showing;
    if (actor.label) {
      const lead = actor.tone === "lead" || actor.tone === "lit";
      out.push({ id: `${actor.id}.label`, kind: "text", x: labelX, y: top - LABEL_SIZE / 2, text: actor.label, size: LABEL_SIZE, font: "read", fill: lead ? "accent" : "muted", stroke: "fill", strokeWidth: LABEL_HALO, opacity, z: TOP_Z });
      placed.push({ left: labelX - half, right: labelX + half, clear: top - TAG_ROW, weight: opacity });
    }
    if (speech && speech.fade > 0) speakers.push({ tag: { ...tag, top: actor.label ? top - TAG_ROW : top }, speech });
  }
  for (const { tag, speech } of speakers) {
    const balloon = balloonFor(speech, tag.x);
    const bottom = liftedOver({ ...tag, labelX: balloon.cx, half: balloon.w / 2 }, [...othersOf(tag.showing), ...placed]);
    out.push(...bubble(tag.showing.actor.id, balloon, speech, tag.x, bottom, tag.opacity));
    placed.push({ left: balloon.cx - balloon.w / 2, right: balloon.cx + balloon.w / 2, clear: bottom - SPEECH_TAIL - balloon.h - (TAG_ROW - LABEL_SIZE), weight: tag.opacity * speech.fade });
  }
  return out;
}

interface Balloon {
  lines: string[];
  w: number;
  h: number;
  cx: number;
}

function balloonFor(speech: Speech, x: number): Balloon {
  const lines = wrap(speech.words);
  lines[0] = `“${lines[0]}`;
  lines[lines.length - 1] = `${lines[lines.length - 1]}”`;
  const w = Math.max(...lines.map((line) => textWidth(line, SPEECH_SIZE, "read"))) + 64;
  return { lines, w, h: lines.length * SPEECH_LINE + 34, cx: Math.min(STAGE_W - w / 2 - 30, Math.max(w / 2 + 30, x)) };
}

function bubble(id: string, { lines, w, h, cx }: Balloon, speech: Speech, x: number, bottom: number, opacity: number): Drawable[] {
  const cy = bottom - SPEECH_TAIL - h / 2;
  const fade = opacity * speech.fade;
  const rise = (1 - speech.fade) * 16;
  const base = cy + h / 2 + rise;
  const tip = { x: Math.min(cx + w / 2 - 40, Math.max(cx - w / 2 + 40, x)), y: bottom + rise };
  const out: Drawable[] = [
    { id: `${id}.say.box`, kind: "rect", x: cx, y: cy + rise, w, h, radius: 28, fill: "fill2", stroke: "edge", strokeWidth: 3, opacity: fade, z: TOP_Z },
    { id: `${id}.say.tail`, kind: "path", x: 0, y: 0, points: [tip.x - 22, base - 3, tip.x + 22, base - 3, tip.x, tip.y], closed: true, fill: "fill2", stroke: "none", opacity: fade, z: TOP_Z },
    { id: `${id}.say.edge`, kind: "path", x: 0, y: 0, points: [tip.x - 22, base, tip.x, tip.y, tip.x + 22, base], fill: "none", stroke: "edge", strokeWidth: 3, opacity: fade, z: TOP_Z },
  ];
  lines.forEach((line, index) => out.push({
    id: `${id}.say.${index}`, kind: "text", x: cx, y: cy + rise + (index - (lines.length - 1) / 2) * SPEECH_LINE,
    text: line, size: SPEECH_SIZE, font: "read", fill: "ink", opacity: fade, z: TOP_Z,
  }));
  return out;
}

function pools(showing: Showing): Drawable[] {
  const glow = showing.glow ?? 0;
  if (glow <= 0) return [];
  return showing.shots.filter((entry) => !entry.key.endsWith("~was")).flatMap((entry) => {
    const { pelvis, scale } = entry.skeleton;
    const floor = entry.ground(pelvis.x);
    const fade = glow;
    return [
      { id: `${showing.actor.id}.${entry.key}.beam`, kind: "path", x: 0, y: 0, points: clipToStage([pelvis.x - 50 * scale, floor - 1100 * scale, pelvis.x + 50 * scale, floor - 1100 * scale, pelvis.x + 170 * scale, floor, pelvis.x - 170 * scale, floor]), closed: true, fill: "highlight", stroke: "none", opacity: 0.06 * fade, z: POOL_Z },
      { id: `${showing.actor.id}.${entry.key}.pool`, kind: "circle", x: pelvis.x, y: floor, r: 150 * scale, fill: "highlight", stroke: "none", opacity: 0.1 * fade, z: POOL_Z },
    ] satisfies Drawable[];
  });
}

function performances(state: StageState, running: { op: LabOp; before: StageState; after: StageState; progress: number }[], setting: Setting, clock: number) {
  const actors = new Map<string, { showing: Showing; done: boolean }>();
  const things = new Map<string, { showing: ThingShowing; done: boolean }>();
  for (const run of running) {
    const def = STAGE_OPS[run.op.name];
    if (!def) continue;
    const acting = def.act({ ...run, clock, setting });
    const done = run.progress >= 1;
    acting.actors?.forEach((showing, id) => {
      if (!actors.get(id) || actors.get(id)!.done) actors.set(id, { showing, done });
    });
    acting.things?.forEach((showing, id) => {
      if (!things.get(id) || things.get(id)!.done) things.set(id, { showing, done });
    });
  }
  return {
    actors: state.actors.flatMap((actor) => actors.get(actor.id)?.showing ?? (actor.on ? [resting(actor, setting, clock)] : [])),
    things: state.things.flatMap((thing) => things.get(thing.id)?.showing ?? (thing.on ? [{ thing, opacity: 1, fire: null }] : [])),
  };
}

function behindRank(entry: Shot, drawables: Drawable[]): Drawable[] {
  if (entry.cut === null) return drawables;
  const clip = { x: -STAGE_W, y: -STAGE_H, w: STAGE_W * 3, h: entry.cut + STAGE_H };
  return drawables.map((drawable) => ({ ...drawable, clip }));
}

function scene(state: StageState, running: { op: LabOp; before: StageState; after: StageState; progress: number }[], clock: number): Drawable[] {
  const setting = settingFor(state);
  const afloat = state.things.filter((thing) => BOATS.includes(thing.kind)).map((thing) => {
    const half = propSize(thing.kind, FIGURE_SCALE).w / 2;
    return [thing.x - half, thing.x + half] as const;
  });
  const out: Drawable[] = [...setting.draw(clock, afloat)];
  if (state.caption) out.push({ id: "caption", kind: "text", x: CENTER, y: 84, text: state.caption.toUpperCase(), size: CAPTION_SIZE, font: "read", fill: "muted", opacity: 0.9, z: TOP_Z });
  const shown = performances(state, running, setting, clock);
  shown.things.forEach(({ thing, opacity, fire }) => out.push(...drawProp(thing.id, placeOf(thing, state.things, setting), thingLook(opacity), clock, fire)));
  shown.actors.forEach((showing) => out.push(...pools(showing)));
  const figures: FigureInk[] = shown.actors
    .flatMap((showing) => showing.shots.map((entry) => ({ showing, entry })))
    .sort((a, b) => b.entry.row - a.entry.row)
    .map(({ showing, entry }) => ({ showing, entry, drawables: behindRank(entry, drawFigure({
      id: `${showing.actor.id}.${entry.key}`, skeleton: entry.skeleton, costume: COSTUMES[showing.actor.as], look: entry.look,
      holding: entry.holding ?? undefined, ground: entry.ground, clock,
    }, FIGURE_Z)) }));
  figures.forEach((figure) => out.push(...figure.drawables));
  out.push(...overheads(figures));
  return out;
}

function castFrom(spec: Record<string, unknown>, objectId: string, setting: Setting): Actor[] {
  const cast = record(spec.cast ?? fail(`${objectId}: a stage needs a "cast" of people by id`), `${objectId}: "cast"`);
  const entries = Object.entries(cast);
  if (!entries.length) fail(`${objectId}: "cast" needs at least one person`);
  return entries.map(([id, raw]) => {
    const where = `${objectId}[${id}]`;
    if (!ID.test(id) || RESERVED_IDS.includes(id)) fail(`${where}: a cast id is a plain name such as "napoleon" or "crowd"`);
    const field = record(raw, where);
    onlyKeys(field, CAST_KEYS, where);
    const off = field.at === "off left" || field.at === "off right";
    const x = markX(field.at ?? fail(`${where} needs "at": a mark or an x`), setting, `${where} "at"`);
    const count = integerField(field, "count", 1, 1, MAX_CROWD, where);
    const actor: Actor = {
      id,
      as: oneOf(field.as, COSTUME_NAMES, `${where} "as"`),
      x,
      facing: towardCenter(x),
      pose: poseArg(field.pose, "stand", `${where} "pose"`),
      holding: field.holding === undefined ? null : oneOf(field.holding, ITEMS, `${where} "holding"`),
      label: stringField(field, "label", where, ""),
      tone: field.tone === undefined ? "plain" : oneOf(field.tone, TONES, `${where} "tone"`),
      count,
      rows: integerField(field, "rows", Math.min(MAX_ROWS, Math.ceil(count / CROWD_ROW)), 1, MAX_ROWS, where),
      scale: rangeField(field, "scale", 1, 0.3, 1.3, where) * FIGURE_SCALE,
      on: !off && field.hidden !== true,
    };
    return off ? actor : { ...actor, x: inside(actor, x) };
  });
}

function thingsFrom(spec: Record<string, unknown>, objectId: string, setting: Setting): Thing[] {
  if (spec.things === undefined) return [];
  const things: Thing[] = [];
  for (const [id, raw] of Object.entries(record(spec.things, `${objectId}: "things"`))) {
    const where = `${objectId}[${id}]`;
    if (!ID.test(id) || RESERVED_IDS.includes(id)) fail(`${where}: a thing id is a plain name such as "gun"`);
    const field = record(raw, where);
    onlyKeys(field, THING_KEYS, where);
    const kind = oneOf(field.kind, PROP_NAMES, `${where} "kind"`);
    const support = field.atop === undefined ? null : supportOf(field.atop, things, objectId, where);
    const x = field.at === undefined && support ? support.x : markX(field.at ?? fail(`${where} needs "at": a mark or an x`), setting, `${where} "at"`);
    if (support) restsOn(kind, x, support, objectId, where);
    const facing = field.facing === undefined ? towardCenter(x) : oneOf(field.facing, SIDES, `${where} "facing"`) === "left" ? -1 : 1;
    things.push({ id, kind, x, facing, atop: support?.id ?? null, on: field.hidden !== true });
  }
  return things;
}

function supportOf(value: unknown, things: Thing[], objectId: string, where: string): Thing {
  const support = things.find((thing) => thing.id === value);
  const tops = things.filter((thing) => SURFACES.includes(thing.kind)).map((thing) => `"${thing.id}"`);
  if (!support) fail(`${where} "atop" must name a thing listed before it${tops.length ? `: ${tops.join(", ")}` : `, and only a ${SURFACES.join(", ")} has a top to rest on`}`);
  if (!SURFACES.includes(support.kind)) fail(`${where} "atop": ${objectId}[${support.id}] is a ${support.kind}, which has no flat top; things rest on a ${SURFACES.join(", ")}`);
  return support;
}

function restsOn(kind: PropName, x: number, support: Thing, objectId: string, where: string): void {
  const room = (propSize(support.kind, FIGURE_SCALE).w - propSize(kind, FIGURE_SCALE).w) / 2;
  if (room < 0) fail(`${where}: a ${kind} is wider than the ${support.kind} ${objectId}[${support.id}] and cannot rest on it`);
  if (Math.abs(x - support.x) > room) fail(`${where} hangs off the edge of ${objectId}[${support.id}]: keep "at" from ${Math.ceil(support.x - room)} to ${Math.floor(support.x + room)}, or leave "at" out to center it`);
}

function setsDoc(): string {
  return SET_NAMES.map((name) => {
    const own = Object.keys(settingOf(name, ["first", "second"]).marks).filter((mark) => !Object.hasOwn(GENERAL_MARKS, mark));
    return name === "ranks" ? `ranks (a staircase of "steps"; marks "step 1" upward)` : own.length ? `${name} (marks ${own.join(", ")})` : name;
  }).join(", ");
}

export const primitive: LabDef<Record<string, unknown>, StageState> = {
  id: "stage",
  title: "Acted scene",
  reading: "optional",
  concurrentParts: true,
  catalog: {
    summary: "An acted scene: line-drawn people on a set who walk on and off, turn, take poses, hand things to each other, speak real quoted words, fall, and fire cannon. Use it to show what happened with the people it happened to, rather than writing it as text. Cast order is drawing order, so list a crowd before the people who stand in front of it.",
    spec: {
      set: `the place: ${setsDoc()}. Every set also has the marks ${Object.keys(GENERAL_MARKS).map((mark) => `"${mark}"`).join(", ")}`,
      steps: 'ranks only: the step labels from the bottom up, at most 6, such as ["lieutenant","captain","general"]',
      caption: 'optional small line at the top naming place and year, such as "Toulon, 1793"',
      cast: `people by id: {"as": ${COSTUME_NAMES.join(", ")}; "at": a mark or an x from 0 to 2400 ("off left" or "off right" to wait offstage for "enter"); "label": optional name over the head; "facing": left, right or a cast id; "pose": ${POSE_NAMES.join(", ")}; "holding": ${ITEMS.join(", ")}; "tone": lead (the protagonist, gold), plain, dim or lit (spotlit); "count": up to ${MAX_CROWD} for a crowd or ranks of soldiers; "rows"; "scale" 0.3 to 1.3; "hidden": true to wait unseen for "appear"}`,
      things: `optional props by id, drawn at real size behind the people: {"kind": ${PROP_NAMES.join(", ")}; "at": a mark or an x; "atop": the id of a ${SURFACES.join(", ")} listed before it, to rest on its top ("at" then optional); "facing": left or right; "hidden": true}. A ${GUNS.join(", ")} can "fire". A ${BOATS.join(", ")} sits low in the water and bobs, and takes the place of any ship the set sketches behind it`,
    },
    example: [
      '{"scene":{"toulon":{"kind":"stage","set":"harbor","caption":"Toulon, 1793","cast":{"deputy":{"as":"deputy","at":"far right","label":"Saliceti","holding":"orb","facing":"left"},"bonaparte":{"as":"officer","at":"off left","label":"Bonaparte","tone":"lead"}},"things":{"gun":{"kind":"cannon","at":"battery","facing":"right"}}}},"do":[{"cue":"a young captain","op":"enter","on":["toulon[bonaparte]"],"to":"deputy"},{"cue":"gives him the guns","op":"give","on":["toulon[deputy]","toulon[bonaparte]"]},{"cue":"opens fire","op":"fire","on":["toulon[gun]"],"at":"sea"}]}',
    ],
  },
  ops: Object.fromEntries(Object.entries(STAGE_OPS).map(([name, op]) => [name, {
    doc: op.doc,
    seconds: (labOp: LabOp, state: StageState) => op.seconds(labOp, state),
    apply: (state: StageState, labOp: LabOp) => roomy(op.apply(state, labOp)),
    trueTime: true,
  }])),
  init(spec, objectId) {
    const set = oneOf(spec.set, SET_NAMES, `${objectId}: "set"`);
    const steps = spec.steps === undefined ? [] : spec.steps;
    if (!Array.isArray(steps) || !steps.every((step) => typeof step === "string") || steps.length > 6) fail(`${objectId}: "steps" must be a list of up to 6 step labels`);
    if (set === "ranks" && !steps.length) fail(`${objectId}: a ranks set needs "steps", the step labels from the bottom up`);
    const setting = settingFor({ set, steps });
    const actors = castFrom(spec, objectId, setting);
    const things = thingsFrom(spec, objectId, setting);
    const ids = [...actors, ...things].map((entry) => entry.id);
    const twice = ids.find((id, index) => ids.indexOf(id) !== index);
    if (twice) fail(`${objectId}[${twice}] is both in the cast and a thing: give each a different id`);
    const state: StageState = { objectId, set, steps, caption: stringField(spec, "caption", objectId, ""), actors, things };
    const cast = record(spec.cast, objectId);
    return roomy({
      ...state,
      actors: actors.map((actor) => {
        const facing = record(cast[actor.id], objectId).facing;
        return facing === undefined ? actor : { ...actor, facing: facingArg(facing, actor.x, state, `${objectId}[${actor.id}] "facing"`) };
      }),
    });
  },
  size: () => ({ w: STAGE_W, h: STAGE_H }),
  unfilled: (state) => !state.actors.some((actor) => actor.on),
  draw: (state) => scene(state, [], 0),
  live: (state, running, ctx) => scene(state, running, ctx.clock),
  credits: (state) => {
    const credit = propCredit(state.things.map((thing) => thing.kind));
    return credit ? [credit] : [];
  },
};
