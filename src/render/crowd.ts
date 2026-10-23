/**
 * [GFX-06] Crowd: a simple instanced crowd in the stands that reacts to events (section 8 "Look": "one stadium
 * with stands, a simple instanced crowd that reacts to events"; section 13: instanced, one draw call, no per-frame
 * allocation).
 *
 * WHAT IT DRAWS: one spectator per seat of the GFX-05 layout (stadium.ts generateSeats, ~15k seats) as ONE instanced
 * draw: a 2-triangle sprite per spectator, turned about its vertical axis to face the camera (cylindrical billboard
 * in the vertex shader), cut out of a tiny generated mask atlas (buildCrowdAtlas: front / back views, arms down / arms
 * up; masks for shirt, skin and hair, alpha-tested). Per instance: seat position, facing, section, phase, keenness,
 * shirt colour and skin tone. Unlit shader lit by crowdLightOf(look) so it matches the Lambert stands by day and at
 * night. When the camera is behind a spectator (near stand from a reverse angle) the back view is drawn.
 *
 * SECTIONS (seatSection): home fans (west end, its corners, most of both side stands), an away block (the far-east
 * corner with the adjoining far stand and east end), neutrals mixed in. Colours come from the resolved match kits
 * (kits.ts resolveMatchKits, clash check and high-contrast setting included): shirt, second shirt colour, shorts, with
 * neutral clothing for the rest. Skin tones vary.
 *
 * MOTION (vertex shader only; the CPU writes a handful of uniforms per frame, never per instance):
 *  - Idle: everyone seated (sunk into the row), a slow side-to-side sway with a per-fan phase.
 *  - Reactions, per section (home / away / neutral), from crowdLevels(): STAND (rise), JUMP (stand, bounce, arms up,
 *    a cheer wave running round the bowl), SIT (slump lower and darker). Events: GOAL -> the scoring side jumps and
 *    cheers, the other side slumps; SHOT -> the attacking side rises; NEAR_MISS / POST -> everybody rises, the
 *    attacking side most; SAVE -> the keeper's side cheers briefly, the shooters' side sits back; ATTACK_BUILD ->
 *    the attacking side gets up with the build-up intensity. Event times use the module's own clock (frame time,
 *    stopped while paused), so replays and pauses never retrigger or skip a reaction.
 *  - Quality tiers (GFX-02 getTierParams): crowdDensity draws that fraction of the spectators (instances are stored
 *    in a hashed order, so any prefix is an even thinning); crowdAnimation false (PERFORMANCE) freezes sway and bounce
 *    (reaction poses still show). setQuality applies a tier; update() also picks up a tier GFX-02 changed on its own
 *    (ctx.tier) without a broadcast.
 * Budget: 1 draw call; 2 triangles per spectator (~23k triangles at the default tier, limit 60k).
 * DEBUG: window.__dotkickCrowd (CrowdDebug).snapshot() reports instances, levels and excitement.
 */

import {
  BufferAttribute, Color, DataTexture, InstancedBufferAttribute, InstancedBufferGeometry, LinearFilter,
  LinearMipmapLinearFilter, Mesh, NoColorSpace, RGBAFormat, ShaderMaterial, Vector3, type WebGLRenderer,
} from 'three';
import { slotTeam } from '../contracts/constants';
import type { Club, Kit } from '../contracts/data';
import type { QualityTier } from '../contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../contracts/events';
import type { Settings } from '../contracts/settings';
import type { ReadonlySimState } from '../contracts/state';
import { resolveMatchKits } from './kits';
import { getTierParams } from './quality';
import {
  STAND_CORNER_FAR_EAST, STAND_CORNER_FAR_WEST, STAND_CORNER_NEAR_EAST, STAND_CORNER_NEAR_WEST, STAND_EAST, STAND_FAR,
  STAND_WEST, crowdLightOf, generateSeats, lookFor, type SeatLayout,
} from './stadium';
import type { RenderContext, RenderFrame, RenderModule } from './types';

