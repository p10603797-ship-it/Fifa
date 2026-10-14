/**
 * [GFX-07] The player model module in Node (no WebGL): instanced meshes per part, per-frame placement from the
 * interpolated state and the poses (setPose), height scaling, sent-off players hidden, keepers in keeper kits with
 * long sleeves and gloves (also after a keeper change), high-contrast kits (setting at setMatch and toggled
 * mid-match), shirt numbers via GFX-08's generated number atlas or a custom one (also after a substitution), ground handling, the default pose driver, quality (shadows), clear / dispose, the debug hook.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Color, DataTexture, Matrix4, PerspectiveCamera, Scene, Vector3 } from 'three';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { QualityTier } from '../../src/contracts/enums';
import { createPose, PoseIdx } from '../../src/contracts/render';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { fillInterp } from '../../src/render/index';
import { resolveMatchKits } from '../../src/render/kits';
import { BODY, Joint, FRAME_SIZE } from '../../src/render/players/fk';
import { Part } from '../../src/render/players/parts';
import {
  createDefaultPoseDriver, createNumberAtlas, createPlayerModel, GLOVE_COLOUR, gridGlyphRect, SKIN_TONES, type NumberAtlas,
  type PlayerModelModule, type PoseSink,
} from '../../src/render/players/model';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';
import { cloneState } from '../../src/sim/core/clone';

function makeCtx(): RenderContext {
  const settings = createDefaultSettings();
  return {
    renderer: null as unknown as RenderContext['renderer'], scene: new Scene(), camera: new PerspectiveCamera(22, 1.4, 2, 600),
    settings, clubs: [], size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
  };
}

/** Lay the 22 players out on a grid facing +x. */
function layout(s: SimState): void {
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.x = -30 + (i % 11) * 6; p.z = i < 11 ? -10 : 10; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0; p.active = 1;
  }
}

interface Rig { ctx: RenderContext; model: PlayerModelModule; state: SimState; frame: RenderFrame }

function rig(): Rig {
  const ctx = makeCtx();
  const model = createPlayerModel(ctx);
  const state = initMatch(createMatchConfig());
  layout(state);
  const frame: RenderFrame = {
    prev: state, curr: state, alpha: 1, frame: { nowMs: 0, dtMs: 16.7, frame: 0, ticks: 1, paused: false }, interp: createInterpState(),
  };
  return { ctx, model, state, frame };
}

function step(r: Rig): void {
  fillInterp(r.frame.interp, r.frame.prev, r.frame.curr, r.frame.alpha);
  r.frame.frame.frame++;
  r.model.update(r.frame);
}

function matrix(r: Rig, part: number, index: number): Matrix4 {
  return new Matrix4().fromArray(r.model.meshes[part]!.instanceMatrix.array as Float32Array, index * 16);
}

function colourA(r: Rig, part: number, index: number): number[] {
  return Array.from((r.model.meshes[part]!.geometry.getAttribute('iColA').array as Float32Array).subarray(index * 3, index * 3 + 3));
}
function colourB(r: Rig, part: number, index: number): number[] {
  return Array.from((r.model.meshes[part]!.geometry.getAttribute('iColB').array as Float32Array).subarray(index * 3, index * 3 + 3));
}
function linear(hex: number): number[] {
  const c = new Color().setHex(hex);
  return [c.r, c.g, c.b];
}
function close(a: number[], b: number[]): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) < 1e-6);
}

let open: PlayerModelModule[] = [];
afterEach(() => {
  for (const m of open) m.dispose();
  open = [];
  delete (globalThis as { window?: unknown }).window;
});

function made(r: Rig): Rig {
  open.push(r.model);
  return r;
}

