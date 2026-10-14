/**
 * [QF-4] QA-31 / FIX-09 camera regressions in a headless live render (tests/scenario/qf-4-rig.ts: real sim, real
 * GameRenderer with the broadcast and cinematic cameras, real player model):
 *  - set pieces (free kicks near goal, penalties, corners, goal kicks): the ball is never hidden behind the taker
 *    (INT-C: "free-kick view shows the ball between the taker's legs"), the goal-kick keeper no longer fills the frame,
 *    the ball sits clear of the touch controls and the HUD radar, and what the taker aims at is in view, for the CPU's
 *    default aims and for human aims across the goal / box / up-field;
 *  - restart teleports (RUL-11 legalises positions at the set-up tick, D-008) are hidden: set-piece shots cut in on that
 *    very frame and index.ts draws a teleported player / ball at the new spot, never halfway along the jump.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_SPOT_DIST } from '../../src/contracts/constants';
import { ActionKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_CAMERA } from '../../src/contracts/tuning';
import { radarZoneMargin, touchZoneMargin, touchZones } from '../../src/render/camera/broadcast';
import { createCinePose, takerPose } from '../../src/render/camera/cinematic';
import { fillInterp, INTERP_TELEPORT, snapTeleports } from '../../src/render/index';
import { drawnOffsetsOf } from '../../src/render/players/drawn';
import { createInterpState } from '../../src/render/types';
import { cloneState } from '../../src/sim/core/clone';
import { initMatch } from '../../src/sim/init';
import { ballClearance, bodyScreenHeight, createLiveRig, toScreen, type LiveRig } from './qf-4-rig';

const ZONES = touchZones(createDefaultSettings(), { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false, hudScale: 1 });
const SIZES: [number, number][] = [[1180, 820], [1024, 768], [1688, 780]];

/**
 * A rig in open play with the restart awarded and set up: ready, then `settle` frames drawn (the stance has stepped out;
 * the CPU taker kicks ~75 ticks after ready). With `aim`, the restart is re-aimed there from the set-up tick on (as a
 * human would), so the taker lines up behind the ball on that aim.
 */
function setPiece(kind: RestartKind, x: number, z: number, attackPlusX: boolean, w = 1180, h = 820, aim: [number, number] | null = null, seed = 7): LiveRig {
  const g = createLiveRig({ seed, w, h });
  for (let i = 0; i < 400 && g.s.match.phase !== MatchPhase.IN_PLAY; i++) g.tick();
  for (let i = 0; i < 20; i++) g.tick();
  const plusTeam = g.s.teams[0]!.dir > 0 ? 0 : 1;
  const team = attackPlusX ? plusTeam : 1 - plusTeam;
  g.award(kind, team, x, z);
  const r = g.s.match.restart;
  for (let i = 0; i < 100 && !(r.ready === 1 && r.t >= 50 + (aim ? 40 : 30)); i++) {
    if (aim && r.ready === 1) { r.aimX = aim[0]; r.aimZ = aim[1]; }
    g.tick();
  }
  return g;
}

interface View { clear: number; takerH: number; bx: number; by: number }

function view(g: LiveRig): View {
  const r = g.s.match.restart;
  const b = g.s.ball;
  const sk = g.model.skeletons[r.taker]!;
  const q = toScreen(g.camera, g.w, g.h, b.x, b.y, b.z)!;
  return { clear: ballClearance(g.camera, g.w, g.h, sk, b.x, b.y, b.z), takerH: bodyScreenHeight(g.camera, g.w, g.h, sk), bx: q.x, by: q.y };
}

/** Ball above the bottom margin, the touch-control zones and the HUD radar. */
function ballSafe(v: View, w: number, h: number): boolean {
  const m = Math.max(T_CAMERA.ballBottomMargin, touchZoneMargin(v.bx, w, h, ZONES), radarZoneMargin(v.bx, w, h, ZONES));
  return v.by <= (1 - m) * h && v.by >= 0.1 * h && v.bx >= 0.05 * w && v.bx <= 0.95 * w;
}

function inView(g: LiveRig, x: number, y: number, z: number): boolean {
  const q = toScreen(g.camera, g.w, g.h, x, y, z);
  return q !== null && q.x > 0.02 * g.w && q.x < 0.98 * g.w && q.y > 0.02 * g.h && q.y < 0.98 * g.h;
}

