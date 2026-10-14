/**
 * [GFX-07] Player model and instancing (section 8 "Look": players built in code from simple parts and animated
 * procedurally; section 13 "Instancing": one InstancedMesh per body part for all 22 players, per-instance transform
 * and colour, kits and numbers from a generated atlas).
 *
 * PARTS (parts.ts): head + neck + hair, torso (shirt), pelvis (shorts), upper arm (sleeve), forearm + hand, thigh
 * (shorts leg), shin (sock), boot. One InstancedMesh per part: 22 instances, or 44 for left / right limbs
 * (index = slot * 2 + side, side 0 left, 1 right). 8 draw calls and about 1,120 triangles per player (~24.7k for
 * 22; budget 14 calls and 30k triangles).
 * Lambert materials (one directional light + ambient from the stadium), patched in onBeforeCompile:
 *   - every part has per-instance colours A and B; the per-vertex selector aSel picks one (crisp kit regions);
 *   - the torso shader draws the kit pattern (plain, stripes, hoops, halves, sash: section 8) procedurally in torso
 *     space with derivative anti-aliasing (no shimmer at distance), a collar trim, and the shirt number on the back
 *     from a glyph atlas (NumberAtlas: RGB white fill / black outline, premultiplied alpha coverage). The default
 *     atlas is GFX-08's generated one (kits.ts createKitNumberAtlas: digits drawn in code, no font, same pixels in
 *     every browser); setNumberAtlas can replace it.
 * Kit colours come from resolveMatchKits (GFX-08 clash check, with Settings > Accessibility > high-contrast kits;
 * re-resolved when that setting changes): outfield or keeper kit per slot (keepers wear long sleeves and gloves),
 * shorts, socks, number colour. The resolved kits are exposed as PlayerModelModule.kits. Skin, hair and boot colours vary per player (seeded by club and
 * squad index; render-only).
 *
 * PER FRAME (no allocation): the pose driver writes one Pose per slot through setPose (default: the GFX-12 mapper's
 * mapAnim / advanceCycle / samplePose with a distance-driven stride cycle that ignores teleports; GFX-12 / the
 * lead can install a richer driver with setPoseDriver); then per slot forward kinematics (fk.ts) from the Pose,
 * ground correction (nothing sinks into the grass; small floats of grounded poses are planted), height scaling
 * (attrs.height / 180), world placement from the interpolated position and facing (frame.interp), and one instance
 * matrix per part. Sent-off (inactive) players and non-finite positions collapse to a zero matrix (not drawn).
 *
 * DEBUG (e2e, pose viewer for GFX-09..12): window.__dotkickPlayers (PlayerModelDebug): close-up camera on a slot,
 * hold a pose or a clip on a slot, joint positions, mesh info.
 */

import {
  Color, DataTexture, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, MeshLambertMaterial, RGBAFormat,
  Vector3, type BufferGeometry, type Texture,
} from 'three';
import { NUM_SLOTS } from '../../contracts/constants';
import type { Club, Kit } from '../../contracts/data';
import { ActionKind, KitPattern, type QualityTier } from '../../contracts/enums';
import { AnimId, createPose, POSE_SIZE, type Pose } from '../../contracts/render';
import type { Settings } from '../../contracts/settings';
import type { ReadonlySimState } from '../../contracts/state';
import { advanceCycle, createAnimBank, createAnimDriver, createAnimSample, mapAnim, poseFnFor, samplePose } from '../anim/mapper';
import { createKitNumberAtlas, resolveMatchKits, type KitNumberAtlas, type MatchKits } from '../kits';
import { getTierParams } from '../quality';
import type { RenderContext, RenderFrame, RenderModule } from '../types';
import {
  BODY, createSkeleton, FRAME_SIZE, groundSkeleton, Joint, JOINT_COUNT, PLACE_SIZE, placeSkeleton, solvePoseFK,
  writeHiddenMatrix, writeJointMatrix,
} from './fk';
import { buildPartGeometry, NUMBER_PANEL, Part, PART_COUNT, PART_NAMES, PART_PAIRED, TORSO_Y0, TORSO_Y1, trianglesPerPlayer } from './parts';

export {
  BODY, CONTACT_POINTS, createSkeleton, footPoint, FRAME_SIZE, GROUND_SNAP_MAX, groundLift, groundSkeleton, handPoint,
  Joint, JOINT_COUNT, liftSkeleton, lowestPoint, placeSkeleton, placeSkeletonAt, SKELETON_SIZE, solvePoseFK,
} from './fk';

const LOCAL_TUNING = { // TUNING-CR (render-only; the ground snap distance lives in fk.ts)
  /** Interpolated travel above this in one frame is a teleport (restart, replay cut): no stride advance (m). */
  teleportDist: 3,
  /** Player height scale clamp (attrs.height / 180). */
  minScale: 0.85,
  maxScale: 1.2,
  /** Debug close-up camera defaults: distance (m), eye height (m), look-at height (m). */
  closeUpDist: 6.5,
  closeUpEyeY: 1.7,
  closeUpLookY: 1.0,
  // ---- foot lock [INT-C]
  /** A boot point this close to the grass (m) is planted. */
  lockGroundY: 0.003,
  /** Only players moving faster than this (m/s) and in no action get the lock. */
  lockMinSpeed: 0.8,
  /** Largest visual offset from the sim position the lock may build (m). */
  lockMaxOffset: 0.3,
  /** The offset eases back to the sim position with this time constant while a boot is locked / otherwise (s). */
  lockReturnLocked: 1.2,
  lockReturnFree: 0.08,
  /** Interpolated travel above this in one frame drops the lock (restart placement, replay cut) (m). */
  lockTeleport: 1.5,
} as const;

/** Legacy envelope of a 180 cm player (m), kept from the Wave 0 capsule: radius and height. */
export const CAPSULE_RADIUS = 0.27;
export const CAPSULE_HEIGHT = 1.8;

// ============================================================ public types

/** Receives poses (GFX-12 writes one per slot per frame). */
export interface PoseSink {
  /** Copy `pose` (POSE_SIZE values, contracts/render.ts PoseIdx) into the slot's pose buffer. No allocation. */
  setPose(slot: number, pose: ArrayLike<number>): void;
}

