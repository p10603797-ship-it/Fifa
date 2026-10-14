/**
 * [GFX-05] Stadium in Node: seat generation (count, bounds, on the treads, facing the pitch, spacing, every stand),
 * stand / roof / tower geometry (budget, finite, outward normals, front walls on the sim's stand walls), the camera
 * envelope regression ("Camera: dipping into the stand"), the near stand under the broadcast view, the boards (front
 * faces on the sim's board lines at the sim's board height, LED text never mirrored), the generated board artwork
 * (invented words only) and the module in a headless scene (one key light + ambient, day / night looks, quality-tier
 * shadow map, draw-call and triangle budgets, LED scroll, debug views, clear / dispose).
 * The e2e spec gfx-05-stadium checks the pictures.
 */
import { AmbientLight, Color, DirectionalLight, HemisphereLight, Light, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { BOARD_X, BOARD_Z, HALF_WIDTH, WORLD_MAX_X, WORLD_MAX_Z } from '../../src/contracts/constants';
import { CameraType, QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig } from '../../src/contracts/state';
import { cameraEnvelope, type CameraEnvelope } from '../../src/render/camera/broadcast';
import { CROWD_TUNING } from '../../src/render/crowd';
import { fillInterp } from '../../src/render/index';
import {
  BOARD_BRANDS, BOARD_DARK_V, BOARD_STRIP_LENGTH, BOARD_STRIP_V0, DAY_LOOK, NIGHT_LOOK, PROFILE_MAIN, PROFILE_NEAR,
  STADIUM_TUNING, STADIUM_VIEWS, STANDS, STAND_COUNT, STAND_NEAR, buildBoardSoup, buildLampSoup, buildStandSoup,
  createStadium, crowdLightOf, drawBoardStrip, generateSeats, roofProfile, standProfile, towerLayout, type Board2D,
  type SoupBuilder,
} from '../../src/render/stadium';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { BALL_CONTACT_TUNING } from '../../src/sim/ball/contact';
import { initMatch } from '../../src/sim/init';

const T = STADIUM_TUNING;

function makeCtx(tier = QualityTier.BALANCED, night = false): RenderContext {
  const s = createDefaultSettings();
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: new PerspectiveCamera(22, 1180 / 820, 2, 600),
    settings: s, clubs: [], size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier, cameraSettings: { ...s.camera },
    reducedMotion: false, night,
  };
}

function triCount(b: SoupBuilder): number {
  return b.pos.length / 9;
}

/** Profile surface height at depth d (the top of the stepped polyline; max over vertical steps). */
function profileHeightAt(pts: number[], d: number): number {
  let h = 0;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const d0 = pts[i]!, h0 = pts[i + 1]!, d1 = pts[i + 2]!, h1 = pts[i + 3]!;
    if (d < Math.min(d0, d1) - 1e-6 || d > Math.max(d0, d1) + 1e-6) continue;
    const v = d1 === d0 ? Math.max(h0, h1) : h0 + ((d - d0) / (d1 - d0)) * (h1 - h0);
    if (v > h) h = v;
  }
  return h;
}