describe('GFX-07 player model: instancing', () => {
  it('one InstancedMesh per part (8 draw calls), 22 or 44 instances, under a hidden "players" group until setMatch', () => {
    const r = made(rig());
    expect(r.model.meshes).toHaveLength(8);
    expect(r.model.meshes.map((m) => m.count)).toEqual([22, 22, 22, 44, 44, 44, 44, 44]);
    expect(r.model.mesh).toBe(r.model.meshes[Part.TORSO]);
    expect(r.ctx.scene.getObjectByName('players')).toBe(r.model.group);
    expect(r.model.group.visible).toBe(false);
    let tris = 0;
    for (const m of r.model.meshes) tris += (m.geometry.getAttribute('position').count / 3) * m.count;
    expect(tris).toBeLessThanOrEqual(30_000);
    for (const m of r.model.meshes) expect(m.frustumCulled).toBe(false);
    r.model.setMatch!(r.state, CLUBS);
    expect(r.model.group.visible).toBe(true);
  });

  it('places every part from the interpolated position, facing and height; feet on the grass', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    r.state.players[4]!.fx = 0; r.state.players[4]!.fz = 1; // facing +z
    r.state.attrs[4]!.height = 198;
    step(r);
    const v = new Vector3();
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = r.state.players[i]!;
      const h = i === 4 ? 1.1 : r.state.attrs[i]!.height / 180;
      // Torso origin (spine pivot) straight above the player at (pelvisY + spineY) * h.
      v.set(0, 0, 0).applyMatrix4(matrix(r, Part.TORSO, i));
      expect(v.x).toBeCloseTo(p.x, 4);
      expect(v.z).toBeCloseTo(p.z, 4);
      expect(v.y).toBeCloseTo((BODY.pelvisY + BODY.spineY) * h, 4);
      // Soles on the grass, both boots.
      for (const side of [0, 1]) {
        v.set(BODY.toeX, -BODY.ankleY, 0).applyMatrix4(matrix(r, Part.BOOT, i * 2 + side));
        expect(v.y).toBeCloseTo(0, 4);
      }
    }
    // Slot 4 faces +z: its toes point to +z, its right boot (side 1) is on -x (the player's right).
    v.set(BODY.toeX, -BODY.ankleY, 0).applyMatrix4(matrix(r, Part.BOOT, 9));
    expect(v.z - r.state.players[4]!.z).toBeGreaterThan(0.15 * 1.1);
    expect(v.x - r.state.players[4]!.x).toBeCloseTo(-BODY.hipZ * 1.1, 4);
    // The head of the 198 cm player tops out at 1.98 m.
    v.set(0, BODY.headY + BODY.headRY, 0).applyMatrix4(matrix(r, Part.HEAD, 4));
    expect(v.y).toBeCloseTo(1.98, 4);
  });

  it('interpolates: positions come from frame.interp (prev -> curr at alpha), not raw tick positions', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    const prev = cloneState(r.state);
    prev.players[7]!.x = r.state.players[7]!.x - 1;
    r.frame.prev = prev;
    r.frame.alpha = 0.25;
    step(r);
    const v = new Vector3(0, 0, 0).applyMatrix4(matrix(r, Part.PELVIS, 7));
    expect(v.x).toBeCloseTo(r.state.players[7]!.x - 0.75, 4);
  });

  it('sent-off (inactive) players are hidden (zero matrices on every part); others still drawn', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    r.state.players[13]!.active = 0;
    step(r);
    for (let part = 0; part < 8; part++) {
      const paired = part >= Part.UPPER_ARM;
      const idx = paired ? [26, 27] : [13];
      for (const i of idx) expect(matrix(r, part, i).elements.every((e) => e === 0), `part ${part}`).toBe(true);
      expect(matrix(r, part, paired ? 28 : 14).elements.some((e) => e !== 0)).toBe(true);
    }
    // Back on: drawn again.
    r.state.players[13]!.active = 1;
    step(r);
    expect(matrix(r, Part.TORSO, 13).elements.some((e) => e !== 0)).toBe(true);
  });

  it('non-finite interpolated positions hide the player instead of drawing NaN geometry', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    r.state.players[2]!.x = Number.NaN;
    step(r);
    expect(matrix(r, Part.HEAD, 2).elements.every((e) => e === 0)).toBe(true);
    for (const m of r.model.meshes) expect(Array.from(m.instanceMatrix.array as Float32Array).every(Number.isFinite)).toBe(true);
  });

  it('nothing is drawn or computed before setMatch and after clearMatch', () => {
    const r = made(rig());
    step(r);
    expect(matrix(r, Part.TORSO, 0).elements.every((e) => e === 0)).toBe(true);
    r.model.setMatch!(r.state, CLUBS);
    step(r);
    r.model.clearMatch!();
    expect(r.model.group.visible).toBe(false);
    const before = Float32Array.from(r.model.meshes[Part.TORSO]!.instanceMatrix.array as Float32Array);
    r.state.players[0]!.x += 5;
    step(r);
    expect(Array.from(r.model.meshes[Part.TORSO]!.instanceMatrix.array as Float32Array)).toEqual(Array.from(before));
  });
});

