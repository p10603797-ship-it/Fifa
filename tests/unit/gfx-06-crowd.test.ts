/**
 * [GFX-06] Crowd in Node: the generated sprite atlas (views, arms up / down, masks, tile padding), fan sections, the
 * hashed instance order (density = even thinning), kit-derived colours, reaction envelopes and levels for every event
 * the crowd reacts to (GOAL both sides, SHOT, NEAR_MISS, POST after the half-time swap, SAVE, ATTACK_BUILD), and the
 * module in a headless scene (one draw call, triangle budget per tier, density and animation per tier, day / night
 * light, events -> uniforms and excitement, pause, high contrast, clear / dispose). The e2e spec gfx-06-crowd checks
 * the pictures (crowd, then a GOAL reaction).
 */
import { Color, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { QualityTier } from '../../src/contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../src/contracts/events';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import {
  ATLAS_H, ATLAS_TILES, ATLAS_W, CROWD_EVENT_SLOTS, CROWD_LEVELS, CROWD_TUNING, FAN_AWAY, FAN_HOME, FAN_NEUTRAL, LV_JUMP,
  LV_SIT, LV_STAND, buildCrowdAtlas, createCrowd, crowdFragmentShader, crowdLevels, crowdOrder, crowdVertexShader,
  decayCrowdBuild, envelope, excitementOf, fillCrowdColours, fillCrowdStatic, hash01, instancesFor, recordCrowdEvent,
  resetCrowdEvents, seatSection, setCrowdClock, type CrowdModule,
} from '../../src/render/crowd';
import { fillInterp } from '../../src/render/index';
import { resolveMatchKits } from '../../src/render/kits';
import { STAND_COUNT, STAND_CORNER_FAR_EAST, STAND_WEST, crowdLightOf, generateSeats, NIGHT_LOOK, DAY_LOOK } from '../../src/render/stadium';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

const T = CROWD_TUNING;
const TILE_W = ATLAS_W / ATLAS_TILES;

function makeCtx(tier = QualityTier.BALANCED, night = false): RenderContext {
  const s = createDefaultSettings();
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: new PerspectiveCamera(22, 1180 / 820, 2, 600),
    settings: s, clubs: [], size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier, cameraSettings: { ...s.camera },
    reducedMotion: false, night,
  };
}

function eventsOf(list: Partial<SimEvent>[]): EventBuffer {
  const evs: SimEvent[] = list.map((e) => ({ type: EventType.KICK, tick: 0, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0, ...e }));
  return {
    get count() { return evs.length; },
    get: (i: number) => evs[i]!,
    begin() { /* fixed */ },
    emit() { /* fixed */ },
  };
}

describe('GFX-06 sprite atlas', () => {
  const atlas = buildCrowdAtlas();
  const texel = (tile: number, i: number, j: number): [number, number, number, number] => {
    const o = (j * ATLAS_W + tile * TILE_W + i) * 4;
    return [atlas[o]!, atlas[o + 1]!, atlas[o + 2]!, atlas[o + 3]!];
  };
  const rowOf = (yMetres: number): number => Math.floor((yMetres / T.spriteHeight) * ATLAS_H);
  const coverageAbove = (tile: number, yMetres: number): number => {
    let a = 0;
    for (let j = rowOf(yMetres); j < ATLAS_H; j++) for (let i = 0; i < TILE_W; i++) a += texel(tile, i, j)[3];
    return a;
  };

  it('is a power-of-two RGBA atlas with four padded tiles (no colour bleeds into a neighbour tile)', () => {
    expect(atlas.length).toBe(ATLAS_W * ATLAS_H * 4);
    expect(ATLAS_W & (ATLAS_W - 1)).toBe(0);
    expect(ATLAS_H & (ATLAS_H - 1)).toBe(0);
    for (let tile = 0; tile < ATLAS_TILES; tile++) {
      for (let j = 0; j < ATLAS_H; j++) {
        expect(texel(tile, 0, j)[3], `tile ${tile} left column`).toBe(0);
        expect(texel(tile, TILE_W - 1, j)[3], `tile ${tile} right column`).toBe(0);
      }
      for (let i = 0; i < TILE_W; i++) expect(texel(tile, i, ATLAS_H - 1)[3]).toBe(0); // top row clear
    }
  });

  it('masks are premultiplied by coverage (shirt + skin + hair <= alpha), body is solid at the centre', () => {
    for (let i = 0; i < atlas.length; i += 4) {
      expect(atlas[i]! + atlas[i + 1]! + atlas[i + 2]!).toBeLessThanOrEqual(atlas[i + 3]! + 2);
    }
    for (let tile = 0; tile < ATLAS_TILES; tile++) {
      const torso = texel(tile, TILE_W / 2, rowOf(0.4));
      expect(torso[3]).toBe(255);
      expect(torso[0]).toBe(255); // shirt
    }
  });

  it('arms-up tiles reach above the head, arms-down tiles do not', () => {
    expect(coverageAbove(1, 1.16)).toBeGreaterThan(2000);
    expect(coverageAbove(3, 1.16)).toBeGreaterThan(2000);
    expect(coverageAbove(0, 1.16)).toBe(0);
    expect(coverageAbove(2, 1.16)).toBe(0);
  });

  it('front view shows a face (skin), back view shows hair at the same point', () => {
    const face = rowOf(0.97);
    const front = texel(0, TILE_W / 2, face), back = texel(2, TILE_W / 2, face);
    expect(front[1]).toBeGreaterThan(200); // skin
    expect(back[2]).toBeGreaterThan(200); // hair
    expect(back[1]).toBe(0);
  });
});