function goalInView(g: LiveRig, end: number): boolean {
  const gx = end * HALF_LENGTH;
  return inView(g, gx, 0, -GOAL_HALF_WIDTH) && inView(g, gx, 0, GOAL_HALF_WIDTH)
    && inView(g, gx, GOAL_HEIGHT, -GOAL_HALF_WIDTH) && inView(g, gx, GOAL_HEIGHT, GOAL_HALF_WIDTH);
}

/** The drawn camera is a set-piece camera (low, near the ball), not the broadcast rig 24 m up and 40 m back. */
function setPieceCamera(g: LiveRig): boolean {
  return g.camera.position.y < 12 && Math.abs(g.camera.position.z) < HALF_WIDTH + 10;
}

describe('QF-4 QA-31 set-piece cameras: ball clear of the taker, taker not filling the frame', () => {
  it('free kicks near goal (both ends, central and wide, CPU aims and aims at either post): the ball is not hidden behind the taker', () => {
    const spots: [number, number][] = [[30, 0], [30, 8], [28, -6], [24, 3], [35, 22], [35, -25], [40, 15], [44, -12], [20, 0]];
    let n = 0;
    for (const [sx, sz] of spots) {
      for (const plus of [true, false]) {
        const x = plus ? sx : -sx;
        const end = plus ? 1 : -1;
        const g = setPiece(RestartKind.FREE_KICK, x, sz, plus);
        expect(g.s.match.phase, `FK ${x},${sz}`).toBe(MatchPhase.FREE_KICK);
        expect(setPieceCamera(g), `FK ${x},${sz} behind-the-taker camera`).toBe(true);
        const tag = `FK ${x},${sz}`;
        const v = view(g);
        expect(v.clear, `${tag} ball clear of the taker (px)`).toBeGreaterThan(3);
        expect(v.takerH, `${tag} taker height`).toBeLessThan(0.42);
        expect(ballSafe(v, g.w, g.h), `${tag} ball clear of the controls ${JSON.stringify(v)}`).toBe(true);
        expect(goalInView(g, end), `${tag} goal in view`).toBe(true);
        // Human aims at either post: the taker lines up behind the ball on the new aim.
        for (const pz of [-GOAL_HALF_WIDTH + 0.5, GOAL_HALF_WIDTH - 0.5]) {
          const ga = setPiece(RestartKind.FREE_KICK, x, sz, plus, 1180, 820, [end * HALF_LENGTH, pz]);
          expect(ga.s.players[ga.s.match.restart.taker]!.act, `${tag} still waiting`).toBe(ActionKind.SET_PIECE);
          expect(view(ga).clear, `${tag} aim at post z ${pz}: ball clear of the taker`).toBeGreaterThan(3);
        }
        n++;
      }
    }
    expect(n).toBe(spots.length * 2);
  });

  it('penalties at both ends: ball clear of the taker, goal in view, ball clear of the controls at every aspect', () => {
    for (const plus of [true, false]) {
      for (const [w, h] of SIZES) {
        const end = plus ? 1 : -1;
        const g = setPiece(RestartKind.PENALTY, end * (HALF_LENGTH - PENALTY_SPOT_DIST), 0, plus, w, h);
        expect(g.s.match.phase).toBe(MatchPhase.PENALTY);
        expect(setPieceCamera(g)).toBe(true);
        const v = view(g);
        const tag = `penalty ${end} ${w}x${h}`;
        expect(v.clear, `${tag} ball clear of the taker`).toBeGreaterThan(3);
        expect(ballSafe(v, w, h), `${tag} ball safe ${JSON.stringify(v)}`).toBe(true);
        expect(goalInView(g, end), `${tag} goal in view`).toBe(true);
      }
    }
  });

  it('corners (all four): the taker no longer hides the ball, for the default aim and aims across the box', () => {
    for (const ex of [1, -1]) {
      for (const ez of [1, -1]) {
        const g = setPiece(RestartKind.CORNER, ex * HALF_LENGTH, ez * HALF_WIDTH, ex > 0);
        expect(g.s.match.phase).toBe(MatchPhase.CORNER);
        expect(setPieceCamera(g)).toBe(true);
        const tag = `corner ${ex},${ez}`;
        const v = view(g);
        expect(v.clear, `${tag} ball clear of the taker`).toBeGreaterThan(3);
        expect(ballSafe(v, g.w, g.h), `${tag} ball safe ${JSON.stringify(v)}`).toBe(true);
        expect(goalInView(g, ex), `${tag} goal in view`).toBe(true);
        expect(inView(g, ex * (HALF_LENGTH - PENALTY_SPOT_DIST), 0, 0), `${tag} penalty spot in view`).toBe(true);
        // Near post, far post, the edge of the six-yard box, the edge of the area.
        for (const [ax, az] of [[ex * HALF_LENGTH, ez * 3], [ex * HALF_LENGTH, -ez * 3], [ex * (HALF_LENGTH - 5.5), -ez * 9], [ex * (HALF_LENGTH - 16), -ez * 10]] as const) {
          const ga = setPiece(RestartKind.CORNER, ex * HALF_LENGTH, ez * HALF_WIDTH, ex > 0, 1180, 820, [ax, az]);
          expect(ga.s.players[ga.s.match.restart.taker]!.act, `${tag} still waiting`).toBe(ActionKind.SET_PIECE);
          expect(view(ga).clear, `${tag} aim ${ax},${az}: ball clear of the taker`).toBeGreaterThan(3);
        }
      }
    }
  });

  it('goal kicks (both ends, both sides): the keeper stays small and clear of the ball; the pitch ahead is in view', () => {
    for (const plus of [true, false]) {
      for (const z of [-9, -4, 4, 9]) {
        // The goal kick of the team defending the end the ball went out at (spots on the goal-area line, |z| 4..9).
        const end = plus ? 1 : -1;
        const g = setPiece(RestartKind.GOAL_KICK, end * (HALF_LENGTH - 5.5), z, !plus);
        expect(g.s.match.phase).toBe(MatchPhase.GOAL_KICK);
        expect(setPieceCamera(g)).toBe(true);
        const tag = `goal kick ${end},${z}`;
        const v = view(g);
        expect(v.clear, `${tag} ball clear of the keeper`).toBeGreaterThan(3);
        // INT-C: "goal-kick keeper still large in frame" (38% of the screen height before QF-4).
        expect(v.takerH, `${tag} keeper height`).toBeLessThan(0.26);
        expect(ballSafe(v, g.w, g.h), `${tag} ball safe ${JSON.stringify(v)}`).toBe(true);
        expect(inView(g, g.s.ball.x - end * 40, 0, g.s.ball.z), `${tag} 40 m up-field in view`).toBe(true);
        expect(inView(g, 0, 0, 0), `${tag} centre spot in view`).toBe(true);
        // Own goal frame never in view: points all over the posts, crossbar and the net box (sides, roof, back).
        for (let iz = 0; iz <= 8; iz++) {
          const gz = -GOAL_HALF_WIDTH + (2 * GOAL_HALF_WIDTH * iz) / 8;
          for (let ix = 0; ix <= 4; ix++) {
            for (let iy = 0; iy <= 4; iy++) {
              const gx = HALF_LENGTH + (2 * ix) / 4, gy = (GOAL_HEIGHT * iy) / 4;
              const onBox = ix === 0 || ix === 4 || iy === 4 || iz === 0 || iz === 8;
              if (!onBox) continue;
              const q = toScreen(g.camera, g.w, g.h, end * gx, gy, gz);
              const visible = q !== null && q.x > 0 && q.x < g.w && q.y > 0 && q.y < g.h;
              expect(visible, `${tag} own goal point ${gx.toFixed(1)},${gy.toFixed(1)},${gz.toFixed(1)} out of view`).toBe(false);
            }
          }
        }
        // Up-field aims a human would pick (+-15 deg): still clear.
        for (const da of [-15, 15]) {
          const a = (da * Math.PI) / 180;
          const ga = setPiece(RestartKind.GOAL_KICK, end * (HALF_LENGTH - 5.5), z, !plus, 1180, 820, [g.s.ball.x - end * 30 * Math.cos(a), g.s.ball.z + 30 * Math.sin(a)]);
          expect(ga.s.players[ga.s.match.restart.taker]!.act, `${tag} still waiting`).toBe(ActionKind.SET_PIECE);
          expect(view(ga).clear, `${tag} aim ${da} deg: ball clear of the keeper`).toBeGreaterThan(3);
        }
      }
    }
  });
});