export const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: GFX-06, render only)
  // ---- sprite (m)
  /** Sprite width (about one seat) and full height (standing with arms up fits inside). */
  spriteWidth: 0.72,
  spriteHeight: 1.44,
  /** How far a seated fan sinks into the row (m), and the extra slump of a dejected one. */
  seatedSink: 0.34,
  slumpSink: 0.16,
  // ---- idle and cheer motion
  /** Idle sway: amplitude at the head (m) and rate (rad/s). */
  swayAmp: 0.06,
  swayRate: 1.4,
  /** Cheer bounce height (m) and rate (rad/s; |sin| so ~2.4 jumps per second). */
  bounceHeight: 0.42,
  bounceRate: 7.5,
  /** Cheer wave round the bowl: lobes per turn and speed (rad/s). */
  waveLobes: 4,
  waveSpeed: 5,
  // ---- reaction envelopes: [rise, hold, fall] seconds, and levels 0..1
  goalEnv: [0.25, 6.0, 2.5] as readonly number[],
  goalSitEnv: [0.5, 5.5, 2.0] as readonly number[],
  /** Neutral fans' share of a goal cheer / of the attacking side's rise. */
  neutralShare: 0.5,
  shotEnv: [0.15, 0.8, 0.9] as readonly number[],
  shotAttack: 0.9,
  shotDefend: 0.3,
  missEnv: [0.2, 1.0, 1.4] as readonly number[],
  missAttack: 1.0,
  missDefend: 0.55,
  saveEnv: [0.2, 1.2, 1.0] as readonly number[],
  saveCheer: 0.55,
  saveSitEnv: [0.4, 1.4, 1.0] as readonly number[],
  saveSit: 0.45,
  /** ATTACK_BUILD: stand level per unit intensity, and decay per second. */
  buildStand: 0.55,
  buildDecay: 0.35,
  // ---- excitement smoothing (1/s) and frame clamp (s)
  excitementRise: 4,
  excitementFall: 0.8,
  maxDt: 0.1,
  // ---- sections (fractions of seats in a block that are that block's fans; the rest are neutral)
  homeEndShare: 0.92,
  sideHomeShare: 0.62,
  awayBlockShare: 0.9,
  eastHomeShare: 0.55,
  nearEastHomeShare: 0.5,
  /** Far stand x beyond which (and east-end z below which) the away block sits (m). */
  awayFarX: 28,
  awayEastZ: -10,
  // ---- colours: share of a team's fans in shirt / second colour / shorts colour (rest neutral clothing)
  shirtShare: 0.6,
  shirt2Share: 0.2,
  shortsShare: 0.08,
  /** Brightness variation (multiplier range). */
  shadeMin: 0.85,
  shadeMax: 1.1,
} as const;

/** Tuning (read-only) for tests and tools. */
export const CROWD_TUNING = LOCAL_TUNING;
const T = LOCAL_TUNING;

/** Fan sections (also the per-instance section value in the shader). Home = team 0, away = team 1. */
export const FAN_HOME = 0;
export const FAN_AWAY = 1;
export const FAN_NEUTRAL = 2;

/** Neutral clothing (sRGB). */
const NEUTRAL_CLOTHES: readonly number[] = [
  0x2b2f36, 0x5b6470, 0xe8e6e1, 0x1f3a5f, 0x3b5b8a, 0x7a3b2e, 0x556b2f, 0x8c6d46, 0x151515, 0xb04a5a, 0xd9b44a,
];
/** Skin tones (light, dark ends; sRGB) and hair (sRGB). */
const SKIN_LIGHT = 0xf1c7a5;
const SKIN_DARK = 0x5a3825;
const HAIR = 0x231a14;

// ============================================================ pure helpers