describe('GFX-06 sections, order and colours', () => {
  const seats = generateSeats();

  it('home fans are the majority, an away block exists (far-east corner), neutrals mixed in', () => {
    const n = [0, 0, 0];
    for (let i = 0; i < seats.count; i++) n[seatSection(seats.stand[i]!, seats.x[i]!, seats.z[i]!, hash01(i, 3))]!++;
    expect(n[FAN_HOME]!).toBeGreaterThan(n[FAN_AWAY]!);
    expect(n[FAN_AWAY]!).toBeGreaterThan(seats.count * 0.12);
    expect(n[FAN_NEUTRAL]!).toBeGreaterThan(seats.count * 0.1);
    expect(seatSection(STAND_WEST, -70, 0, 0.1)).toBe(FAN_HOME);
    expect(seatSection(STAND_CORNER_FAR_EAST, 70, -50, 0.1)).toBe(FAN_AWAY);
    expect(seatSection(STAND_CORNER_FAR_EAST, 70, -50, 0.99)).toBe(FAN_NEUTRAL);
  });

  it('instance order is a deterministic permutation; any density prefix thins every stand evenly', () => {
    const order = crowdOrder(seats.count);
    const seen = new Uint8Array(seats.count);
    for (let k = 0; k < order.length; k++) seen[order[k]!]!++;
    expect(seen.every((v) => v === 1)).toBe(true);
    expect(crowdOrder(seats.count)).toEqual(order);
    for (const d of [0.5, 0.75]) {
      const n = instancesFor(seats.count, d);
      const per = new Array<number>(STAND_COUNT).fill(0), all = new Array<number>(STAND_COUNT).fill(0);
      for (let i = 0; i < seats.count; i++) all[seats.stand[i]!]!++;
      for (let k = 0; k < n; k++) per[seats.stand[order[k]!]!]!++;
      for (let s = 0; s < STAND_COUNT; s++) {
        expect(Math.abs(per[s]! / all[s]! - d), `stand ${s} at density ${d}`).toBeLessThan(0.08);
      }
    }
    expect(instancesFor(100, 2)).toBe(100);
    expect(instancesFor(100, -1)).toBe(0);
    expect(instancesFor(100, Number.NaN)).toBe(0);
  });

  it('fans wear their club colours (resolved kits), the rest neutral clothes; skin tones vary', () => {
    const order = crowdOrder(seats.count);
    const aSeat = new Float32Array(seats.count * 4), aFace = new Float32Array(seats.count * 4), aColour = new Float32Array(seats.count * 4);
    fillCrowdStatic(seats, order, aSeat, aFace);
    const s = initMatch(createMatchConfig());
    const kits = resolveMatchKits(s, CLUBS);
    fillCrowdColours(aSeat, kits.outfield, aColour, seats.count);
    const lin = (hex: number): Color => new Color(hex);
    const near = (k: number, c: Color): boolean => {
      const o = k * 4;
      // the shade multiplier scales all channels alike: compare chromaticity
      const sum = aColour[o]! + aColour[o + 1]! + aColour[o + 2]!, cs = c.r + c.g + c.b;
      if (cs < 1e-3 || sum < 1e-3) return sum < 0.05 && cs < 0.05;
      return Math.abs(aColour[o]! / sum - c.r / cs) < 0.02 && Math.abs(aColour[o + 1]! / sum - c.g / cs) < 0.02;
    };
    for (const team of [FAN_HOME, FAN_AWAY]) {
      const shirt = lin(kits.outfield[team]!.shirt);
      let fans = 0, inShirt = 0;
      for (let k = 0; k < seats.count; k++) {
        if (aSeat[k * 4 + 3] !== team) continue;
        fans++;
        if (near(k, shirt)) inShirt++;
      }
      expect(fans).toBeGreaterThan(1000);
      expect(inShirt / fans, `team ${team}`).toBeGreaterThan(T.shirtShare - 0.08);
    }
    let skinMin = 1, skinMax = 0;
    for (let k = 0; k < seats.count; k++) {
      for (let c = 0; c < 4; c++) {
        expect(aColour[k * 4 + c]!).toBeGreaterThanOrEqual(0);
        expect(aColour[k * 4 + c]!).toBeLessThanOrEqual(1);
      }
      skinMin = Math.min(skinMin, aColour[k * 4 + 3]!);
      skinMax = Math.max(skinMax, aColour[k * 4 + 3]!);
    }
    expect(skinMax - skinMin).toBeGreaterThan(0.9);
  });
});