/** Writes the pose of every active slot for this frame (called first in the model's update). Must not allocate. */
export type PoseDriver = (f: RenderFrame, sink: PoseSink) => void;

/**
 * Shirt-number glyphs. GFX-08's kit atlas can implement this; the model builds a small fallback atlas of its own
 * (numbers 1..99) when none is set.
 */
export interface NumberAtlas {
  readonly texture: Texture;
  /**
   * UV rect (u0, v0, u1, v1 with v up, i.e. v0 is the bottom edge) of the glyph for shirt number n (1..99) written
   * to out[o..o+3]. Glyph cell: RGB white fill and black outline, alpha = coverage; the texture must be uploaded
   * with premultiplied alpha. False when there is no glyph for n.
   */
  glyphRect(n: number, out: Float32Array | number[], o: number): boolean;
}

export interface PlayerModelModule extends RenderModule, PoseSink {
  /** The torso (shirt) mesh: the main per-player mesh (kept from the Wave 0 interface). */
  readonly mesh: InstancedMesh;
  /** Every part mesh in Part order (head, torso, pelvis, upper arm, lower arm, upper leg, lower leg, boot). */
  readonly meshes: readonly InstancedMesh[];
  /** Parent of every part mesh (named 'players'). */
  readonly group: Group;
  /** Pose buffer per slot (what is drawn this frame). Read-only for others. */
  readonly poses: readonly Pose[];
  /** World joint frames per slot after the last update (fk.ts layout, Joint indices). Read-only for others. */
  readonly skeletons: readonly Float64Array[];
  /**
   * Kits the players wear (GFX-08 clash check, with the high-contrast setting), null before setMatch. Read-only:
   * the HUD / radar can take team colours from here so they match the pitch.
   */
  readonly kits: MatchKits | null;
  /** Install the animation driver (GFX-12); null restores the default (mapper stub API). */
  setPoseDriver(driver: PoseDriver | null): void;
  /** Use a shirt-number atlas (GFX-08); null restores the built-in fallback. */
  setNumberAtlas(atlas: NumberAtlas | null): void;
}

/** Debug hook (window.__dotkickPlayers). */
export interface PlayerModelDebug {
  /**
   * Close-up camera on a slot (slot < 0 turns it off): distance (m), angle around the player in degrees from his
   * front (0 = facing the camera, 180 = his back), eye height (m). Overrides ctx.camera after the cameras ran.
   */
  closeUp(slot: number, dist?: number, angleDeg?: number, eyeY?: number): void;
  /** Hold a pose on a slot (POSE_SIZE values) or release it (null). */
  holdPose(slot: number, pose: ArrayLike<number> | null): void;
  /** Hold a clip on a slot through the mapper's pose table (GFX-09..11): phase t, stride cycle, speed, side, foot. */
  holdClip(slot: number, anim: AnimId, t?: number, cycle?: number, speed?: number, side?: number, foot?: number): void;
  /** World position of joint j (fk.ts Joint) of a slot after the last update. */
  joint(slot: number, j: number): [number, number, number];
  /** World position of a point given in joint j's local space (reference-body metres) of a slot. */
  point(slot: number, j: number, lx: number, ly: number, lz: number): [number, number, number];
  /** Colours (sRGB) applied to a slot, and its shirt number (0 = none drawn). */
  look(slot: number): SlotLook & { shirtNumber: number };
  info(): { meshes: number; drawCalls: number; trianglesPerPlayer: number; instances: number[]; numberAtlas: boolean; hidden: number[] };
}

declare global {
  interface Window {
    /** Player model debug hook (GFX-07). */
    __dotkickPlayers?: PlayerModelDebug;
  }
}

// ============================================================ Wave 0 helper (kept)

/**
 * Write a column-major instance matrix: feet at (x, 0, z), model +x turned to face (fx, fz), uniform height scale h,
 * depth scale d along the facing. No allocation.
 */
export function writeFacingMatrix(arr: Float32Array | number[], i: number, x: number, z: number, fx: number, fz: number, h: number, d: number): void {
  const o = i * 16;
  // Rotation about y taking +x to (fx, 0, fz); model +z (the player's right) goes to (-fz, 0, fx).
  arr[o] = fx * d; arr[o + 1] = 0; arr[o + 2] = fz * d; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = h; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = -fz * h; arr[o + 9] = 0; arr[o + 10] = fx * h; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = 0; arr[o + 14] = z; arr[o + 15] = 1;
}

// ============================================================ looks (render-only variety)

/** Skin tones, hair colours and boot colours (sRGB). */
export const SKIN_TONES: readonly number[] = [0xf2c9a8, 0xe3b08c, 0xcf9670, 0xb07650, 0x8c5a3a, 0x6a4129, 0x4f3020];
export const HAIR_COLOURS: readonly number[] = [0x17110d, 0x2a1c13, 0x3f2a1c, 0x6b4a2c, 0xa77d45, 0xd2b071, 0x8c3a1e];
export const BOOT_COLOURS: readonly number[] = [0x121212, 0x121212, 0x121212, 0xf0f0f0, 0xf0f0f0, 0x1d3fbf, 0xd6262f, 0xf2c318, 0x27b36b];
/** Keeper gloves. */
export const GLOVE_COLOUR = 0xf4f4f0;