/** Integer hash -> [0, 1) (lowbias32). Deterministic, no state. */
export function hash01(i: number, salt = 0): number {
  let x = (i ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** Fan section of a seat (stand id, seat x / z, a per-seat hash in [0, 1)). Pure. */
export function seatSection(stand: number, x: number, z: number, h: number): number {
  switch (stand) {
    case STAND_WEST:
    case STAND_CORNER_FAR_WEST:
    case STAND_CORNER_NEAR_WEST:
      return h < T.homeEndShare ? FAN_HOME : FAN_NEUTRAL;
    case STAND_CORNER_FAR_EAST:
      return h < T.awayBlockShare ? FAN_AWAY : FAN_NEUTRAL;
    case STAND_EAST:
      if (z < T.awayEastZ) return h < T.awayBlockShare ? FAN_AWAY : FAN_NEUTRAL;
      return h < T.eastHomeShare ? FAN_HOME : FAN_NEUTRAL;
    case STAND_CORNER_NEAR_EAST:
      return h < T.nearEastHomeShare ? FAN_HOME : FAN_NEUTRAL;
    case STAND_FAR:
      if (x > T.awayFarX) return h < T.awayBlockShare ? FAN_AWAY : FAN_NEUTRAL;
      return h < T.sideHomeShare ? FAN_HOME : FAN_NEUTRAL;
    default: // near stand
      return h < T.sideHomeShare ? FAN_HOME : FAN_NEUTRAL;
  }
}

/**
 * Instance order: seat indices sorted by a hash, so the first n instances of any n are an even, random thinning of the
 * whole stadium (quality-tier density = draw a prefix). Pure, deterministic.
 */
export function crowdOrder(count: number): Uint32Array {
  const keys = new Float64Array(count);
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) { keys[i] = hash01(i, 11); idx[i] = i; }
  idx.sort((a, b) => keys[a]! - keys[b]! || a - b);
  return idx;
}

/** Instances drawn for a density 0..1 (clamped). */
export function instancesFor(total: number, density: number): number {
  const d = density > 1 ? 1 : density > 0 ? density : 0;
  return Math.round(total * d);
}

/** Static per-instance data in instance order: aSeat (x, y, z, section) and aFace (fx, fz, phase, keenness). */
export function fillCrowdStatic(seats: SeatLayout, order: Uint32Array, aSeat: Float32Array, aFace: Float32Array): void {
  for (let k = 0; k < order.length; k++) {
    const i = order[k]!;
    const o = k * 4;
    aSeat[o] = seats.x[i]!;
    aSeat[o + 1] = seats.y[i]!;
    aSeat[o + 2] = seats.z[i]!;
    aSeat[o + 3] = seatSection(seats.stand[i]!, seats.x[i]!, seats.z[i]!, hash01(i, 3));
    aFace[o] = seats.fx[i]!;
    aFace[o + 1] = seats.fz[i]!;
    aFace[o + 2] = hash01(i, 5);
    aFace[o + 3] = hash01(i, 7);
  }
}

const colourTmp = new Color();
/**
 * Per-instance colours (linear RGB shirt + skin tone 0..1) in instance order from the resolved kits: each team's fans
 * wear its shirt, second colour or shorts colour (T.shirtShare / shirt2Share / shortsShare), the rest neutral clothes.
 * aSeat must already hold the sections. Pure apart from writing aColour.
 */
export function fillCrowdColours(aSeat: Float32Array, kits: readonly [Kit, Kit], aColour: Float32Array, count: number): void {
  for (let k = 0; k < count; k++) {
    const o = k * 4;
    const section = aSeat[o + 3]!;
    const h = hash01(k, 13);
    let hex: number;
    if (section === FAN_HOME || section === FAN_AWAY) {
      const kit = kits[section]!;
      if (h < T.shirtShare) hex = kit.shirt;
      else if (h < T.shirtShare + T.shirt2Share) hex = kit.shirt2;
      else if (h < T.shirtShare + T.shirt2Share + T.shortsShare) hex = kit.shorts;
      else hex = NEUTRAL_CLOTHES[Math.floor(hash01(k, 17) * NEUTRAL_CLOTHES.length)]!;
    } else {
      hex = NEUTRAL_CLOTHES[Math.floor(h * NEUTRAL_CLOTHES.length)]!;
    }
    colourTmp.setHex(hex);
    const shade = T.shadeMin + (T.shadeMax - T.shadeMin) * hash01(k, 19);
    aColour[o] = Math.min(1, colourTmp.r * shade);
    aColour[o + 1] = Math.min(1, colourTmp.g * shade);
    aColour[o + 2] = Math.min(1, colourTmp.b * shade);
    aColour[o + 3] = hash01(k, 23);
  }
}

// ============================================================ sprite atlas

/** Atlas: 4 tiles of 32 x 64 texels side by side: 0 front arms down, 1 front arms up, 2 back arms down, 3 back arms up. */
export const ATLAS_W = 128;
export const ATLAS_H = 64;
export const ATLAS_TILES = 4;
const TILE_W = ATLAS_W / ATLAS_TILES;
const SS = 4; // supersamples per texel axis

function sdBox(px: number, py: number, cx: number, cy: number, hx: number, hy: number, r: number): number {
  const qx = Math.abs(px - cx) - hx + r, qy = Math.abs(py - cy) - hy + r;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCircle(px: number, py: number, cx: number, cy: number, r: number): number {
  const dx = px - cx, dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}
function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  const dx = pax - bax * h, dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/** Edge band (m) drawn darker so silhouettes read against each other. */
const OUTLINE = 0.02;
const OUTLINE_WEIGHT = 0.6;

/**
 * Classify one point of a spectator sprite (tile-local metres: x in [-w/2, w/2], y in [0, h], feet at y = 0).
 * Returns 0 empty, 1 shirt, 2 skin, 3 hair; writes the edge weight to edge[0]. Later shapes paint over earlier ones.
 */
function classify(x: number, y: number, back: boolean, armsUp: boolean, edge: Float64Array): number {
  let kind = 0;
  let d = 1;
  const take = (dist: number, k: number): void => {
    if (dist < 0) { kind = k; d = dist; }
  };
  const ax = Math.abs(x);
  take(sdBox(x, y, 0, 0.37, 0.22, 0.37, 0.08), 1); // torso
  if (armsUp) {
    take(sdCapsule(ax, y, 0.19, 0.66, 0.25, 1.06, 0.055), 1); // sleeves up
    take(sdCapsule(ax, y, 0.25, 1.06, 0.26, 1.3, 0.045), 2); // forearms and hands (inside the tile padding)
  } else {
    take(sdCapsule(ax, y, 0.235, 0.66, 0.265, 0.38, 0.055), 1); // sleeves down
    take(sdCircle(ax, y, 0.265, 0.33, 0.05), 2); // hands
  }
  take(sdBox(x, y, 0, 0.85, 0.05, 0.06, 0.0), 2); // neck
  const head = sdCircle(x, y, 0, 0.99, 0.125);
  if (head < 0) {
    // Front: hair cap above the brow; back: all hair.
    const hair = back || y > 1.03 + 0.02 * Math.cos(x * 12);
    take(head, hair ? 3 : 2);
  }
  edge[0] = kind !== 0 && d > -OUTLINE ? OUTLINE_WEIGHT : 1;
  return kind;
}

/**
 * The crowd mask atlas (RGBA8, ATLAS_W x ATLAS_H, row 0 = feet / v 0): R shirt, G skin, B hair weights premultiplied
 * by coverage, A coverage, 4 x 4 supersampled. Pure.
 */
export function buildCrowdAtlas(): Uint8Array {
  const data = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  const edge = new Float64Array(1);
  const mx = T.spriteWidth / TILE_W, my = T.spriteHeight / ATLAS_H;
  for (let tile = 0; tile < ATLAS_TILES; tile++) {
    const back = tile >= 2, armsUp = (tile & 1) === 1;
    for (let j = 0; j < ATLAS_H; j++) {
      for (let i = 0; i < TILE_W; i++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const x = (i + (sx + 0.5) / SS) * mx - T.spriteWidth / 2;
            const y = (j + (sy + 0.5) / SS) * my;
            const k = classify(x, y, back, armsUp, edge);
            if (k === 0) continue;
            a++;
            const w = edge[0]!;
            if (k === 1) r += w; else if (k === 2) g += w; else b += w;
          }
        }
        const n = SS * SS;
        const o = (j * ATLAS_W + tile * TILE_W + i) * 4;
        data[o] = Math.round((255 * r) / n);
        data[o + 1] = Math.round((255 * g) / n);
        data[o + 2] = Math.round((255 * b) / n);
        data[o + 3] = Math.round((255 * a) / n);
      }
    }
  }
  return data;
}