describe('GFX-05 seats (crowd layout for GFX-06)', () => {
  const seats = generateSeats();

  it('generates thousands of seats with finite values, every stand populated, deterministic and cached', () => {
    expect(seats.count).toBeGreaterThan(10_000);
    expect(seats.count).toBeLessThan(20_000);
    for (const arr of [seats.x, seats.y, seats.z, seats.fx, seats.fz]) {
      expect(arr.length).toBe(seats.count);
      for (let i = 0; i < arr.length; i++) expect(Number.isFinite(arr[i]!)).toBe(true);
    }
    const perStand = new Array<number>(STAND_COUNT).fill(0);
    for (let i = 0; i < seats.count; i++) perStand[seats.stand[i]!]!++;
    for (let s = 0; s < STAND_COUNT; s++) expect(perStand[s], `stand ${s}`).toBeGreaterThan(50);
    expect(generateSeats()).toBe(seats);
  });

  it('every seat is in the stands: outside the world bounds (stand walls), inside the bowl, above the front wall', () => {
    const main = standProfile(PROFILE_MAIN);
    for (let i = 0; i < seats.count; i++) {
      const x = seats.x[i]!, z = seats.z[i]!, y = seats.y[i]!;
      expect(Math.abs(x) > WORLD_MAX_X || Math.abs(z) > WORLD_MAX_Z, `seat ${i} at ${x}, ${z}`).toBe(true);
      expect(Math.abs(x)).toBeLessThan(WORLD_MAX_X + main.depth + 0.01);
      expect(Math.abs(z)).toBeLessThan(WORLD_MAX_Z + main.depth + 0.01);
      expect(y).toBeGreaterThanOrEqual(T.frontWallHeight);
      expect(y).toBeLessThan(main.top);
    }
  });

  it('seats face the pitch with unit horizontal facings', () => {
    for (let i = 0; i < seats.count; i++) {
      const fx = seats.fx[i]!, fz = seats.fz[i]!;
      expect(Math.abs(Math.hypot(fx, fz) - 1)).toBeLessThan(1e-5);
      // Facing points back toward the pitch rectangle (from the seat toward the nearest point of the stand front).
      const nx = Math.max(-WORLD_MAX_X, Math.min(WORLD_MAX_X, seats.x[i]!)) - seats.x[i]!;
      const nz = Math.max(-WORLD_MAX_Z, Math.min(WORLD_MAX_Z, seats.z[i]!)) - seats.z[i]!;
      expect(fx * nx + fz * nz, `seat ${i}`).toBeGreaterThan(0);
    }
  });

  it('seats sit on the treads of their stand profile (spectators stand on the steps, never float or sink)', () => {
    const profiles = [standProfile(PROFILE_MAIN), standProfile(PROFILE_NEAR)];
    for (let i = 0; i < seats.count; i += 7) {
      const st = STANDS[seats.stand[i]!]!;
      const p = profiles[st.profile]!;
      // depth of the seat from the stand front (straight: distance past the front line; arc: radius from the corner)
      const d = st.arc
        ? Math.hypot(seats.x[i]! - st.ax, seats.z[i]! - st.az)
        : (seats.x[i]! - st.ax) * st.nx + (seats.z[i]! - st.az) * st.nz;
      expect(Math.abs(profileHeightAt(p.pts, d) - seats.y[i]!), `seat ${i}`).toBeLessThan(1e-3);
    }
  });

  it('neighbouring seats are at least one seat pitch apart (no stacked spectators)', () => {
    const cell = 1;
    const grid = new Map<string, number[]>();
    const key = (x: number, y: number, z: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    for (let i = 0; i < seats.count; i++) {
      const k = key(seats.x[i]!, seats.y[i]!, seats.z[i]!);
      const l = grid.get(k);
      if (l) l.push(i); else grid.set(k, [i]);
    }
    let minD = Infinity;
    for (let i = 0; i < seats.count; i++) {
      const cx = Math.floor(seats.x[i]! / cell), cy = Math.floor(seats.y[i]! / cell), cz = Math.floor(seats.z[i]! / cell);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
        const l = grid.get(`${cx + a},${cy + b},${cz + c}`);
        if (!l) continue;
        for (const j of l) {
          if (j <= i) continue;
          const d = Math.hypot(seats.x[i]! - seats.x[j]!, seats.y[i]! - seats.y[j]!, seats.z[i]! - seats.z[j]!);
          if (d < minD) minD = d;
        }
      }
    }
    expect(minD).toBeGreaterThan(T.seatPitch * 0.62);
  });
});