describe('GFX-06 reactions', () => {
  const state = initMatch(createMatchConfig());
  const lv = new Float32Array(CROWD_LEVELS);
  const fresh = (): Float64Array => { const ev = new Float64Array(CROWD_EVENT_SLOTS); resetCrowdEvents(ev); return ev; };
  const rec = (ev: Float64Array, now: number, type: EventType, a: number, c: number, st: typeof state | null): boolean => {
    setCrowdClock(ev, now);
    return recordCrowdEvent(ev, { type, a, c }, st);
  };
  const lvAt = (ev: Float64Array, now: number, out: Float32Array): Float32Array => {
    setCrowdClock(ev, now);
    return crowdLevels(ev, out);
  };

  it('envelope ramps, holds, falls and is 0 outside', () => {
    const env = [0.5, 1, 2];
    expect(envelope(-0.1, env)).toBe(0);
    expect(envelope(0.25, env)).toBeCloseTo(0.5);
    expect(envelope(1, env)).toBe(1);
    expect(envelope(2.5, env)).toBeCloseTo(0.5);
    expect(envelope(3.6, env)).toBe(0);
    expect(envelope(Number.NaN, env)).toBe(0);
  });

  it('no events: everyone seated and calm', () => {
    lvAt(fresh(), 10, lv);
    expect(Array.from(lv).every((v) => v === 0)).toBe(true);
    expect(excitementOf(lv)).toBe(0);
  });

  it('GOAL: the scoring side jumps and cheers, the other side slumps, neutrals half-cheer; it fades out', () => {
    for (const scorer of [0, 1]) {
      const ev = fresh();
      expect(rec(ev, 5, EventType.GOAL, scorer, -1, state)).toBe(true);
      lvAt(ev, 6, lv);
      expect(lv[LV_JUMP + scorer]).toBe(1);
      expect(lv[LV_JUMP + (1 - scorer)]).toBe(0);
      expect(lv[LV_SIT + (1 - scorer)]).toBe(1);
      expect(lv[LV_SIT + scorer]).toBe(0);
      expect(lv[LV_JUMP + FAN_NEUTRAL]).toBeCloseTo(T.neutralShare);
      expect(excitementOf(lv)).toBe(1);
      const end = 5 + T.goalEnv[0]! + T.goalEnv[1]! + T.goalEnv[2]! + 0.01;
      lvAt(ev, end, lv);
      expect(Array.from(lv).every((v) => v === 0)).toBe(true);
    }
  });

  it('SHOT: the attacking side rises; NEAR_MISS: everybody up, attackers most', () => {
    const ev = fresh();
    rec(ev, 1, EventType.SHOT, PLAYERS_PER_TEAM + 9, 0.3, state); // away shooter
    lvAt(ev, 1.5, lv);
    expect(lv[LV_STAND + FAN_AWAY]).toBeCloseTo(T.shotAttack);
    expect(lv[LV_STAND + FAN_HOME]).toBeCloseTo(T.shotDefend);
    expect(lv[LV_JUMP + FAN_AWAY]).toBe(0);
    const ev2 = fresh();
    rec(ev2, 1, EventType.NEAR_MISS, 9, 1.2, state); // home shooter
    lvAt(ev2, 1.6, lv);
    expect(lv[LV_STAND + FAN_HOME]).toBeCloseTo(T.missAttack);
    expect(lv[LV_STAND + FAN_AWAY]).toBeCloseTo(T.missDefend);
    expect(lv[LV_STAND + FAN_NEUTRAL]!).toBeGreaterThan(0.5);
  });

  it('POST: the side attacking that end rises, also after the half-time swap', () => {
    const s = initMatch(createMatchConfig());
    const ev = fresh();
    const homeAttacks = s.teams[0]!.dir; // +1: home attacks the goal at +x
    rec(ev, 0, EventType.POST, homeAttacks, 9, s);
    lvAt(ev, 0.5, lv);
    expect(lv[LV_STAND + FAN_HOME]).toBeCloseTo(T.missAttack);
    (s.teams[0] as { dir: number }).dir = -homeAttacks;
    (s.teams[1] as { dir: number }).dir = homeAttacks;
    const ev2 = fresh();
    rec(ev2, 0, EventType.POST, homeAttacks, 9, s);
    lvAt(ev2, 0.5, lv);
    expect(lv[LV_STAND + FAN_AWAY]).toBeCloseTo(T.missAttack);
  });

  it('SAVE: the keeper\'s side cheers briefly, the shooters\' side sits back', () => {
    const ev = fresh();
    rec(ev, 2, EventType.SAVE, PLAYERS_PER_TEAM, 20, state); // away keeper
    lvAt(ev, 2.8, lv);
    expect(lv[LV_JUMP + FAN_AWAY]).toBeCloseTo(T.saveCheer);
    expect(lv[LV_SIT + FAN_HOME]).toBeCloseTo(T.saveSit);
  });

  it('ATTACK_BUILD: the attacking side gets up with the intensity, then it decays', () => {
    const ev = fresh();
    rec(ev, 0, EventType.ATTACK_BUILD, 1, 0.8, state);
    rec(ev, 0, EventType.ATTACK_BUILD, 1, 0.4, state); // keeps the max
    lvAt(ev, 0, lv);
    expect(lv[LV_STAND + FAN_AWAY]).toBeCloseTo(0.8 * T.buildStand);
    expect(lv[LV_STAND + FAN_HOME]).toBe(0);
    decayCrowdBuild(ev, 10);
    lvAt(ev, 10, lv);
    expect(lv[LV_STAND + FAN_AWAY]).toBe(0);
  });

  it('ignores events it does not react to and invalid slots', () => {
    const ev = fresh();
    expect(rec(ev, 0, EventType.KICK, 3, 0, state)).toBe(false);
    expect(rec(ev, 0, EventType.SHOT, -1, 0, state)).toBe(false);
    lvAt(ev, 0.5, lv);
    expect(excitementOf(lv)).toBe(0);
  });
});