// ============================================================ reactions

/**
 * Event record (Float64Array, CROWD_EVENT_SLOTS): the crowd clock (EV_NOW), and per reaction kind the time (crowd
 * clock, s) and team of its latest event; the build-up level per team. Every per-frame function reads and writes it
 * (no double ever crosses a call boundary, so V8 never boxes one).
 */
export const EV_NOW = 0;
const EV_GOAL_T = 1, EV_GOAL_TEAM = 2, EV_SHOT_T = 3, EV_SHOT_TEAM = 4, EV_MISS_T = 5, EV_MISS_TEAM = 6;
const EV_SAVE_T = 7, EV_SAVE_TEAM = 8, EV_BUILD0 = 9, EV_BUILD1 = 10;
export const CROWD_EVENT_SLOTS = 11;
const NEVER = -1e9;

/** Reset an event record (no reactions pending; the clock is kept). */
export function resetCrowdEvents(ev: Float64Array): void {
  ev[EV_GOAL_T] = NEVER; ev[EV_SHOT_T] = NEVER; ev[EV_MISS_T] = NEVER; ev[EV_SAVE_T] = NEVER;
  ev[EV_GOAL_TEAM] = 0; ev[EV_SHOT_TEAM] = 0; ev[EV_MISS_TEAM] = 0; ev[EV_SAVE_TEAM] = 0;
  ev[EV_BUILD0] = 0; ev[EV_BUILD1] = 0;
}

/** Set the crowd clock (s) the next recordCrowdEvent / crowdLevels use. */
export function setCrowdClock(ev: Float64Array, now: number): void {
  ev[EV_NOW] = now;
}

/** Trapezoid envelope: 0 before 0, ramps up over rise, holds, ramps down over fall, 0 after. Pure. */
export function envelope(age: number, env: readonly number[]): number {
  const rise = env[0]!, hold = env[1]!, fall = env[2]!;
  if (!(age >= 0)) return 0;
  if (age < rise) return age / rise;
  if (age < rise + hold) return 1;
  const t = age - rise - hold;
  return t < fall ? 1 - t / fall : 0;
}

/** The fields of a sim event the crowd reads. */
export type CrowdEvent = Pick<SimEvent, 'type' | 'a' | 'c'>;