describe('GFX-07 player model: poses', () => {
  it('setPose: hip pitch swings that leg forward along the facing; the pose is copied, NaN reads as 0', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    // A driver that holds slot 5 in a kick pose and leaves the rest standing.
    const kick = createPose();
    kick[PoseIdx.HIP_R_PITCH] = 0.9;
    kick[PoseIdx.KNEE_L] = Number.NaN;
    const zero = createPose();
    r.model.setPoseDriver((_f, sink) => { for (let i = 0; i < NUM_SLOTS; i++) sink.setPose(i, i === 5 ? kick : zero); });
    step(r);
    kick[PoseIdx.HIP_R_PITCH] = 0; // copied, not referenced
    expect(r.model.poses[5]![PoseIdx.HIP_R_PITCH]).toBeCloseTo(0.9, 6);
    expect(r.model.poses[5]![PoseIdx.KNEE_L]).toBe(0);
    const v = new Vector3(0, 0, 0).applyMatrix4(matrix(r, Part.BOOT, 11)); // slot 5 right ankle
    const h = r.state.attrs[5]!.height / 180;
    expect(v.x - r.state.players[5]!.x).toBeCloseTo(Math.sin(0.9) * (BODY.thigh + BODY.shin) * h, 3);
    const l = new Vector3(0, 0, 0).applyMatrix4(matrix(r, Part.BOOT, 10)); // left stays under the hip
    expect(l.x - r.state.players[5]!.x).toBeCloseTo(0, 4);
    r.model.setPoseDriver(null); // default again
    step(r);
  });

  it('ground: a pose that would sink is lifted, every part stays above the grass', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    const deep = createPose();
    deep[PoseIdx.ROOT_Y] = -0.6;
    deep[PoseIdx.ROOT_PITCH] = -1.2;
    r.model.setPoseDriver((_f, sink: PoseSink) => { for (let i = 0; i < NUM_SLOTS; i++) sink.setPose(i, deep); });
    step(r);
    const sk = r.model.skeletons[3]!;
    for (let j = 0; j < 13; j++) expect(sk[j * FRAME_SIZE + 10]!).toBeGreaterThan(0);
    const v = new Vector3(BODY.toeX, -BODY.ankleY, 0).applyMatrix4(matrix(r, Part.BOOT, 6));
    expect(v.y).toBeGreaterThanOrEqual(-1e-4);
  });

  it('the default driver animates a moving player (stride cycle from distance) and stands a still one', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    const p = r.state.players[8]!;
    p.vx = 5;
    const hips: number[] = [];
    for (let k = 0; k < 20; k++) {
      p.x += 5 / 60;
      step(r);
      hips.push(r.model.poses[8]![PoseIdx.HIP_L_PITCH]!);
    }
    expect(Math.max(...hips) - Math.min(...hips)).toBeGreaterThan(0.2); // legs swing
    for (const v of r.model.poses[9]!) expect(v).toBe(0); // still player (stub idle = neutral)
  });

  it('the default driver ignores teleports (no stride jump on a restart placement)', () => {
    const driver = createDefaultPoseDriver();
    const s = initMatch(createMatchConfig());
    layout(s);
    const interp = createInterpState();
    const f: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 16, frame: 0, ticks: 1, paused: false }, interp };
    const got = createPose();
    const sink: PoseSink = { setPose: (slot, pose) => { if (slot === 3) got.set(Array.from(pose)); } };
    s.players[3]!.vx = 5;
    for (let k = 0; k < 7; k++) { s.players[3]!.x += 0.09; fillInterp(interp, s, s, 1); driver(f, sink); }
    const before = Float32Array.from(got);
    s.players[3]!.x += 25; // teleport
    fillInterp(interp, s, s, 1);
    driver(f, sink);
    expect(Array.from(got)).toEqual(Array.from(before));
    s.players[3]!.x += 0.09; // normal step afterwards advances again
    fillInterp(interp, s, s, 1);
    driver(f, sink);
    expect(Array.from(got)).not.toEqual(Array.from(before));
  });
});