/** Integer hash (render-only variety; not used by the sim). */
export function lookHash(a: number, b: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Per-player colours (sRGB) from the resolved kit. Pure; writes `out`. */
export interface SlotLook {
  skin: number;
  hair: number;
  boot: number;
  shirt: number;
  shirt2: number;
  shorts: number;
  socks: number;
  number: number;
  pattern: number;
  /** Left / right sleeve colour (halves: the left side wears the second colour). */
  sleeveL: number;
  sleeveR: number;
  /** Upper-arm lower part, forearm and hand colours (keepers: long sleeves and gloves). */
  armSkinL: number;
  armSkinR: number;
  hand: number;
  keeper: boolean;
}

export function createSlotLook(): SlotLook {
  return {
    skin: 0, hair: 0, boot: 0, shirt: 0, shirt2: 0, shorts: 0, socks: 0, number: 0, pattern: 0, sleeveL: 0, sleeveR: 0,
    armSkinL: 0, armSkinR: 0, hand: 0, keeper: false,
  };
}

export function slotLook(kit: Kit, keeper: boolean, clubIdx: number, rosterIdx: number, out: SlotLook): SlotLook {
  const h = lookHash(clubIdx + 1, rosterIdx + 1);
  out.skin = SKIN_TONES[h % SKIN_TONES.length]!;
  const shaved = ((h >>> 8) % 9) === 0;
  out.hair = shaved ? out.skin : HAIR_COLOURS[(h >>> 12) % HAIR_COLOURS.length]!;
  out.boot = BOOT_COLOURS[(h >>> 20) % BOOT_COLOURS.length]!;
  const pattern = kit.pattern >= KitPattern.PLAIN && kit.pattern <= KitPattern.SASH ? kit.pattern : KitPattern.PLAIN;
  out.pattern = pattern;
  out.shirt = kit.shirt;
  out.shirt2 = kit.shirt2;
  out.shorts = kit.shorts;
  out.socks = kit.socks;
  out.number = kit.number;
  out.keeper = keeper;
  out.sleeveR = kit.shirt;
  out.sleeveL = pattern === KitPattern.HALVES ? kit.shirt2 : kit.shirt;
  out.armSkinL = keeper ? out.sleeveL : out.skin;
  out.armSkinR = keeper ? out.sleeveR : out.skin;
  out.hand = keeper ? GLOVE_COLOUR : out.skin;
  return out;
}

/** Relative luminance (0..1) of an sRGB colour (outline choice for the number). */
export function luminance(rgb: number): number {
  const ch = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((rgb >> 16) & 255) + 0.7152 * ch((rgb >> 8) & 255) + 0.0722 * ch(rgb & 255);
}

// ============================================================ shirt-number atlas (fallback)

/** Number atlas grid: number n in cell n (row n / 10, column n % 10); the same grid as GFX-08's glyph atlas. */
const ATLAS_COLS = 10;

/** UV rect of cell n in a 10 x 10 atlas (v up). The same convention as kits.ts createKitNumberAtlas().glyphRect. */
export function gridGlyphRect(n: number, out: Float32Array | number[], o: number): boolean {
  if (!(n >= 1 && n <= 99) || n !== Math.floor(n)) return false;
  const col = n % ATLAS_COLS, row = Math.floor(n / ATLAS_COLS);
  out[o] = col / ATLAS_COLS;
  out[o + 1] = 1 - (row + 1) / ATLAS_COLS;
  out[o + 2] = (col + 1) / ATLAS_COLS;
  out[o + 3] = 1 - row / ATLAS_COLS;
  return true;
}

/** GFX-08's generated glyph atlas, built once per page (about 80 ms, 1 MB with mips) and shared by every model. */
let sharedNumbers: KitNumberAtlas | null = null;

/**
 * The default shirt-number atlas: GFX-08's generated digits (kits.ts createKitNumberAtlas: numbers 1..99, bold
 * rounded sans built from code, white fill / black outline, premultiplied coverage, manual mips). No canvas or font
 * needed, so it is identical in every browser and in Node. Cached; the model disposes only its GPU copy.
 */
export function createNumberAtlas(): NumberAtlas | null {
  if (!sharedNumbers) sharedNumbers = createKitNumberAtlas();
  return sharedNumbers;
}

// ============================================================ shaders

const f4 = (v: number): string => v.toFixed(4);

const PART_VERTEX_DECL = `
attribute vec3 iColA;
attribute vec3 iColB;
attribute float aSel;
varying vec3 vKitCol;
`;
const PART_FRAGMENT_DECL = `
varying vec3 vKitCol;
`;

const TORSO_VERTEX_DECL = `
attribute vec3 iColA;
attribute vec3 iColB;
attribute vec3 iColN;
attribute vec4 iKit;
attribute vec4 iNum;
attribute float aSel;
varying vec3 vLoc;
varying vec3 vColA;
varying vec3 vColB;
varying vec3 vColN;
varying vec4 vKit;
varying vec4 vNum;
varying float vSel;
`;

/** Torso fragment helpers: kit pattern (anti-aliased with fwidth), collar trim, number on the back. */
const TORSO_FRAGMENT_DECL = `
uniform sampler2D uNumAtlas;
uniform float uNumOn;
varying vec3 vLoc;
varying vec3 vColA;
varying vec3 vColB;
varying vec3 vColN;
varying vec4 vKit;
varying vec4 vNum;
varying float vSel;
float dkStep(float edge, float x) {
  float w = max(fwidth(x), 1e-4);
  return smoothstep(edge - w, edge + w, x);
}
float dkIs(float pat, float id) {
  return step(id - 0.5, pat) * step(pat, id + 0.5);
}
vec3 dkShirt() {
  float yn = clamp((vLoc.y - (${f4(TORSO_Y0)})) / ${f4(TORSO_Y1 - TORSO_Y0)}, 0.0, 1.0);
  float pat = vKit.x;
  // stripes: ten around the body, a primary stripe down the middle of the chest
  float u = atan(vLoc.z, vLoc.x + 1e-4) * 0.15915494;
  float bS = 1.0 - dkStep(0.25, abs(fract(u * 5.0) - 0.5));
  // hoops: five bands from hem to collar
  float bH = 1.0 - dkStep(0.25, abs(fract(yn * 2.5 + 0.25) - 0.5));
  // halves: the player's left half (-z) in the second colour
  float bV = dkStep(0.0, -vLoc.z);
  // sash: from the right shoulder down to the left hip
  float bA = 1.0 - dkStep(0.34, abs(vLoc.z / 0.19 - (yn * 2.0 - 1.0) * 1.15));
  float b = dkIs(pat, 1.0) * bS + dkIs(pat, 2.0) * bH + dkIs(pat, 3.0) * bV + dkIs(pat, 4.0) * bA;
  b = max(b, vSel);
  vec3 c = mix(vColA, vColB, b);
  // shirt number on the back (premultiplied glyph: fill in r, coverage in a)
  vec2 q = vec2((vLoc.z + ${f4(NUMBER_PANEL.w / 2)}) / ${f4(NUMBER_PANEL.w)}, (vLoc.y - ${f4(NUMBER_PANEL.y - NUMBER_PANEL.h / 2)}) / ${f4(NUMBER_PANEL.h)});
  vec4 g = texture2D(uNumAtlas, mix(vNum.xy, vNum.zw, clamp(q, 0.0, 1.0)));
  float m = uNumOn * vKit.z * (1.0 - vSel) * step(vLoc.x, -0.02) * step(abs(q.x - 0.5), 0.5) * step(abs(q.y - 0.5), 0.5);
  g *= m;
  vec3 outline = mix(vec3(0.9), vec3(0.012), vKit.y);
  return c * (1.0 - g.a) + outline * max(g.a - g.r, 0.0) + vColN * g.r;
}
`;

const DIFFUSE_LINE = 'vec4 diffuseColor = vec4( diffuse, opacity );';

function inject(src: string, marker: string, add: string, after: boolean, what: string): string {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`[players] shader patch: '${marker}' not found in the ${what} shader`);
  return after ? src.slice(0, i + marker.length) + add + src.slice(i + marker.length) : src.slice(0, i) + add + src.slice(i + marker.length);
}