/**
 * Record one sim event at the crowd clock (ev[EV_NOW]). Needs the state for POST (which team attacks that end).
 * Returns true when the crowd reacts to the event. No allocation.
 */
export function recordCrowdEvent(ev: Float64Array, e: Readonly<CrowdEvent>, state: ReadonlySimState | null): boolean {
  const a = e.a;
  switch (e.type) {
    case EventType.GOAL:
      ev[EV_GOAL_T] = ev[EV_NOW]!; ev[EV_GOAL_TEAM] = a === 1 ? 1 : 0;
      return true;
    case EventType.SHOT:
      if (a < 0) return false;
      ev[EV_SHOT_T] = ev[EV_NOW]!; ev[EV_SHOT_TEAM] = slotTeam(a);
      return true;
    case EventType.NEAR_MISS:
      if (a < 0) return false;
      ev[EV_MISS_T] = ev[EV_NOW]!; ev[EV_MISS_TEAM] = slotTeam(a);
      return true;
    case EventType.POST: {
      // a = end (-1 / +1): the team attacking that end.
      const t0 = state ? state.teams[0]!.dir : 1;
      ev[EV_MISS_T] = ev[EV_NOW]!; ev[EV_MISS_TEAM] = t0 === (a < 0 ? -1 : 1) ? 0 : 1;
      return true;
    }
    case EventType.SAVE:
      if (a < 0) return false;
      ev[EV_SAVE_T] = ev[EV_NOW]!; ev[EV_SAVE_TEAM] = slotTeam(a);
      return true;
    case EventType.ATTACK_BUILD: {
      const slot = a === 1 ? EV_BUILD1 : EV_BUILD0;
      const c = e.c;
      if (c > ev[slot]!) ev[slot] = c > 1 ? 1 : c;
      return true;
    }
    default:
      return false;
  }
}

/** Levels layout: [stand home, away, neutral, jump home, away, neutral, sit home, away, neutral]. */
export const LV_STAND = 0;
export const LV_JUMP = 3;
export const LV_SIT = 6;
export const CROWD_LEVELS = 9;

/**
 * Reaction table, one row per (event kind, envelope): time slot, team slot, envelope [rise, hold, fall] and nine
 * weights [stand, jump, sit] x [the event's team, the other team, neutrals]. Built once from LOCAL_TUNING.
 */
const R_TIME = [EV_GOAL_T, EV_GOAL_T, EV_SHOT_T, EV_MISS_T, EV_SAVE_T, EV_SAVE_T];
const R_TEAM = [EV_GOAL_TEAM, EV_GOAL_TEAM, EV_SHOT_TEAM, EV_MISS_TEAM, EV_SAVE_TEAM, EV_SAVE_TEAM];
const R_ENV = new Float64Array([...T.goalEnv, ...T.goalSitEnv, ...T.shotEnv, ...T.missEnv, ...T.saveEnv, ...T.saveSitEnv]);
const R_W = new Float64Array([
  // stand: team, other, neutral | jump: team, other, neutral | sit: team, other, neutral
  0, 0, 0, 1, 0, T.neutralShare, 0, 0, 0, // goal: scorers cheer, neutrals half
  0, 0, 0, 0, 0, 0, 0, 1, 0, // goal: the other side slumps
  T.shotAttack, T.shotDefend, T.shotAttack * T.neutralShare, 0, 0, 0, 0, 0, 0, // shot
  T.missAttack, T.missDefend, (T.missAttack + T.missDefend) / 2, 0, 0, 0, 0, 0, 0, // near miss / woodwork
  0, 0, 0, T.saveCheer, 0, 0, 0, 0, 0, // save: keeper's side cheers
  0, 0, 0, 0, 0, 0, 0, T.saveSit, 0, // save: shooters' side sits back
]);
const REACTIONS = R_TIME.length;

/**
 * Reaction levels 0..1 per section at the crowd clock ev[EV_NOW] (see LV_*). One loop over the reaction table, no
 * calls: allocation-free in optimised code. Pure apart from writing out.
 */