describe('QF-4 QA-31 mirrored touch controls', () => {
  it('glitch: ball hidden under touch controls - set-piece shots with mirrored controls (cluster bottom left) at 1180x820 and 19.5:9', () => {
    const st = createDefaultSettings();
    st.controls.touch.mirror = true;
    const Z = touchZones(st, { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false, hudScale: 1 });
    expect(Z.mirror).toBe(true);
    const cases: [RestartKind, number, number, boolean][] = [];
    for (const ex of [1, -1]) for (const ez of [1, -1]) cases.push([RestartKind.CORNER, ex * HALF_LENGTH, ez * HALF_WIDTH, ex > 0]);
    for (const ex of [1, -1]) cases.push([RestartKind.PENALTY, ex * (HALF_LENGTH - PENALTY_SPOT_DIST), 0, ex > 0]);
    for (const ex of [1, -1]) for (const z of [-9, 9]) cases.push([RestartKind.GOAL_KICK, ex * (HALF_LENGTH - 5), z, ex < 0]);
    for (const z of [-20, 0, 20]) cases.push([RestartKind.FREE_KICK, 30, z, true]);
    for (const [w, h] of [[1180, 820], [1688, 780]] as const) {
      for (const [kind, x, z, plus] of cases) {
        const g = createLiveRig({ seed: 7, w, h, settings: st });
        for (let i = 0; i < 400 && g.s.match.phase !== MatchPhase.IN_PLAY; i++) g.tick();
        for (let i = 0; i < 20; i++) g.tick();
        const plusTeam = g.s.teams[0]!.dir > 0 ? 0 : 1;
        g.award(kind, plus ? plusTeam : 1 - plusTeam, x, z);
        const r = g.s.match.restart;
        for (let i = 0; i < 100 && !(r.ready === 1 && r.t >= 80); i++) g.tick();
        const tag = `${RestartKind[kind]} ${x},${z} ${w}x${h}`;
        expect(setPieceCamera(g), tag).toBe(true);
        const b = g.s.ball;
        const q = toScreen(g.camera, w, h, b.x, b.y, b.z)!;
        const m = Math.max(T_CAMERA.ballBottomMargin, touchZoneMargin(q.x, w, h, Z), radarZoneMargin(q.x, w, h, Z));
        expect(q.y <= (1 - m) * h && q.y >= 0.1 * h && q.x >= 0.05 * w && q.x <= 0.95 * w, `${tag} ball ${q.x.toFixed(0)},${q.y.toFixed(0)}`).toBe(true);
      }
    }
  }, 300000);
});