describe('GFX-07 player model: kits', () => {
  it('outfield players wear their team shirt / shorts / socks; keepers the keeper kit with long sleeves and gloves', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    step(r);
    const kits = resolveMatchKits(r.state, CLUBS);
    for (let i = 0; i < NUM_SLOTS; i++) {
      const t = r.state.players[i]!.team;
      const keeper = r.state.teams[t]!.keeperSlot === i;
      const kit = keeper ? kits.keeper[t] : kits.outfield[t];
      expect(close(colourA(r, Part.TORSO, i), linear(kit.shirt)), `slot ${i} shirt`).toBe(true);
      expect(close(colourA(r, Part.PELVIS, i), linear(kit.shorts)), `slot ${i} shorts`).toBe(true);
      expect(close(colourA(r, Part.LOWER_LEG, i * 2), linear(kit.socks)), `slot ${i} socks`).toBe(true);
      const sleeveLower = colourB(r, Part.UPPER_ARM, i * 2 + 1);
      const handCol = colourB(r, Part.LOWER_ARM, i * 2 + 1);
      if (keeper) {
        expect(close(sleeveLower, linear(kit.shirt)), `slot ${i} long sleeve`).toBe(true);
        expect(close(handCol, linear(GLOVE_COLOUR)), `slot ${i} glove`).toBe(true);
      } else {
        expect(SKIN_TONES.some((s) => close(sleeveLower, linear(s))), `slot ${i} bare arm`).toBe(true);
        expect(close(handCol, sleeveLower)).toBe(true);
      }
    }
    // The two teams differ.
    expect(close(colourA(r, Part.TORSO, 3), colourA(r, Part.TORSO, 14))).toBe(false);
  });

  it('a new keeper (keeperSlot changes after a send-off) switches to the keeper kit on the next frame', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    step(r);
    const kits = resolveMatchKits(r.state, CLUBS);
    r.state.players[0]!.active = 0;
    r.state.teams[0]!.keeperSlot = 6;
    step(r);
    expect(close(colourA(r, Part.TORSO, 6), linear(kits.keeper[0].shirt))).toBe(true);
    expect(close(colourB(r, Part.LOWER_ARM, 13), linear(GLOVE_COLOUR))).toBe(true);
  });

  it('shirt numbers: glyph rect of attrs.shirt from the number atlas; updated after a substitution', () => {
    const r = made(rig());
    const atlas: NumberAtlas = { texture: new DataTexture(new Uint8Array(4), 1, 1), glyphRect: gridGlyphRect };
    r.model.setNumberAtlas(atlas);
    r.state.attrs[9]!.shirt = 23;
    r.model.setMatch!(r.state, CLUBS);
    step(r);
    const kit = r.model.mesh.geometry.getAttribute('iKit').array as Float32Array;
    const num = r.model.mesh.geometry.getAttribute('iNum').array as Float32Array;
    const want = new Float32Array(4);
    gridGlyphRect(23, want, 0);
    expect(kit[9 * 4 + 2]).toBe(1);
    expect(Array.from(num.subarray(36, 40))).toEqual(Array.from(want));
    // Substitution: the slot's shirt number changes.
    r.state.attrs[9]!.shirt = 77;
    step(r);
    gridGlyphRect(77, want, 0);
    expect(Array.from(num.subarray(36, 40))).toEqual(Array.from(want));
    // No number (0) -> no glyph.
    r.state.attrs[9]!.shirt = 0;
    step(r);
    expect(kit[9 * 4 + 2]).toBe(0);
    // Pattern id and outline choice from the kit.
    const kits = resolveMatchKits(r.state, CLUBS);
    expect(kit[3 * 4]).toBe(kits.outfield[0].pattern);
  });

  it('the default number atlas is GFX-08\'s generated glyph atlas (no canvas or font needed, also in Node)', () => {
    const r = made(rig());
    for (let i = 0; i < NUM_SLOTS; i++) r.state.attrs[i]!.shirt = i < 11 ? i + 1 : i + 2;
    r.model.setMatch!(r.state, CLUBS);
    step(r);
    const kit = r.model.mesh.geometry.getAttribute('iKit').array as Float32Array;
    const num = r.model.mesh.geometry.getAttribute('iNum').array as Float32Array;
    const want = new Float32Array(4);
    for (let i = 0; i < NUM_SLOTS; i++) {
      expect(kit[i * 4 + 2], `slot ${i} has a number`).toBe(1);
      expect(createNumberAtlas()!.glyphRect(r.state.attrs[i]!.shirt, want, 0)).toBe(true);
      expect(Array.from(num.subarray(i * 4, i * 4 + 4))).toEqual(Array.from(want));
    }
    // One shared atlas per page: a second model reuses it.
    expect(createNumberAtlas()).toBe(createNumberAtlas());
    const tex = createNumberAtlas()!.texture;
    expect(tex.name).toBe('kit-numbers');
    // The model's torso material samples it; setNumberAtlas(null) keeps the default.
    r.model.setNumberAtlas(null);
    step(r);
    expect(kit[9 * 4 + 2]).toBe(1);
  });
});