export function crowdLevels(ev: Float64Array, out: Float32Array): Float32Array {
  out.fill(0);
  const now = ev[EV_NOW]!;
  for (let r = 0; r < REACTIONS; r++) {
    const age = now - ev[R_TIME[r]!]!;
    if (!(age >= 0)) continue;
    const rise = R_ENV[r * 3]!, hold = R_ENV[r * 3 + 1]!, fall = R_ENV[r * 3 + 2]!;
    let g = 0;
    if (age < rise) g = age / rise;
    else if (age < rise + hold) g = 1;
    else if (age < rise + hold + fall) g = 1 - (age - rise - hold) / fall;
    if (g <= 0) continue;
    const team = ev[R_TEAM[r]!] === 1 ? 1 : 0;
    for (let q = 0; q < 3; q++) {
      for (let role = 0; role < 3; role++) {
        const w = R_W[r * 9 + q * 3 + role]!;
        if (w === 0) continue;
        const section = role === 0 ? team : role === 1 ? 1 - team : FAN_NEUTRAL;
        const idx = q * 3 + section;
        const v = g * w;
        if (v > out[idx]!) out[idx] = v;
      }
    }
  }
  // Attack build-up.
  const b0 = ev[EV_BUILD0]! * T.buildStand, b1 = ev[EV_BUILD1]! * T.buildStand;
  if (b0 > out[LV_STAND]!) out[LV_STAND] = b0;
  if (b1 > out[LV_STAND + 1]!) out[LV_STAND + 1] = b1;
  const bn = (b0 > b1 ? b0 : b1) * T.neutralShare;
  if (bn > out[LV_STAND + FAN_NEUTRAL]!) out[LV_STAND + FAN_NEUTRAL] = bn;
  // A cheer overrides sitting back for the same side (e.g. a goal right after a save).
  for (let sec = 0; sec < 3; sec++) if (out[LV_JUMP + sec]! > out[LV_SIT + sec]!) out[LV_SIT + sec] = 0;
  return out;
}

/** Decay the build-up levels over `dt` seconds (tests and tools; update() does the same inline). */
export function decayCrowdBuild(ev: Float64Array, dt: number): void {
  const k = T.buildDecay * dt;
  ev[EV_BUILD0] = Math.max(0, ev[EV_BUILD0]! - k);
  ev[EV_BUILD1] = Math.max(0, ev[EV_BUILD1]! - k);
}

/** Overall excitement target 0..1 from levels (highest stand or jump of any section). Pure. */
export function excitementOf(levels: Float32Array): number {
  let e = 0;
  for (let i = 0; i < 6; i++) if (levels[i]! > e) e = levels[i]!;
  return e;
}

// ============================================================ shaders

function f(n: number): string {
  const s = String(n);
  return s.includes('.') || s.includes('e') ? s : `${s}.0`;
}

export function crowdVertexShader(): string {
  return /* glsl */ `
attribute vec4 aSeat;
attribute vec4 aFace;
attribute vec4 aColour;
uniform float uTime;
uniform float uAnim;
uniform vec3 uStand;
uniform vec3 uJump;
uniform vec3 uSit;
varying vec2 vUv;
varying vec3 vShirt;
varying float vSkin;
varying float vShade;

float pick(vec3 v, float s) { return s < 0.5 ? v.x : (s < 1.5 ? v.y : v.z); }

void main() {
  float section = aSeat.w;
  float phase = aFace.z * 6.2831853;
  float keen = aFace.w;
  float jump = clamp(pick(uJump, section) * (0.75 + 0.5 * keen), 0.0, 1.0);
  float sit = pick(uSit, section);
  float stand = clamp(pick(uStand, section) * (0.6 + 0.8 * keen), 0.0, 1.0);
  float up = max(stand, jump) * (1.0 - sit);
  float sink = ${f(T.seatedSink)} * (1.0 - up) + ${f(T.slumpSink)} * sit;
  float ang = atan(aSeat.z, aSeat.x);
  float wave = 0.6 + 0.4 * sin(ang * ${f(T.waveLobes)} - uTime * ${f(T.waveSpeed)});
  float beat = uTime * ${f(T.bounceRate)} + phase;
  float bounce = abs(sin(beat)) * jump * wave * ${f(T.bounceHeight)} * uAnim;
  float sway = sin(uTime * ${f(T.swayRate)} + phase) * ${f(T.swayAmp)} * uAnim * (1.0 - jump);
  float armsUp = step(0.45 - 0.25 * keen, jump) * max(1.0 - uAnim, step(-0.35, sin(beat * 0.5 + 1.3)));
  vec2 toCam = cameraPosition.xz - aSeat.xz;
  float tl = length(toCam);
  vec2 dir = tl > 1e-4 ? toCam / tl : aFace.xy;
  float back = step(dot(dir, aFace.xy), 0.0);
  float tile = back * 2.0 + armsUp;
  vec3 right = vec3(dir.y, 0.0, -dir.x);
  vec3 p = aSeat.xyz + right * (position.x * ${f(T.spriteWidth)} + sway * position.y)
    + vec3(0.0, position.y * ${f(T.spriteHeight)} - sink + bounce, 0.0);
  vUv = vec2((tile + position.x + 0.5) * ${f(1 / ATLAS_TILES)}, position.y);
  vShirt = aColour.rgb;
  vSkin = aColour.a;
  vShade = (0.88 + 0.12 * keen) * (1.0 - 0.2 * sit);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
}

export function crowdFragmentShader(): string {
  return /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uLight;
uniform vec3 uSkinLight;
uniform vec3 uSkinDark;
uniform vec3 uHair;
varying vec2 vUv;
varying vec3 vShirt;
varying float vSkin;
varying float vShade;
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  if (t.a < 0.5) discard;
  vec3 skin = mix(uSkinLight, uSkinDark, vSkin);
  vec3 c = (vShirt * t.r + skin * t.g + uHair * t.b) / t.a;
  gl_FragColor = vec4(c * uLight * vShade, 1.0);
  #include <colorspace_fragment>
}
`;
}