describe('GFX-05 stand geometry', () => {
  const soup = buildStandSoup();

  it('stands + roofs + towers stay inside the budget, finite, with unit outward normals', () => {
    const tris = triCount(soup) + triCount(buildLampSoup()) + triCount(buildBoardSoup());
    expect(tris).toBeLessThan(40_000);
    expect(tris).toBeGreaterThan(1_000);
    for (let i = 0; i < soup.pos.length; i++) expect(Number.isFinite(soup.pos[i]!)).toBe(true);
    for (let i = 0; i < soup.nrm.length; i += 3) {
      expect(Math.abs(Math.hypot(soup.nrm[i]!, soup.nrm[i + 1]!, soup.nrm[i + 2]!) - 1)).toBeLessThan(1e-4);
    }
    // Winding agrees with the normals (front faces outward).
    for (let t = 0; t < soup.pos.length; t += 9) {
      const p = soup.pos;
      const e1 = [p[t + 3]! - p[t]!, p[t + 4]! - p[t + 1]!, p[t + 5]! - p[t + 2]!];
      const e2 = [p[t + 6]! - p[t]!, p[t + 7]! - p[t + 1]!, p[t + 8]! - p[t + 2]!];
      const g = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const n = soup.nrm;
      const dot = g[0]! * (n[t]! + n[t + 3]! + n[t + 6]!) + g[1]! * (n[t + 1]! + n[t + 4]! + n[t + 7]!) + g[2]! * (n[t + 2]! + n[t + 5]! + n[t + 8]!);
      expect(dot).toBeGreaterThan(0);
    }
    for (let i = 0; i < soup.col.length; i++) expect(soup.col[i]!).toBeGreaterThanOrEqual(0);
  });

  it('nothing of the bowl comes inside the stand walls at the world bounds (the ball and players area stays clear)', () => {
    for (let i = 0; i < soup.pos.length; i += 3) {
      const x = soup.pos[i]!, y = soup.pos[i + 1]!, z = soup.pos[i + 2]!;
      expect(y).toBeGreaterThanOrEqual(-1e-6);
      const inside = Math.abs(x) < WORLD_MAX_X - 1e-3 && Math.abs(z) < WORLD_MAX_Z - 1e-3;
      expect(inside, `vertex ${x}, ${y}, ${z}`).toBe(false);
    }
  });

  it('profiles: monotone depth, the main profile has two tiers and a roof above the back wall; near is one low tier', () => {
    for (const kind of [PROFILE_MAIN, PROFILE_NEAR]) {
      const p = standProfile(kind);
      for (let i = 2; i < p.pts.length; i += 2) expect(p.pts[i]!).toBeGreaterThanOrEqual(p.pts[i - 2]!);
      expect(p.colours.length).toBe(p.pts.length / 2 - 1);
    }
    const main = standProfile(PROFILE_MAIN), near = standProfile(PROFILE_NEAR);
    expect(main.rows.length / 4).toBe(T.lowerRows + T.upperRows);
    expect(near.rows.length / 4).toBe(T.nearRows);
    expect(near.top).toBeLessThan(main.top / 2);
    const roof = roofProfile(main);
    expect(Math.min(roof.pts[1]!, roof.pts[3]!, roof.pts[5]!, roof.pts[7]!)).toBeGreaterThanOrEqual(main.top - 1e-9); // rests on the back wall
  });

  it('Camera: dipping into the stand — no stand, roof or tower vertex inside any camera envelope (+ near plane)', () => {
    const all: SoupBuilder[] = [soup, buildLampSoup()];
    const env: CameraEnvelope = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    const margin = 2.5; // camera near plane 2 m plus slack
    for (const type of [CameraType.BROADCAST, CameraType.WIDE, CameraType.CLOSE, CameraType.END_TO_END]) {
      cameraEnvelope(type, env);
      for (const b of all) {
        for (let i = 0; i < b.pos.length; i += 3) {
          const x = b.pos[i]!, y = b.pos[i + 1]!, z = b.pos[i + 2]!;
          const inBox = x > env.minX - margin && x < env.maxX + margin && y > env.minY - margin && y < env.maxY + margin
            && z > env.minZ - margin && z < env.maxZ + margin;
          expect(inBox, `type ${type}: vertex ${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)}`).toBe(false);
        }
      }
    }
  });

  it('the near stand and a cheering crowd on it never hide the pitch from the broadcast camera (sightline test)', () => {
    // A sightline from the camera (z_c, y_c) to a ground point at z_g crosses z_p at y = y_c (z_p - z_g) / (z_c - z_g),
    // whatever the x. The lowest line over the near stand comes from the lowest camera (envelope minY) at its farthest
    // z to the NEAREST ground target that matters: the near touchline (z = HALF_WIDTH 34). Every near-stand vertex and
    // every near-side spectator top (sprite height + cheer bounce, standing) must stay under it. Geometry past
    // |x| = WORLD_MAX_X (near corners, towers) is never crossed: the camera stays within |x| <= followClamp and the
    // targets within the world, so every sightline keeps |x| <= WORLD_MAX_X.
    const env: CameraEnvelope = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    const crowdTop = CROWD_TUNING.spriteHeight + CROWD_TUNING.bounceHeight;
    const seats = generateSeats();
    const zg = HALF_WIDTH;
    let checked = 0;
    for (const type of [CameraType.BROADCAST, CameraType.WIDE, CameraType.CLOSE]) {
      cameraEnvelope(type, env);
      expect(env.maxX).toBeLessThan(WORLD_MAX_X);
      const line = (zp: number): number => (env.minY * (zp - zg)) / (env.maxZ - zg);
      for (let i = 0; i < soup.pos.length; i += 3) {
        const x = soup.pos[i]!, z = soup.pos[i + 2]!;
        if (z <= WORLD_MAX_Z || z >= env.minZ || Math.abs(x) > WORLD_MAX_X) continue;
        expect(soup.pos[i + 1]!, `type ${type} vertex at z ${z}`).toBeLessThan(line(z));
        checked++;
      }
      for (let i = 0; i < seats.count; i++) {
        if (seats.stand[i] !== STAND_NEAR) continue;
        expect(seats.y[i]! + crowdTop, `type ${type} seat ${i}`).toBeLessThan(line(seats.z[i]!));
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('floodlight towers stand behind the four corners, outside the bowl, lamps aimed at the pitch', () => {
    const tl = towerLayout();
    expect(tl.length / 8).toBe(4);
    for (let i = 0; i < tl.length; i += 8) {
      const x = tl[i]!, z = tl[i + 1]!;
      expect(Math.abs(x)).toBeGreaterThan(WORLD_MAX_X);
      expect(Math.abs(z)).toBeGreaterThan(WORLD_MAX_Z);
      // forward points toward the pitch centre and down
      expect(tl[i + 5]! * -x + tl[i + 7]! * -z).toBeGreaterThan(0);
      expect(tl[i + 6]!).toBeLessThan(0);
    }
  });
});

describe('GFX-05 advertising boards', () => {
  const b = buildBoardSoup();

  it('board front faces lie exactly on the sim board lines, sim board height, facing the pitch', () => {
    expect(T.boardHeight).toBe(BALL_CONTACT_TUNING.boardHeight);
    let fronts = 0;
    for (let t = 0; t < b.pos.length; t += 9) {
      const nx = b.nrm[t]!, ny = b.nrm[t + 1]!, nz = b.nrm[t + 2]!;
      if (ny !== 0) continue;
      const x = b.pos[t]!, z = b.pos[t + 2]!;
      // front faces point toward the pitch centre
      const inward = nx * -x + nz * -z > 0;
      if (!inward) continue;
      fronts++;
      for (let k = 0; k < 3; k++) {
        const vx = b.pos[t + k * 3]!, vy = b.pos[t + k * 3 + 1]!, vz = b.pos[t + k * 3 + 2]!;
        if (nx !== 0) expect(Math.abs(vx)).toBeCloseTo(BOARD_X, 6);
        if (nz !== 0) expect(Math.abs(vz)).toBeCloseTo(BOARD_Z, 6);
        expect(vy === 0 || Math.abs(vy - BALL_CONTACT_TUNING.boardHeight) < 1e-6).toBe(true);
      }
    }
    expect(fronts).toBe(8); // four boards, two triangles each
  });

  it('LED text reads left to right from the pitch on every board (u grows along the viewer\'s right)', () => {
    for (let t = 0; t < b.pos.length; t += 9) {
      const nx = b.nrm[t]!, nz = b.nrm[t + 2]!;
      if (b.nrm[t + 1] !== 0 || nx * -b.pos[t]! + nz * -b.pos[t + 2]! <= 0) continue;
      // viewer looks along -n; right = (-n) x up = (n.z, 0, -n.x)
      const rx = nz, rz = -nx;
      const uv = b.uv!;
      const ti = t / 9;
      for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) {
        const pa = (b.pos[t + a * 3]! * rx + b.pos[t + a * 3 + 2]! * rz), pc = (b.pos[t + c * 3]! * rx + b.pos[t + c * 3 + 2]! * rz);
        if (pc - pa > 1) expect(uv[ti * 6 + c * 2]!).toBeGreaterThan(uv[ti * 6 + a * 2]!);
      }
      // the strip is mapped at its true aspect: u per metre = 1 / strip length
      const v = uv[ti * 6 + 1]!;
      expect(v === BOARD_STRIP_V0 || v === 1).toBe(true);
    }
    expect(BOARD_STRIP_LENGTH).toBeCloseTo(T.panelLength * BOARD_BRANDS.length, 6);
    // top / back faces sample the dark body
    for (let t = 0; t < b.pos.length; t += 9) {
      const nx = b.nrm[t]!, nz = b.nrm[t + 2]!;
      const front = b.nrm[t + 1] === 0 && nx * -b.pos[t]! + nz * -b.pos[t + 2]! > 0;
      if (!front) expect(b.uv![(t / 9) * 6 + 1]).toBeCloseTo(BOARD_DARK_V, 6);
    }
  });

  it('board artwork is original: eight invented words, no real sponsor, every panel drawn', () => {
    const calls: { op: string; args: unknown[] }[] = [];
    const g = new Proxy({ fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'top' } as unknown as Board2D, {
      get(target, prop) {
        if (prop in target) return (target as unknown as Record<string | symbol, unknown>)[prop];
        return (...args: unknown[]) => { calls.push({ op: String(prop), args }); };
      },
      set(target, prop, value) { (target as unknown as Record<string | symbol, unknown>)[prop] = value; return true; },
    });
    drawBoardStrip(g, 4096, 128);
    const words = calls.filter((c) => c.op === 'fillText').map((c) => c.args[0] as string);
    expect(words).toEqual([...BOARD_BRANDS]);
    expect(new Set(BOARD_BRANDS).size).toBe(8);
    const REAL = ['NIKE', 'ADIDAS', 'PUMA', 'EMIRATES', 'COCA', 'PEPSI', 'VISA', 'MASTERCARD', 'HEINEKEN', 'FIFA', 'UEFA', 'SONY',
      'SAMSUNG', 'QATAR', 'ETIHAD', 'GAZPROM', 'MCDONALD', 'BUDWEISER', 'KIA', 'HYUNDAI', 'EA SPORTS', 'KONAMI', 'PREMIER',
      'LALIGA', 'BUNDESLIGA', 'CARLSBERG', 'UMBRO', 'KAPPA', 'NEW BALANCE', 'UNDER ARMOUR', 'RED BULL', 'AUDI', 'BMW', 'TOYOTA'];
    for (const w of BOARD_BRANDS) for (const r of REAL) expect(w.includes(r) || r.includes(w)).toBe(false);
    // one background rect per panel (plus the body and seams), logos drawn as paths
    expect(calls.filter((c) => c.op === 'fillRect').length).toBeGreaterThanOrEqual(1 + 2 * BOARD_BRANDS.length);
    expect(calls.filter((c) => c.op === 'fill' || c.op === 'stroke').length).toBeGreaterThanOrEqual(BOARD_BRANDS.length);
  });
});

describe('GFX-05 module (headless scene)', () => {
  function rig(tier = QualityTier.BALANCED, night = false) {
    const ctx = makeCtx(tier, night);
    const st = createStadium(ctx);
    const cfg = createMatchConfig();
    cfg.night = night ? 1 : 0;
    const s = initMatch(cfg);
    const interp = createInterpState();
    fillInterp(interp, s, s, 1);
    const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
    return { ctx, st, s, frame };
  }

  it('one directional light and one ambient light, nothing else; hidden until setMatch', () => {
    const { ctx, st, s } = rig();
    const lights: Light[] = [];
    ctx.scene.traverse((o) => { if ((o as Light).isLight) lights.push(o as Light); });
    expect(lights.filter((l) => l instanceof DirectionalLight)).toHaveLength(1);
    expect(lights.filter((l) => l instanceof AmbientLight)).toHaveLength(1);
    expect(lights.filter((l) => l instanceof HemisphereLight)).toHaveLength(0);
    expect(lights).toHaveLength(2);
    expect(st.root.visible).toBe(false);
    expect(st.debug.snapshot().drawCalls).toBe(0);
    st.setMatch!(s, []);
    expect(st.root.visible).toBe(true);
  });

  it('day: <= 10 draw calls and <= 40k triangles, no halos, no shadow map at the default tier', () => {
    const { st, s } = rig();
    st.setMatch!(s, []);
    const snap = st.debug.snapshot();
    expect(snap.night).toBe(false);
    expect(snap.drawCalls).toBeLessThanOrEqual(10);
    expect(snap.drawCalls).toBe(5);
    expect(snap.triangles).toBeLessThanOrEqual(40_000);
    expect(st.halos.visible).toBe(false);
    expect(st.sun.castShadow).toBe(false);
    expect(st.sun.color.getHex()).toBe(new Color(DAY_LOOK.sunColour).getHex());
  });

  it('floodlit night: darker sky and ambient, floodlight-coloured key light, glowing lamps with halos, still in budget', () => {
    const { st, s, ctx } = rig(QualityTier.BALANCED, true);
    st.setMatch!(s, []);
    const snap = st.debug.snapshot();
    expect(snap.night).toBe(true);
    expect(snap.drawCalls).toBe(6);
    expect(snap.triangles).toBeLessThanOrEqual(40_000);
    expect(st.halos.visible).toBe(true);
    expect(st.look).toBe(NIGHT_LOOK);
    const lum = (hex: number): number => { const c = new Color(hex); return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; };
    expect(lum(NIGHT_LOOK.skyTop)).toBeLessThan(lum(DAY_LOOK.skyTop) * 0.2);
    expect(lum(NIGHT_LOOK.skyHorizon)).toBeLessThan(lum(DAY_LOOK.skyHorizon) * 0.3);
    expect(NIGHT_LOOK.ambientIntensity).toBeLessThan(DAY_LOOK.ambientIntensity);
    expect(lum(NIGHT_LOOK.lampColour)).toBeGreaterThan(lum(DAY_LOOK.lampColour));
    // cool-white floodlight key: blue >= red
    const key = new Color(NIGHT_LOOK.sunColour);
    expect(key.b).toBeGreaterThanOrEqual(key.r);
    expect((ctx.scene.background as Color).getHex()).toBe(new Color(NIGHT_LOOK.skyHorizon).getHex());
    // the crowd light follows the look: darker at night
    const d = crowdLightOf(DAY_LOOK, new Color()), n = crowdLightOf(NIGHT_LOOK, new Color());
    expect(n.r + n.g + n.b).toBeLessThan(d.r + d.g + d.b);
    expect(d.r).toBeGreaterThan(0.5);
    expect(d.r).toBeLessThan(1.2);
    // floodlit night: the bowl is darker than the pitch (stand material scaled), the pitch keeps the key light
    expect((st.stands.material as import('three').MeshLambertMaterial).color.r).toBeCloseTo(NIGHT_LOOK.standLight, 6);
    expect(NIGHT_LOOK.standLight).toBeLessThan(0.7);
    expect(DAY_LOOK.standLight).toBe(1);
  });

  it('quality tiers: QUALITY casts one shadow map from the key light (GFX-02 params), other tiers none', () => {
    const { st, s } = rig(QualityTier.QUALITY);
    st.setMatch!(s, []);
    expect(st.sun.castShadow).toBe(true);
    expect(st.sun.shadow.mapSize.x).toBe(1024);
    expect(st.debug.snapshot().shadowMapSize).toBe(1024);
    st.setQuality!(QualityTier.BALANCED);
    expect(st.sun.castShadow).toBe(false);
    st.setQuality!(QualityTier.PERFORMANCE);
    expect(st.sun.castShadow).toBe(false);
    st.setQuality!(QualityTier.QUALITY);
    expect(st.sun.castShadow).toBe(true);
    // a tier the quality module applied on its own (ctx.tier only, no setQuality broadcast) is picked up next frame
    const r2 = rig(QualityTier.BALANCED);
    r2.st.setMatch!(r2.s, []);
    expect(r2.st.sun.castShadow).toBe(false);
    r2.ctx.tier = QualityTier.QUALITY;
    r2.st.update(r2.frame);
    expect(r2.st.sun.castShadow).toBe(true);
    // stands, boards and ground never cast or receive (cheap)
    expect(st.stands.castShadow || st.stands.receiveShadow || st.boards.castShadow).toBe(false);
  });

  it('LED boards scroll with frame time, stop while paused and with reduced camera motion; the sky follows the camera', () => {
    const { st, s, frame, ctx } = rig();
    st.setMatch!(s, []);
    for (let i = 0; i < 60; i++) st.update(frame);
    const o1 = st.debug.snapshot().boardOffset;
    expect(o1).toBeCloseTo(T.boardScroll / BOARD_STRIP_LENGTH, 4);
    frame.frame.paused = true;
    for (let i = 0; i < 60; i++) st.update(frame);
    expect(st.debug.snapshot().boardOffset).toBe(o1);
    frame.frame.paused = false;
    ctx.reducedMotion = true;
    for (let i = 0; i < 60; i++) st.update(frame);
    expect(st.debug.snapshot().boardOffset).toBe(o1);
    ctx.reducedMotion = false;
    // a long run wraps into [0, 1)
    frame.frame.dtMs = 100;
    for (let i = 0; i < 2000; i++) st.update(frame);
    const o = st.debug.snapshot().boardOffset;
    expect(o).toBeGreaterThanOrEqual(0);
    expect(o).toBeLessThan(1);
    ctx.camera.position.set(12, 30, 70);
    st.update(frame);
    expect(st.sky.position.distanceTo(new Vector3(12, 30, 70))).toBe(0);
  });

  it('debug views override the camera after the cameras ran; off restores nothing else', () => {
    const { st, s, frame, ctx } = rig();
    st.setMatch!(s, []);
    st.debug.view('far');
    st.update(frame);
    const v = STADIUM_VIEWS.far!;
    expect(ctx.camera.position.toArray()).toEqual([v[0], v[1], v[2]]);
    expect(ctx.camera.fov).toBe(T.debugFovDeg);
    st.debug.view('nope');
    expect(st.debug.snapshot().view).toBe('');
    ctx.camera.position.set(1, 2, 3);
    st.update(frame);
    expect(ctx.camera.position.toArray()).toEqual([1, 2, 3]);
  });

  it('clearMatch hides everything; dispose removes the lights and meshes from the scene', () => {
    const { st, s, ctx } = rig();
    st.setMatch!(s, []);
    st.clearMatch!();
    expect(st.root.visible).toBe(false);
    expect(st.debug.snapshot().drawCalls).toBe(0);
    st.dispose();
    expect(ctx.scene.children).not.toContain(st.root);
    expect(ctx.scene.children).not.toContain(st.sun);
    expect(ctx.scene.children).not.toContain(st.ambient);
  });
});