describe('GFX-07 player model: high-contrast kits (Settings > Accessibility)', () => {
  it('setMatch wears the high-contrast kits when the setting is on; kits exposes what is worn', () => {
    const r = made(rig());
    expect(r.model.kits).toBeNull();
    r.ctx.settings = { ...r.ctx.settings, accessibility: { ...r.ctx.settings.accessibility, highContrastKits: true } };
    r.model.setMatch!(r.state, CLUBS);
    step(r);
    const hc = resolveMatchKits(r.state, CLUBS, true);
    expect(r.model.kits!.highContrast).toBe(true);
    expect(r.model.kits!.outfield[0].shirt).toBe(hc.outfield[0].shirt);
    expect(close(colourA(r, Part.TORSO, 3), linear(hc.outfield[0].shirt))).toBe(true);
    expect(close(colourA(r, Part.TORSO, 14), linear(hc.outfield[1].shirt))).toBe(true);
    const k1 = r.state.teams[1]!.keeperSlot;
    expect(close(colourA(r, Part.TORSO, k1), linear(hc.keeper[1].shirt))).toBe(true);
  });

  it('toggling the setting mid-match re-resolves the kits on the next frame (and back)', () => {
    const r = made(rig());
    r.model.setMatch!(r.state, CLUBS);
    step(r);
    const normal = resolveMatchKits(r.state, CLUBS, false);
    const hc = resolveMatchKits(r.state, CLUBS, true);
    expect(normal.outfield[0].shirt).not.toBe(hc.outfield[0].shirt); // the fixture actually changes
    expect(close(colourA(r, Part.TORSO, 3), linear(normal.outfield[0].shirt))).toBe(true);
    const on = { ...r.ctx.settings, accessibility: { ...r.ctx.settings.accessibility, highContrastKits: true } };
    r.ctx.settings = on;
    r.model.onSettings!(on);
    step(r);
    expect(r.model.kits!.highContrast).toBe(true);
    expect(close(colourA(r, Part.TORSO, 3), linear(hc.outfield[0].shirt))).toBe(true);
    expect(close(colourA(r, Part.PELVIS, 3), linear(hc.outfield[0].shorts))).toBe(true);
    const off = { ...on, accessibility: { ...on.accessibility, highContrastKits: false } };
    r.ctx.settings = off;
    r.model.onSettings!(off);
    step(r);
    expect(r.model.kits!.highContrast).toBe(false);
    expect(close(colourA(r, Part.TORSO, 3), linear(normal.outfield[0].shirt))).toBe(true);
  });
});

describe('GFX-07 player model: quality, lifecycle, debug hook', () => {
  it('players cast shadows only at the QUALITY tier (shadow map tier)', () => {
    const r = made(rig());
    for (const m of r.model.meshes) expect(m.castShadow).toBe(false);
    r.model.setQuality!(QualityTier.QUALITY);
    for (const m of r.model.meshes) expect(m.castShadow).toBe(true);
    r.model.setQuality!(QualityTier.PERFORMANCE);
    for (const m of r.model.meshes) expect(m.castShadow).toBe(false);
  });

  it('dispose removes the group from the scene', () => {
    const r = rig();
    r.model.dispose();
    expect(r.ctx.scene.getObjectByName('players')).toBeUndefined();
  });

  it('debug hook: close-up camera on a slot, hold a pose, joint positions, info', () => {
    (globalThis as { window?: unknown }).window = {};
    const r = made(rig());
    const dbg = (globalThis as unknown as { window: Window }).window.__dotkickPlayers!;
    expect(dbg).toBeDefined();
    r.model.setMatch!(r.state, CLUBS);
    const p = r.state.players[10]!;
    dbg.closeUp(10, 5, 180); // behind the player (he faces +x)
    const raise = createPose();
    raise[PoseIdx.SHOULDER_R_PITCH] = Math.PI;
    dbg.holdPose(10, raise);
    step(r);
    expect(r.ctx.camera.position.x).toBeCloseTo(p.x - 5, 4);
    expect(r.ctx.camera.position.z).toBeCloseTo(p.z, 4);
    const fwd = new Vector3(0, 0, -1).applyQuaternion(r.ctx.camera.quaternion);
    expect(fwd.x).toBeGreaterThan(0.9); // looking at him along +x
    // Hand raised overhead: the right elbow is above the shoulder.
    const el = dbg.joint(10, Joint.ELBOW_R), sh = dbg.joint(10, Joint.SHOULDER_R);
    expect(el[1]).toBeGreaterThan(sh[1]);
    const info = dbg.info();
    expect(info.drawCalls).toBe(8);
    expect(info.instances).toEqual([22, 22, 22, 44, 44, 44, 44, 44]);
    expect(info.trianglesPerPlayer * 22).toBeLessThanOrEqual(30_000);
    dbg.holdPose(10, null);
    dbg.closeUp(-1);
    step(r);
    expect(dbg.joint(10, Joint.ELBOW_R)[1]).toBeLessThan(sh[1]);
    r.model.dispose();
    open = open.filter((m) => m !== r.model);
    expect((globalThis as unknown as { window: Window }).window.__dotkickPlayers).toBeUndefined();
  });
});