// ============================================================ module

/**
 * A float uniform with its own hidden class. A plain { value } literal shares its map with the texture and vector
 * uniforms, so its field is tagged and every per-frame write of a double would allocate a HeapNumber; this class's
 * field holds a double that is updated in place.
 */
class FloatUniform {
  // Initialised with a double literal: under ES2022 class-field semantics a bare declaration would start as undefined
  // and make the field tagged.
  value = 0.5;
  constructor(v: number) { this.value = v; }
}

export interface CrowdSnapshot {
  visible: boolean;
  seats: number;
  instances: number;
  density: number;
  animated: boolean;
  triangles: number;
  drawCalls: number;
  excitement: number;
  /** Levels (LV_* layout). */
  levels: number[];
  clock: number;
  night: boolean;
}

/** Debug hook (window.__dotkickCrowd). */
export interface CrowdDebug {
  snapshot(): CrowdSnapshot;
}

declare global {
  interface Window {
    __dotkickCrowd?: CrowdDebug;
  }
}

export interface CrowdModule extends RenderModule {
  /** Current excitement 0..1 (smoothed), for diagnostics and audio sync. */
  readonly excitement: number;
  readonly mesh?: Mesh;
  readonly debug?: CrowdDebug;
}

export function createCrowd(ctx: RenderContext): CrowdModule {
  const seats = generateSeats();
  const total = seats.count;
  const order = crowdOrder(total);
  const aSeat = new Float32Array(total * 4);
  const aFace = new Float32Array(total * 4);
  const aColour = new Float32Array(total * 4);
  fillCrowdStatic(seats, order, aSeat, aFace);

  const geo = new InstancedBufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 2, 1, 3]);
  geo.setAttribute('aSeat', new InstancedBufferAttribute(aSeat, 4));
  geo.setAttribute('aFace', new InstancedBufferAttribute(aFace, 4));
  const colourAttr = new InstancedBufferAttribute(aColour, 4);
  geo.setAttribute('aColour', colourAttr);

  const atlas = new DataTexture(buildCrowdAtlas(), ATLAS_W, ATLAS_H, RGBAFormat);
  atlas.name = 'crowd-atlas';
  atlas.colorSpace = NoColorSpace;
  atlas.flipY = false;
  atlas.magFilter = LinearFilter;
  atlas.minFilter = LinearMipmapLinearFilter;
  atlas.generateMipmaps = true;
  atlas.needsUpdate = true;

  const uniforms = {
    uAtlas: { value: atlas },
    uTime: new FloatUniform(0.5),
    uAnim: new FloatUniform(1.5),
    uStand: { value: new Vector3() },
    uJump: { value: new Vector3() },
    uSit: { value: new Vector3() },
    uLight: { value: new Color(1, 1, 1) },
    uSkinLight: { value: new Color(SKIN_LIGHT) },
    uSkinDark: { value: new Color(SKIN_DARK) },
    uHair: { value: new Color(HAIR) },
  };
  uniforms.uTime.value = 0;
  uniforms.uAnim.value = 1;
  const mat = new ShaderMaterial({
    name: 'crowd', uniforms, vertexShader: crowdVertexShader(), fragmentShader: crowdFragmentShader(),
  });
  const mesh = new Mesh(geo, mat);
  mesh.name = 'crowd';
  mesh.frustumCulled = false; // the vertex shader places every instance
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.visible = false;
  ctx.scene.add(mesh);

  const ev = new Float64Array(CROWD_EVENT_SLOTS);
  resetCrowdEvents(ev);
  const levels = new Float32Array(CROWD_LEVELS);
  // Doubles live in typed arrays (closure variables holding doubles would box on every write); the crowd clock is
  // ev[EV_NOW].
  const S_EXCITEMENT = 0, S_DENSITY = 1;
  const st = new Float64Array(2);
  st[S_DENSITY] = 1;
  let animated = true;
  /** Tier last applied (-1 = none); update() re-applies when ctx.tier changed without a setQuality call. */
  let tierApplied = -1;
  let matchState: ReadonlySimState | null = null;
  let matchClubs: readonly Club[] = [];
  let highContrast = ctx.settings.accessibility.highContrastKits;

  function applyTier(tier: QualityTier): void {
    tierApplied = tier;
    const p = getTierParams(tier);
    st[S_DENSITY] = p.crowdDensity;
    animated = p.crowdAnimation;
    geo.instanceCount = instancesFor(total, p.crowdDensity);
    uniforms.uAnim.value = animated ? 1 : 0;
  }

  function recolour(): void {
    if (!matchState) return;
    const kits = resolveMatchKits(matchState, matchClubs, highContrast);
    fillCrowdColours(aSeat, kits.outfield, aColour, total);
    colourAttr.needsUpdate = true;
  }

  function resetReactions(): void {
    resetCrowdEvents(ev);
    levels.fill(0);
    st[S_EXCITEMENT] = 0;
    uniforms.uStand.value.set(0, 0, 0);
    uniforms.uJump.value.set(0, 0, 0);
    uniforms.uSit.value.set(0, 0, 0);
  }

  const debug: CrowdDebug = {
    snapshot(): CrowdSnapshot {
      return {
        visible: mesh.visible, seats: total, instances: geo.instanceCount, density: st[S_DENSITY]!, animated,
        triangles: mesh.visible ? geo.instanceCount * 2 : 0, drawCalls: mesh.visible ? 1 : 0,
        excitement: st[S_EXCITEMENT]!, levels: Array.from(levels), clock: ev[EV_NOW]!, night: ctx.night,
      };
    },
  };
  if (typeof window !== 'undefined') window.__dotkickCrowd = debug;

  applyTier(ctx.tier);

  return {
    get excitement() { return st[S_EXCITEMENT]!; },
    mesh,
    debug,

    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      matchState = state;
      matchClubs = clubs;
      highContrast = ctx.settings.accessibility.highContrastKits;
      recolour();
      crowdLightOf(lookFor(ctx.night), uniforms.uLight.value);
      applyTier(ctx.tier);
      resetReactions();
      ev[EV_NOW] = 0;
      uniforms.uTime.value = 0;
      mesh.visible = true;
    },

    update(fr: RenderFrame) {
      if (ctx.tier !== tierApplied) applyTier(ctx.tier);
      let dt = fr.frame.paused ? 0 : fr.frame.dtMs / 1000;
      if (!(dt > 0)) dt = 0;
      if (dt > T.maxDt) dt = T.maxDt;
      ev[EV_NOW] += dt;
      const k = T.buildDecay * dt;
      ev[EV_BUILD0] = Math.max(0, ev[EV_BUILD0]! - k);
      ev[EV_BUILD1] = Math.max(0, ev[EV_BUILD1]! - k);
      crowdLevels(ev, levels);
      uniforms.uTime.value = ev[EV_NOW]!;
      // Field stores, not Vector3.set: no double crosses a call.
      const vs = uniforms.uStand.value, vj = uniforms.uJump.value, vt = uniforms.uSit.value;
      vs.x = levels[LV_STAND]!; vs.y = levels[LV_STAND + 1]!; vs.z = levels[LV_STAND + 2]!;
      vj.x = levels[LV_JUMP]!; vj.y = levels[LV_JUMP + 1]!; vj.z = levels[LV_JUMP + 2]!;
      vt.x = levels[LV_SIT]!; vt.y = levels[LV_SIT + 1]!; vt.z = levels[LV_SIT + 2]!;
      let target = 0;
      for (let i = 0; i < LV_SIT; i++) if (levels[i]! > target) target = levels[i]!;
      const e = st[S_EXCITEMENT]!;
      const rate = target > e ? T.excitementRise : T.excitementFall;
      st[S_EXCITEMENT] = e + (target - e) * (1 - Math.exp(-rate * dt));
    },

    onEvents(events: EventBuffer, state: ReadonlySimState) {
      for (let i = 0; i < events.count; i++) {
        recordCrowdEvent(ev, events.get(i), state);
      }
    },

    warmUp() {
      const r = ctx.renderer as WebGLRenderer | null;
      if (r && typeof r.initTexture === 'function') r.initTexture(atlas);
    },

    setQuality(tier: QualityTier) {
      applyTier(tier);
    },

    onSettings(s: Readonly<Settings>) {
      const hc = s.accessibility.highContrastKits;
      if (hc === highContrast) return;
      highContrast = hc;
      recolour();
    },

    clearMatch() {
      mesh.visible = false;
      matchState = null;
      resetReactions();
    },

    dispose() {
      ctx.scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      atlas.dispose();
      if (typeof window !== 'undefined' && window.__dotkickCrowd === debug) delete window.__dotkickCrowd;
    },
  };
}