/** Patch Lambert sources for a generic part (colour A / B by aSel). Throws when three's chunks moved. Pure. */
export function patchPartShader(vertex: string, fragment: string): { vertex: string; fragment: string } {
  let v = inject(vertex, '#include <common>', PART_VERTEX_DECL, true, 'vertex');
  v = inject(v, '#include <color_vertex>', '\nvKitCol = mix( iColA, iColB, aSel );', true, 'vertex');
  let f = inject(fragment, '#include <common>', PART_FRAGMENT_DECL, true, 'fragment');
  f = inject(f, DIFFUSE_LINE, 'vec4 diffuseColor = vec4( diffuse * vKitCol, opacity );', false, 'fragment');
  return { vertex: v, fragment: f };
}

/** Patch Lambert sources for the torso (pattern, trim, number). Throws when three's chunks moved. Pure. */
export function patchTorsoShader(vertex: string, fragment: string): { vertex: string; fragment: string } {
  let v = inject(vertex, '#include <common>', TORSO_VERTEX_DECL, true, 'vertex');
  v = inject(v, '#include <color_vertex>',
    '\nvLoc = position; vColA = iColA; vColB = iColB; vColN = iColN; vKit = iKit; vNum = iNum; vSel = aSel;', true, 'vertex');
  let f = inject(fragment, '#include <common>', TORSO_FRAGMENT_DECL, true, 'fragment');
  f = inject(f, DIFFUSE_LINE, 'vec4 diffuseColor = vec4( diffuse * dkShirt(), opacity );', false, 'fragment');
  return { vertex: v, fragment: f };
}

// ============================================================ default pose driver

/**
 * The default animation driver: the GFX-12 mapper's stable API (mapAnim, advanceCycle, samplePose). The stride cycle
 * advances by interpolated distance travelled; a jump above LOCAL_TUNING.teleportDist (restart placement, replay
 * cut, new match) does not advance it. One closure per driver (created once, not per frame); no allocation per frame.
 */
/**
 * Distance a player travelled since the last frame for the stride cycle (m): 0 on the first frame seen and for
 * teleports above LOCAL_TUNING.teleportDist (restart placements, replay cuts, a new match) or non-finite input. Pure.
 */
export function strideDistance(px: number, pz: number, x: number, z: number, seen: boolean): number {
  if (!seen) return 0;
  const dx = x - px, dz = z - pz;
  const d = Math.sqrt(dx * dx + dz * dz);
  return d <= LOCAL_TUNING.teleportDist ? d : 0;
}

export function createDefaultPoseDriver(): PoseDriver {
  const bank = createAnimBank();
  const sample = createAnimSample();
  const scratch = createPose();
  const lastX = new Float64Array(NUM_SLOTS), lastZ = new Float64Array(NUM_SLOTS);
  const seen = new Uint8Array(NUM_SLOTS);
  return (f: RenderFrame, sink: PoseSink): void => {
    const s = f.curr, it = f.interp;
    for (let i = 0; i < NUM_SLOTS; i++) {
      if (s.players[i]!.active !== 1) { seen[i] = 0; continue; }
      // strideDistance(), written out: no double crosses a call boundary (zero allocation per frame).
      const x = it.x[i]!, z = it.z[i]!;
      let d = 0;
      if (seen[i] === 1) {
        const dx = x - lastX[i]!, dz = z - lastZ[i]!;
        d = Math.sqrt(dx * dx + dz * dz);
        if (!(d <= LOCAL_TUNING.teleportDist)) d = 0;
      }
      lastX[i] = x; lastZ[i] = z; seen[i] = 1;
      const vx = it.vx[i]!, vz = it.vz[i]!;
      let speed = Math.sqrt(vx * vx + vz * vz);
      if (!(speed === speed)) speed = 0;
      advanceCycle(bank, i, d);
      mapAnim(s, i, speed, sample);
      samplePose(sample, bank.cycle[i]!, speed, scratch);
      sink.setPose(i, scratch);
    }
  };
}

// ============================================================ the module

/** Instanced colour attributes of a part (linear RGB). */
interface PartAttrs {
  a: InstancedBufferAttribute;
  b: InstancedBufferAttribute;
}

const colour = new Color();

/** Write sRGB hex as linear RGB into arr[o..o+2]. */
function writeColour(arr: Float32Array, o: number, hex: number): void {
  colour.setHex(hex);
  arr[o] = colour.r; arr[o + 1] = colour.g; arr[o + 2] = colour.b;
}

/** Height scale of a slot (attrs.height / 180, clamped). */
export function heightScale(heightCm: number): number {
  if (!(heightCm > 0)) return 1;
  const h = heightCm / 180;
  return h < LOCAL_TUNING.minScale ? LOCAL_TUNING.minScale : h > LOCAL_TUNING.maxScale ? LOCAL_TUNING.maxScale : h;
}