describe('GFX-06 module (headless scene)', () => {
  function rig(tier = QualityTier.BALANCED, night = false) {
    const ctx = makeCtx(tier, night);
    const crowd = createCrowd(ctx) as CrowdModule & { mesh: import('three').Mesh; debug: NonNullable<CrowdModule['debug']> };
    const s = initMatch(createMatchConfig());
    const interp = createInterpState();
    fillInterp(interp, s, s, 1);
    const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
    const run = (sec: number): void => { for (let i = 0; i < Math.round(sec * 60); i++) crowd.update(frame); };
    return { ctx, crowd, s, frame, run };
  }
  type U = Record<string, { value: unknown }>;
  const uniformsOf = (c: { mesh: import('three').Mesh }): U => (c.mesh.material as unknown as { uniforms: U }).uniforms;

  it('one instanced draw call, hidden until setMatch, triangle budget at the default tier', () => {
    const { ctx, crowd, s } = rig();
    expect(ctx.scene.children).toContain(crowd.mesh);
    expect(crowd.debug.snapshot().drawCalls).toBe(0);
    crowd.setMatch!(s, CLUBS);
    const snap = crowd.debug.snapshot();
    expect(snap.drawCalls).toBe(1);
    expect(snap.seats).toBe(generateSeats().count);
    expect(snap.triangles).toBeLessThanOrEqual(60_000);
    expect(snap.triangles).toBeGreaterThan(10_000); // thousands of spectators
    expect(snap.instances).toBe(instancesFor(snap.seats, 0.75));
  });

  it('density and animation follow the quality tier (GFX-02 getTierParams)', () => {
    const { crowd, s } = rig(QualityTier.PERFORMANCE);
    crowd.setMatch!(s, CLUBS);
    const u = uniformsOf(crowd);
    const seats = generateSeats().count;
    expect(crowd.debug.snapshot().instances).toBe(instancesFor(seats, 0.5));
    expect(u.uAnim!.value).toBe(0);
    crowd.setQuality!(QualityTier.QUALITY);
    expect(crowd.debug.snapshot().instances).toBe(seats);
    expect(u.uAnim!.value).toBe(1);
    expect(crowd.debug.snapshot().triangles).toBeLessThanOrEqual(2 * seats);
    crowd.setQuality!(QualityTier.BALANCED);
    expect(crowd.debug.snapshot().instances).toBe(instancesFor(seats, 0.75));
  });

  it('a GOAL drives the uniforms: scoring side jumps, other side sits; excitement rises then settles; pause freezes', () => {
    const { crowd, s, frame, run } = rig();
    crowd.setMatch!(s, CLUBS);
    run(1);
    const u = uniformsOf(crowd);
    expect((u.uJump!.value as Vector3).x).toBe(0);
    crowd.onEvents!(eventsOf([{ type: EventType.GOAL, a: 1, b: 20, c: -1 }]), s);
    run(1);
    expect((u.uJump!.value as Vector3).y).toBe(1);
    expect((u.uSit!.value as Vector3).x).toBe(1);
    expect((u.uJump!.value as Vector3).x).toBe(0);
    expect(crowd.excitement).toBeGreaterThan(0.9);
    frame.frame.paused = true;
    const clock = crowd.debug.snapshot().clock;
    run(3);
    expect(crowd.debug.snapshot().clock).toBe(clock);
    frame.frame.paused = false;
    run(12);
    expect((u.uJump!.value as Vector3).y).toBe(0);
    expect(crowd.excitement).toBeLessThan(0.05);
    // a long tab-switch frame advances at most maxDt
    frame.frame.dtMs = 5000;
    const c0 = crowd.debug.snapshot().clock;
    crowd.update(frame);
    expect(crowd.debug.snapshot().clock - c0).toBeCloseTo(T.maxDt, 6);
  });

  it('night light is darker than day light (matches the stadium look)', () => {
    const day = rig(QualityTier.BALANCED, false), night = rig(QualityTier.BALANCED, true);
    day.crowd.setMatch!(day.s, CLUBS);
    night.crowd.setMatch!(night.s, CLUBS);
    const dl = uniformsOf(day.crowd).uLight!.value as Color, nl = uniformsOf(night.crowd).uLight!.value as Color;
    expect(dl.equals(crowdLightOf(DAY_LOOK, new Color()))).toBe(true);
    expect(nl.equals(crowdLightOf(NIGHT_LOOK, new Color()))).toBe(true);
    expect(nl.r + nl.g + nl.b).toBeLessThan(dl.r + dl.g + dl.b);
  });

  it('high-contrast kits recolour the fans; clearMatch hides and resets; dispose removes the mesh', () => {
    const { ctx, crowd, s, run } = rig();
    crowd.setMatch!(s, CLUBS);
    const attr = crowd.mesh.geometry.getAttribute('aColour') as import('three').BufferAttribute;
    const before = Float32Array.from(attr.array as Float32Array);
    const v0 = attr.version;
    const hc = createDefaultSettings();
    hc.accessibility.highContrastKits = true;
    crowd.onSettings!(hc);
    expect(attr.version).toBeGreaterThan(v0);
    let diff = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== (attr.array as Float32Array)[i]) diff++;
    expect(diff).toBeGreaterThan(0);
    crowd.onEvents!(eventsOf([{ type: EventType.GOAL, a: 0 }]), s);
    run(0.5);
    crowd.clearMatch!();
    expect(crowd.mesh.visible).toBe(false);
    expect(crowd.excitement).toBe(0);
    crowd.dispose();
    expect(ctx.scene.children).not.toContain(crowd.mesh);
  });

  it('shaders: billboard toward the camera, per-section uniforms, alpha-tested atlas, output colour space', () => {
    const v = crowdVertexShader(), fr = crowdFragmentShader();
    for (const name of ['aSeat', 'aFace', 'aColour', 'uStand', 'uJump', 'uSit', 'uTime', 'uAnim', 'cameraPosition']) expect(v).toContain(name);
    expect(fr).toContain('discard');
    expect(fr).toContain('#include <colorspace_fragment>');
    expect(v).not.toMatch(/\d\.\d*\.\d/); // numbers formatted as GLSL floats
  });
});