describe('QF-4 QA-31 nobody fills the set-piece frame', () => {
  it('a player standing at the free-kick camera spot: the shot takes the other side of the ball (no body across the lens)', () => {
    const want = takerPose(30, 8, HALF_LENGTH, 0, false, createCinePose());
    const other = takerPose(30, 8, HALF_LENGTH, 0, false, createCinePose(), true);
    expect(Math.hypot(want.x - other.x, want.z - other.z)).toBeGreaterThan(5);
    const g = createLiveRig({ seed: 7 });
    for (let i = 0; i < 400 && g.s.match.phase !== MatchPhase.IN_PLAY; i++) g.tick();
    for (let i = 0; i < 20; i++) g.tick();
    const plusTeam = g.s.teams[0]!.dir > 0 ? 0 : 1;
    g.award(RestartKind.FREE_KICK, plusTeam, 30, 8);
    const r = g.s.match.restart;
    // A team-mate (not the taker) parks on the default camera spot just before the set-up tick.
    let parked = -1;
    for (let i = 0; i < 80 && r.ready === 0; i++) {
      if (r.t >= 45) {
        if (parked < 0) for (let k = plusTeam * 11 + 1; k < plusTeam * 11 + 11; k++) if (k !== r.taker) { parked = k; break; }
        const p = g.s.players[parked]!;
        p.x = want.x + 0.5; p.z = want.z; p.vx = 0; p.vz = 0;
      }
      g.tick();
    }
    expect(r.ready).toBe(1);
    g.tick();
    const cam = g.camera.position;
    expect(Math.hypot(cam.x - other.x, cam.z - other.z), 'camera on the other side').toBeLessThan(0.5);
    let near = Infinity;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = g.s.players[i]!;
      if (p.active === 1) near = Math.min(near, Math.hypot(p.x - cam.x, p.z - cam.z));
    }
    expect(near).toBeGreaterThan(3.5);
    expect(view(g).clear, 'ball still clear of the taker').toBeGreaterThan(3);
  });
});