/** Part mesh and joint per part, for both sides of paired parts: [part, left joint, right joint]. */
const PART_JOINTS: readonly (readonly [number, number, number])[] = [
  [Part.HEAD, Joint.HEAD, Joint.HEAD],
  [Part.TORSO, Joint.SPINE, Joint.SPINE],
  [Part.PELVIS, Joint.ROOT, Joint.ROOT],
  [Part.UPPER_ARM, Joint.SHOULDER_L, Joint.SHOULDER_R],
  [Part.LOWER_ARM, Joint.ELBOW_L, Joint.ELBOW_R],
  [Part.UPPER_LEG, Joint.HIP_L, Joint.HIP_R],
  [Part.LOWER_LEG, Joint.KNEE_L, Joint.KNEE_R],
  [Part.BOOT, Joint.ANKLE_L, Joint.ANKLE_R],
];

export function createPlayerModel(ctx: RenderContext): PlayerModelModule {
  const group = new Group();
  group.name = 'players';
  group.visible = false;
  group.matrixAutoUpdate = false;

  // ---- materials
  const numUniform: { value: Texture } = { value: placeholderTexture() };
  const numOn = { value: 0 };
  const partMat = new MeshLambertMaterial({ color: 0xffffff });
  partMat.name = 'player-part';
  partMat.onBeforeCompile = (shader) => {
    const p = patchPartShader(shader.vertexShader, shader.fragmentShader);
    shader.vertexShader = p.vertex;
    shader.fragmentShader = p.fragment;
  };
  partMat.customProgramCacheKey = () => 'dk-player-part-1';
  const torsoMat = new MeshLambertMaterial({ color: 0xffffff });
  torsoMat.name = 'player-torso';
  torsoMat.onBeforeCompile = (shader) => {
    const p = patchTorsoShader(shader.vertexShader, shader.fragmentShader);
    shader.vertexShader = p.vertex;
    shader.fragmentShader = p.fragment;
    shader.uniforms.uNumAtlas = numUniform;
    shader.uniforms.uNumOn = numOn;
  };
  torsoMat.customProgramCacheKey = () => 'dk-player-torso-1';

  // ---- meshes and instanced attributes
  const geos: BufferGeometry[] = [];
  const meshes: InstancedMesh[] = [];
  const attrs: PartAttrs[] = [];
  const mats: Float32Array[] = [];
  for (let p = 0; p < PART_COUNT; p++) {
    const n = PART_PAIRED[p] ? NUM_SLOTS * 2 : NUM_SLOTS;
    const geo = buildPartGeometry(p);
    const a = new InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    const b = new InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    geo.setAttribute('iColA', a);
    geo.setAttribute('iColB', b);
    const mesh = new InstancedMesh(geo, p === Part.TORSO ? torsoMat : partMat, n);
    mesh.name = `players-${PART_NAMES[p]}`;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false; // instances move every frame; the cached bounds would cull wrongly
    mesh.matrixAutoUpdate = false;
    const arr = mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < n; i++) writeHiddenMatrix(arr, i);
    group.add(mesh);
    geos.push(geo);
    meshes.push(mesh);
    attrs.push({ a, b });
    mats.push(arr);
  }
  const torsoGeo = geos[Part.TORSO]!;
  const torsoN = new InstancedBufferAttribute(new Float32Array(NUM_SLOTS * 3).fill(1), 3);
  const torsoKit = new InstancedBufferAttribute(new Float32Array(NUM_SLOTS * 4), 4);
  const torsoNum = new InstancedBufferAttribute(new Float32Array(NUM_SLOTS * 4), 4);
  torsoGeo.setAttribute('iColN', torsoN);
  torsoGeo.setAttribute('iKit', torsoKit);
  torsoGeo.setAttribute('iNum', torsoNum);
  group.updateMatrix();
  ctx.scene.add(group);
  applyShadows(ctx.tier);

  // ---- per-slot state
  const poses: Pose[] = [];
  const skeletons: Float64Array[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) { poses.push(createPose()); skeletons.push(createSkeleton()); }
  const modelSk = createSkeleton();
  const place = new Float64Array(PLACE_SIZE);
  // Foot lock [INT-C]: per slot the visual offset from the sim position (x, z), the drawn world position of the four
  // boot points (toe / heel, left / right) last frame and whether each was planted, and the last interpolated x, z.
  const lockOff = new Float64Array(NUM_SLOTS * 2);
  const lockPts = new Float64Array(NUM_SLOTS * 12);
  const lockWas = new Uint8Array(NUM_SLOTS * 4);
  const lockLast = new Float64Array(NUM_SLOTS * 2);
  const lockSeen = new Uint8Array(NUM_SLOTS);
  /** Per frame: [0] dt (s); scratch [1..12] the raw boot points of the slot being placed. */
  const LK = new Float64Array(13);
  const hidden = new Uint8Array(NUM_SLOTS).fill(1);
  const held = new Uint8Array(NUM_SLOTS);
  const heldPoses: Pose[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) heldPoses.push(createPose());
  /** Look key per slot: keeper flag, roster index and shirt number the colours were applied for. */
  const keyKeeper = new Int8Array(NUM_SLOTS).fill(-1);
  const keyRoster = new Int16Array(NUM_SLOTS).fill(-1);
  const keyShirt = new Int16Array(NUM_SLOTS).fill(-1);
  const looks: SlotLook[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) looks.push(createSlotLook());
  let kits: MatchKits | null = null;
  let clubsNow: readonly Club[] = [];
  let kitsDirty = false;
  let highContrast = ctx.settings.accessibility.highContrastKits;
  let matchOn = false;

  const defaultDriver = createAnimDriver();
  let driver: PoseDriver = defaultDriver;
  let ownAtlas: NumberAtlas | null = null;
  let externalAtlas: NumberAtlas | null = null;
  let atlas: NumberAtlas | null = null;

  // ---- debug state
  let closeSlot = -1;
  let closeDist: number = LOCAL_TUNING.closeUpDist;
  let closeAngle = 0;
  let closeEyeY: number = LOCAL_TUNING.closeUpEyeY;
  const camTarget = new Vector3();
  const jointOut = new Float64Array(3);

  function applyShadows(tier: QualityTier): void {
    const cast = getTierParams(tier).shadowMap;
    for (let p = 0; p < meshes.length; p++) meshes[p]!.castShadow = cast;
  }

  function useAtlas(a: NumberAtlas | null): void {
    atlas = a;
    numUniform.value = a ? a.texture : placeholderTexture();
    numOn.value = a ? 1 : 0;
    for (let i = 0; i < NUM_SLOTS; i++) keyShirt[i] = -1; // re-read glyph rects
  }

  /** Colours and kit data of one slot. Not per frame: only when its look key changes. */
  function applySlot(state: ReadonlySimState, i: number): void {
    const p = state.players[i]!;
    const t = p.team === 1 ? 1 : 0;
    const keeper = state.teams[t]!.keeperSlot === i;
    const shirtNo = state.attrs[i]!.shirt | 0;
    keyKeeper[i] = keeper ? 1 : 0;
    keyRoster[i] = p.rosterIdx;
    keyShirt[i] = shirtNo;
    if (!kits) return;
    const kit = keeper ? kits.keeper[t] : kits.outfield[t];
    const look = slotLook(kit, keeper, state.teams[t]!.clubIdx, p.rosterIdx, looks[i]!);
    const s3 = i * 3, l3 = i * 6, r3 = i * 6 + 3;
    const A = (part: number): Float32Array => attrs[part]!.a.array as Float32Array;
    const B = (part: number): Float32Array => attrs[part]!.b.array as Float32Array;
    writeColour(A(Part.HEAD), s3, look.skin); writeColour(B(Part.HEAD), s3, look.hair);
    writeColour(A(Part.TORSO), s3, look.shirt); writeColour(B(Part.TORSO), s3, look.shirt2);
    writeColour(torsoN.array as Float32Array, s3, look.number);
    writeColour(A(Part.PELVIS), s3, look.shorts); writeColour(B(Part.PELVIS), s3, look.shorts);
    writeColour(A(Part.UPPER_ARM), l3, look.sleeveL); writeColour(B(Part.UPPER_ARM), l3, look.armSkinL);
    writeColour(A(Part.UPPER_ARM), r3, look.sleeveR); writeColour(B(Part.UPPER_ARM), r3, look.armSkinR);
    writeColour(A(Part.LOWER_ARM), l3, look.armSkinL); writeColour(B(Part.LOWER_ARM), l3, look.hand);
    writeColour(A(Part.LOWER_ARM), r3, look.armSkinR); writeColour(B(Part.LOWER_ARM), r3, look.hand);
    for (let side = 0; side < 2; side++) {
      const o = i * 6 + side * 3;
      writeColour(A(Part.UPPER_LEG), o, look.shorts); writeColour(B(Part.UPPER_LEG), o, look.skin);
      writeColour(A(Part.LOWER_LEG), o, look.socks); writeColour(B(Part.LOWER_LEG), o, look.skin);
      writeColour(A(Part.BOOT), o, look.boot); writeColour(B(Part.BOOT), o, look.boot);
    }
    const kitArr = torsoKit.array as Float32Array;
    const numArr = torsoNum.array as Float32Array;
    const hasNo = atlas !== null && atlas.glyphRect(shirtNo, numArr, i * 4);
    if (!hasNo) { numArr[i * 4] = 0; numArr[i * 4 + 1] = 0; numArr[i * 4 + 2] = 0; numArr[i * 4 + 3] = 0; }
    kitArr[i * 4] = look.pattern;
    kitArr[i * 4 + 1] = luminance(look.number) > 0.35 ? 1 : 0; // light number: dark outline
    kitArr[i * 4 + 2] = hasNo ? 1 : 0;
    kitArr[i * 4 + 3] = keeper ? 1 : 0;
    for (let p = 0; p < PART_COUNT; p++) { attrs[p]!.a.needsUpdate = true; attrs[p]!.b.needsUpdate = true; }
    torsoN.needsUpdate = true;
    torsoKit.needsUpdate = true;
    torsoNum.needsUpdate = true;
  }

  function applyAll(state: ReadonlySimState): void {
    for (let i = 0; i < NUM_SLOTS; i++) applySlot(state, i);
  }

  function hideSlot(i: number): void {
    for (let p = 0; p < PART_COUNT; p++) {
      const arr = mats[p]!;
      if (PART_PAIRED[p]) { writeHiddenMatrix(arr, i * 2); writeHiddenMatrix(arr, i * 2 + 1); }
      else writeHiddenMatrix(arr, i);
    }
    hidden[i] = 1;
  }

  /**
   * Pose -> world skeleton -> instance matrices for one slot. Only integers and objects cross call boundaries here
   * (doubles go through typed arrays), so V8 never boxes a number: zero allocation per frame.
   */
  function placeSlot(i: number, s: ReadonlySimState, it: RenderFrame['interp']): void {
    const pose = poses[i]!;
    solvePoseFK(pose, modelSk);
    groundSkeleton(modelSk, pose);
    const sk = skeletons[i]!;
    // heightScale(), written out.
    const cm = s.attrs[i]!.height;
    let h = cm > 0 ? cm / 180 : 1;
    if (h < LOCAL_TUNING.minScale) h = LOCAL_TUNING.minScale;
    else if (h > LOCAL_TUNING.maxScale) h = LOCAL_TUNING.maxScale;
    place[0] = it.x[i]!; place[1] = it.z[i]!; place[2] = it.fx[i]!; place[3] = it.fz[i]!; place[4] = h;
    placeSkeleton(modelSk, sk, place);
    footLock(i, s, it, sk);
    for (let k = 0; k < PART_JOINTS.length; k++) {
      const pj = PART_JOINTS[k]!;
      const part = pj[0], arr = mats[part]!;
      if (PART_PAIRED[part]) {
        writeJointMatrix(sk, pj[1], arr, i * 2);
        writeJointMatrix(sk, pj[2], arr, i * 2 + 1);
      } else {
        writeJointMatrix(sk, pj[1], arr, i);
      }
    }
    hidden[i] = 0;
  }

  /**
   * [INT-C] Foot lock. The procedural gait plants a boot exactly when the player runs straight at a steady speed; in
   * live play facing turns (the body rotates about its root), speed changes and clip cross-fades still drag a planted
   * boot over the grass. While a running player (no action) has a boot planted in this frame and the last one, the
   * whole body is shifted by the opposite of that boot's drift, so it stays where it was put down; the offset from the
   * sim position eases back (slowly while locked, quickly in the flight phases and outside the lock) and never exceeds
   * lockMaxOffset. Teleports, held debug poses and sent-off slots drop it. No allocation (typed arrays only).
   */
  function footLock(i: number, s: ReadonlySimState, it: RenderFrame['interp'], sk: Float64Array): void {
    const T = LOCAL_TUNING;
    const p = s.players[i]!;
    const x = it.x[i]!, z = it.z[i]!;
    const jx = x - lockLast[i * 2]!, jz = z - lockLast[i * 2 + 1]!;
    lockLast[i * 2] = x; lockLast[i * 2 + 1] = z;
    const dt = LK[0]!;
    const fresh = lockSeen[i] !== 1 || jx * jx + jz * jz > T.lockTeleport * T.lockTeleport || held[i] === 1;
    lockSeen[i] = 1;
    // Raw boot points (as placed at the sim position).
    for (let k = 0; k < 4; k++) {
      const o = (k < 2 ? Joint.ANKLE_L : Joint.ANKLE_R) * FRAME_SIZE;
      const lx = (k & 1) === 0 ? BODY.toeX : BODY.heelX, ly = -BODY.ankleY;
      LK[1 + k * 3] = sk[o]! * lx + sk[o + 3]! * ly + sk[o + 9]!;
      LK[2 + k * 3] = sk[o + 1]! * lx + sk[o + 4]! * ly + sk[o + 10]!;
      LK[3 + k * 3] = sk[o + 2]! * lx + sk[o + 5]! * ly + sk[o + 11]!;
    }
    let ox = 0, oz = 0;
    let locked = 0;
    if (!fresh) {
      ox = lockOff[i * 2]!; oz = lockOff[i * 2 + 1]!;
      const vx = it.vx[i]!, vz = it.vz[i]!;
      const lockable = dt > 0 && p.act === ActionKind.NONE && vx * vx + vz * vz > T.lockMinSpeed * T.lockMinSpeed;
      if (lockable) {
        let dx = 0, dz = 0;
        for (let k = 0; k < 4; k++) {
          if (lockWas[i * 4 + k] !== 1 || !(LK[2 + k * 3]! < T.lockGroundY)) continue;
          dx += LK[1 + k * 3]! + ox - lockPts[i * 12 + k * 3]!;
          dz += LK[3 + k * 3]! + oz - lockPts[i * 12 + k * 3 + 2]!;
          locked++;
        }
        if (locked > 0) { ox -= dx / locked; oz -= dz / locked; }
      }
      if (dt > 0) {
        let f = 1 - dt / (locked > 0 ? T.lockReturnLocked : T.lockReturnFree);
        if (f < 0) f = 0;
        ox *= f; oz *= f;
      }
      const l2 = ox * ox + oz * oz;
      if (l2 > T.lockMaxOffset * T.lockMaxOffset) {
        const k = T.lockMaxOffset / Math.sqrt(l2);
        ox *= k; oz *= k;
      }
      if (!(ox === ox) || !(oz === oz)) { ox = 0; oz = 0; }
    }
    lockOff[i * 2] = ox; lockOff[i * 2 + 1] = oz;
    if (ox !== 0 || oz !== 0) {
      for (let j = 0; j < JOINT_COUNT; j++) {
        sk[j * FRAME_SIZE + 9] = sk[j * FRAME_SIZE + 9]! + ox;
        sk[j * FRAME_SIZE + 11] = sk[j * FRAME_SIZE + 11]! + oz;
      }
    }
    for (let k = 0; k < 4; k++) {
      lockPts[i * 12 + k * 3] = LK[1 + k * 3]! + ox;
      lockPts[i * 12 + k * 3 + 1] = LK[2 + k * 3]!;
      lockPts[i * 12 + k * 3 + 2] = LK[3 + k * 3]! + oz;
      lockWas[i * 4 + k] = LK[2 + k * 3]! < T.lockGroundY ? 1 : 0;
    }
  }

  /** Debug close-up: overrides ctx.camera's pose (the cameras already ran this frame). */
  function applyCloseUp(it: RenderFrame['interp']): void {
    if (closeSlot < 0 || hidden[closeSlot] === 1) return;
    const x = it.x[closeSlot]!, z = it.z[closeSlot]!;
    let fx = it.fx[closeSlot]!, fz = it.fz[closeSlot]!;
    const l = Math.sqrt(fx * fx + fz * fz);
    if (l > 1e-6) { fx /= l; fz /= l; } else { fx = 1; fz = 0; }
    const a = (closeAngle * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    // Rotate the facing by the angle about y (positive = toward the player's right).
    const dx = fx * c - fz * s, dz = fz * c + fx * s;
    const cam = ctx.camera;
    cam.position.set(x + dx * closeDist, closeEyeY, z + dz * closeDist);
    camTarget.set(x, LOCAL_TUNING.closeUpLookY, z);
    cam.up.set(0, 1, 0);
    cam.lookAt(camTarget);
    cam.updateMatrixWorld(true);
  }

  const api: PlayerModelModule = {
    mesh: meshes[Part.TORSO]!,
    meshes,
    group,
    poses,
    skeletons,
    get kits(): MatchKits | null { return kits; },

    setPose(slot: number, pose: ArrayLike<number>): void {
      if (!(slot >= 0 && slot < NUM_SLOTS)) return;
      const dst = poses[slot | 0]!;
      const n = pose.length < POSE_SIZE ? pose.length : POSE_SIZE;
      for (let k = 0; k < n; k++) {
        const v = pose[k]!;
        dst[k] = v === v && v < 1e4 && v > -1e4 ? v : 0;
      }
      for (let k = n; k < POSE_SIZE; k++) dst[k] = 0;
    },

    setPoseDriver(d: PoseDriver | null): void {
      driver = d ?? defaultDriver;
    },

    setNumberAtlas(a: NumberAtlas | null): void {
      externalAtlas = a;
      useAtlas(a ?? ownAtlas);
    },

    setMatch(state: ReadonlySimState, clubs: readonly Club[]): void {
      clubsNow = clubs;
      highContrast = ctx.settings.accessibility.highContrastKits;
      kits = resolveMatchKits(state, clubs, highContrast);
      kitsDirty = false;
      if (!externalAtlas && !ownAtlas) {
        ownAtlas = createNumberAtlas();
        if (ownAtlas) useAtlas(ownAtlas);
      }
      applyAll(state);
      for (let i = 0; i < NUM_SLOTS; i++) hideSlot(i);
      lockSeen.fill(0);
      for (let p = 0; p < PART_COUNT; p++) meshes[p]!.instanceMatrix.needsUpdate = true;
      group.visible = true;
      matchOn = true;
    },

    update(f: RenderFrame): void {
      if (!matchOn) return;
      const s = f.curr, it = f.interp;
      if (kitsDirty) {
        kits = resolveMatchKits(s, clubsNow, highContrast); // settings change (high-contrast kits): rare, not per frame
        kitsDirty = false;
        applyAll(s);
      }
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        const t = p.team === 1 ? 1 : 0;
        const keeper = s.teams[t]!.keeperSlot === i ? 1 : 0;
        if (keyKeeper[i] !== keeper || keyRoster[i] !== p.rosterIdx || keyShirt[i] !== (s.attrs[i]!.shirt | 0)) applySlot(s, i);
      }
      driver(f, api);
      for (let i = 0; i < NUM_SLOTS; i++) if (held[i] === 1) api.setPose(i, heldPoses[i]!);
      const dtMs = f.frame.paused ? 0 : f.frame.dtMs;
      LK[0] = dtMs > 0 ? (dtMs < 100 ? dtMs / 1000 : 0.1) : 0;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        const x = it.x[i]!, z = it.z[i]!;
        if (p.active !== 1 || !Number.isFinite(x) || !Number.isFinite(z)) { hideSlot(i); lockSeen[i] = 0; continue; }
        placeSlot(i, s, it);
      }
      for (let p = 0; p < PART_COUNT; p++) meshes[p]!.instanceMatrix.needsUpdate = true;
      if (closeSlot >= 0) applyCloseUp(it);
    },

    warmUp(): void {
      const r = ctx.renderer;
      if (r && atlas) r.initTexture(atlas.texture);
    },

    setQuality(tier: QualityTier): void {
      applyShadows(tier);
    },

    onSettings(st: Readonly<Settings>): void {
      const hc = st.accessibility.highContrastKits;
      if (hc !== highContrast) {
        highContrast = hc;
        if (matchOn) kitsDirty = true;
      }
    },

    clearMatch(): void {
      group.visible = false;
      matchOn = false;
    },

    dispose(): void {
      ctx.scene.remove(group);
      for (let p = 0; p < meshes.length; p++) meshes[p]!.dispose();
      for (let g = 0; g < geos.length; g++) geos[g]!.dispose();
      partMat.dispose();
      torsoMat.dispose();
      ownAtlas?.texture.dispose(); // the GPU copy only: the shared glyph data stays cached for the next renderer
      ownAtlas = null;
      matchOn = false;
      if (typeof window !== 'undefined' && window.__dotkickPlayers === debug) delete window.__dotkickPlayers;
    },
  };

  const debug: PlayerModelDebug = {
    closeUp(slot: number, dist?: number, angleDeg?: number, eyeY?: number): void {
      closeSlot = slot >= 0 && slot < NUM_SLOTS ? slot | 0 : -1;
      closeDist = dist !== undefined && dist > 0.5 ? dist : LOCAL_TUNING.closeUpDist;
      closeAngle = angleDeg ?? 0;
      closeEyeY = eyeY ?? LOCAL_TUNING.closeUpEyeY;
    },
    holdPose(slot: number, pose: ArrayLike<number> | null): void {
      if (!(slot >= 0 && slot < NUM_SLOTS)) return;
      if (!pose) { held[slot] = 0; return; }
      const dst = heldPoses[slot]!;
      for (let k = 0; k < POSE_SIZE; k++) dst[k] = k < pose.length ? pose[k]! : 0;
      held[slot] = 1;
    },
    holdClip(slot: number, anim: AnimId, t = 0, cycle = 0, speed = 0, side = 1, foot = 0): void {
      if (!(slot >= 0 && slot < NUM_SLOTS)) return;
      poseFnFor(anim)(heldPoses[slot]!, t, cycle, speed, side, foot);
      held[slot] = 1;
    },
    joint(slot: number, j: number): [number, number, number] {
      const sk = skeletons[slot] ?? skeletons[0]!;
      const o = (j | 0) * FRAME_SIZE;
      jointOut[0] = sk[o + 9]!; jointOut[1] = sk[o + 10]!; jointOut[2] = sk[o + 11]!;
      return [jointOut[0]!, jointOut[1]!, jointOut[2]!];
    },
    point(slot: number, j: number, lx: number, ly: number, lz: number): [number, number, number] {
      const sk = skeletons[slot] ?? skeletons[0]!;
      const o = (j | 0) * FRAME_SIZE;
      return [
        sk[o]! * lx + sk[o + 3]! * ly + sk[o + 6]! * lz + sk[o + 9]!,
        sk[o + 1]! * lx + sk[o + 4]! * ly + sk[o + 7]! * lz + sk[o + 10]!,
        sk[o + 2]! * lx + sk[o + 5]! * ly + sk[o + 8]! * lz + sk[o + 11]!,
      ];
    },
    look(slot: number) {
      const i = slot >= 0 && slot < NUM_SLOTS ? slot | 0 : 0;
      const kit = (torsoKit.array as Float32Array)[i * 4 + 2] === 1;
      return { ...looks[i]!, shirtNumber: kit ? keyShirt[i]! : 0 };
    },
    info() {
      const hid: number[] = [];
      for (let i = 0; i < NUM_SLOTS; i++) if (hidden[i] === 1) hid.push(i);
      return {
        meshes: meshes.length,
        drawCalls: meshes.length,
        trianglesPerPlayer: trianglesPerPlayer(),
        instances: meshes.map((m) => m.count),
        numberAtlas: atlas !== null,
        hidden: hid,
      };
    },
  };
  if (typeof window !== 'undefined') window.__dotkickPlayers = debug;

  return api;
}

/** 1 x 1 transparent texture bound when there is no number atlas (the sampler must always have a texture). */
let placeholder: DataTexture | null = null;
function placeholderTexture(): DataTexture {
  if (!placeholder) {
    placeholder = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
    placeholder.name = 'player-numbers-none';
    placeholder.needsUpdate = true;
  }
  return placeholder;
}