describe('QF-4 QA-31 restart teleports are hidden by the set-piece cut', () => {
  it('glitch: camera snapping at restarts - the set-piece shot cuts in on the set-up tick that teleports players, never before or after', () => {
    for (const [kind, x, z] of [[RestartKind.CORNER, HALF_LENGTH, HALF_WIDTH], [RestartKind.FREE_KICK, 30, 6], [RestartKind.GOAL_KICK, HALF_LENGTH - 5.5, 6]] as const) {
      const g = createLiveRig({ seed: 11 });
      for (let i = 0; i < 400 && g.s.match.phase !== MatchPhase.IN_PLAY; i++) g.tick();
      for (let i = 0; i < 20; i++) g.tick();
      const plusTeam = g.s.teams[0]!.dir > 0 ? 0 : 1;
      g.award(kind, kind === RestartKind.GOAL_KICK ? 1 - plusTeam : plusTeam, x, z);
      let readyFrame = -1, enterFrame = -1;
      for (let f = 0; f < 80; f++) {
        const wasReady = g.s.match.restart.ready === 1;
        g.tick();
        if (!wasReady && g.s.match.restart.ready === 1) readyFrame = f;
        if (enterFrame < 0 && setPieceCamera(g)) enterFrame = f;
      }
      // The main camera shows the set-up (it may cut to the placed ball at the award); the set-piece shot cuts in on the
      // frame of the set-up tick, whose teleports it hides.
      expect(readyFrame, RestartKind[kind]).toBeGreaterThan(30);
      expect(enterFrame, `${RestartKind[kind]}: set-piece shot from the set-up frame`).toBe(readyFrame);
      expect(setPieceCamera(g)).toBe(true);
    }
  });

  it('a teleported player or ball is drawn at its new spot on the first frame (never halfway along the jump)', () => {
    const prev = initMatch(createMatchConfig()) as SimState;
    const curr = cloneState(prev);
    const it = createInterpState();
    curr.players[3]!.x = prev.players[3]!.x + 20; // a set-up teleport
    curr.players[4]!.x = prev.players[4]!.x + 0.15; // a sprint step
    curr.ball.x = prev.ball.x + 30; // ball placed for a restart
    for (const a of [0, 0.25, 0.5, 0.99]) {
      fillInterp(it, prev, curr, a);
      expect(snapTeleports(it, prev, curr)).toBe(2);
      expect(it.x[3]).toBeCloseTo(curr.players[3]!.x, 4);
      expect(it.x[4]).toBeCloseTo(prev.players[4]!.x + 0.15 * a, 4);
      expect(it.ballX).toBeCloseTo(curr.ball.x, 9);
    }
    // A shot covers ~0.6 m per tick: still interpolated.
    curr.ball.x = prev.ball.x + 0.6;
    curr.players[3]!.x = prev.players[3]!.x;
    fillInterp(it, prev, curr, 0.5);
    expect(snapTeleports(it, prev, curr)).toBe(0);
    expect(it.ballX).toBeCloseTo(prev.ball.x + 0.3, 6);
    expect(INTERP_TELEPORT.player).toBeGreaterThan(0.6);
    expect(INTERP_TELEPORT.ball).toBeGreaterThan(1.2);
  });

  it('live: at the set-up tick every teleported player is drawn at the new spot under the new camera', () => {
    const g = createLiveRig({ seed: 5 });
    for (let i = 0; i < 400 && g.s.match.phase !== MatchPhase.IN_PLAY; i++) g.tick();
    for (let i = 0; i < 20; i++) g.tick();
    const plusTeam = g.s.teams[0]!.dir > 0 ? 0 : 1;
    g.award(RestartKind.CORNER, plusTeam, HALF_LENGTH, -HALF_WIDTH);
    let checked = 0;
    for (let f = 0; f < 80; f++) {
      g.tick();
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = g.prev.players[i]!, c = g.s.players[i]!;
        if (c.active !== 1 || Math.hypot(c.x - p.x, c.z - p.z) < 2) continue;
        // Drawn root at the new spot (plus the render-only offsets the model reports: foot lock, set-piece stance).
        const sk = g.model.skeletons[i]!;
        const off = drawnOffsetsOf(g.ctx);
        expect(Math.hypot(sk[9]! - c.x - off[i * 2]!, sk[11]! - c.z - off[i * 2 + 1]!), `slot ${i} drawn at its new spot`).toBeLessThan(0.05);
        expect(Math.hypot(off[i * 2]!, off[i * 2 + 1]!)).toBeLessThan(0.75);
        expect(setPieceCamera(g), 'teleport frame drawn by the set-piece camera').toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
