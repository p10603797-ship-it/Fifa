/**
 * [QF-4 skeptic] QA-31 / FIX-09 camera regressions found from angles the first QF-4 pass did not cover (headless live
 * render: tests/scenario/qf-4-rig.ts, real sim, real GameRenderer with the broadcast + cinematic cameras and the real
 * player model):
 *  - a chipped / skied free kick struck from the behind-the-taker view rose out of the top of the frame while the shot
 *    hold kept that view for up to 1.2 s (~0.6 s with the ball off screen);
 *  - the penalty shoot-out kept one static behind view through every kick: RUL-07's swap of the kicker, the last kicker
 *    and both keepers at each kick's SETUP was drawn as visible teleports, and the waiting kicker hid the ball;
 *  - the behind view sat on the taker's support-foot side for the minus team's right-footers (and the plus team's
 *    left-footers), so his planted shin hid the ball through the whole charged backswing (24 of ~100 frames).
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH, PENALTY_SPOT_DIST } from '../../src/contracts/constants';
import { ActionKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { chooseShot, CineShot, createCinePose, createDirectorInput, poseNdc, takerPose } from '../../src/render/camera/cinematic';
import { ShootoutSub } from '../../src/sim/rules/shootout';
import { ballClearance, createLiveRig, screenRadius, toScreen, type LiveRig } from './qf-4-rig';

/** Rig in open play with a restart for the +x (attackPlus) / -x team awarded at (x, z); optional kicking foot for that team. */
function awarded(kind: RestartKind, x: number, z: number, attackPlus: boolean, seed = 7, foot = -1): LiveRig {
  const g = createLiveRig({ seed });
  for (let i = 0; i < 400 && g.s.match.phase !== MatchPhase.IN_PLAY; i++) g.tick();
  for (let i = 0; i < 20; i++) g.tick();
  const plusTeam = g.s.teams[0]!.dir > 0 ? 0 : 1;
  const team = attackPlus ? plusTeam : 1 - plusTeam;
  if (foot >= 0) for (let k = team * 11; k < team * 11 + 11; k++) g.s.attrs[k]!.foot = foot;
  g.award(kind, team, x, z);
  return g;
}

/** The drawn camera is a low set-piece camera, not the broadcast rig 24 m up and 40 m back. */
function lowCamera(g: LiveRig): boolean {
  return g.camera.position.y < 12 && Math.abs(g.camera.position.z) < HALF_WIDTH + 10;
}

describe('QF-4 skeptic: high balls from the behind-the-taker view', () => {
  it('glitch: losing a high ball - a chipped or skied free kick from the behind view cuts to the main camera before the ball leaves the frame', () => {
    // SIM-11 chips leave at 0.5-0.8 rad: from 27 m a full chip is ~11.7 m/s up and ~11.4 m/s along the ground.
    const cases: [number, number, number, number][] = [[27, 0, 11.7, 0.47], [27, 0, 13, 0.45], [30, -10, 11.7, 0.47], [27, 0, 18, 1]];
    for (const [x, z, vy, hMul] of cases) {
      const g = awarded(RestartKind.FREE_KICK, x, z, true);
      let kicked = -1, off = 0, behindAfter = 0;
      for (let i = 0; i < 420; i++) {
        g.tick();
        const b = g.s.ball;
        if (kicked < 0 && g.s.match.phase === MatchPhase.IN_PLAY) {
          kicked = i;
          expect(b.shotBy, `FK ${x},${z}: the CPU taker shoots`).toBeGreaterThanOrEqual(0);
          b.vx *= hMul; b.vz *= hMul; b.vy = vy;
          continue;
        }
        if (kicked < 0 || i > kicked + 80) continue;
        const p = g.prev.ball;
        const q = toScreen(g.camera, g.w, g.h, p.x, p.y, p.z);
        if (!q || q.x < 0 || q.x > g.w || q.y < 0 || q.y > g.h) off++;
        if (lowCamera(g)) behindAfter++;
      }
      expect(kicked, `FK ${x},${z} taken`).toBeGreaterThan(0);
      expect(off, `FK ${x},${z} vy ${vy}: frames with the ball off screen`).toBe(0);
      // The skied one (18 m/s up) cannot be framed from 3 m up: the behind view lets go on the kick frame.
      if (vy >= 18) expect(behindAfter, `FK ${x},${z} vy ${vy}: the behind view lets go at once`).toBeLessThanOrEqual(2);
    }
  });

  it('a free kick or penalty struck low keeps the behind view while it flies (the hold still works)', () => {
    for (const [kind, x] of [[RestartKind.FREE_KICK, 27], [RestartKind.PENALTY, HALF_LENGTH - PENALTY_SPOT_DIST]] as const) {
      const g = awarded(kind, x, 0, true);
      let kicked = -1, behind = 0, off = 0;
      for (let i = 0; i < 420; i++) {
        g.tick();
        if (kicked < 0 && g.s.match.phase === MatchPhase.IN_PLAY) kicked = i;
        if (kicked < 0 || i > kicked + 40) continue;
        if (lowCamera(g)) behind++;
        const p = g.prev.ball;
        const q = toScreen(g.camera, g.w, g.h, p.x, p.y, p.z);
        if (!q || q.y < 0 || q.y > g.h) off++;
      }
      expect(behind, RestartKind[kind]).toBeGreaterThan(20);
      expect(off).toBe(0);
    }
  });

  it('poseNdc matches the drawn camera (the hold test projects through the pose it drew)', () => {
    const g = awarded(RestartKind.FREE_KICK, 27, 0, true);
    for (let i = 0; i < 120 && !(g.s.match.restart.ready === 1 && g.s.match.restart.t > 70); i++) g.tick();
    expect(lowCamera(g)).toBe(true);
    const c = g.camera;
    const e = { x: 0, y: 0, z: 0 };
    const pose = createCinePose();
    pose.x = c.position.x; pose.y = c.position.y; pose.z = c.position.z; pose.fov = c.fov;
    // Recover yaw / pitch from the quaternion (YXZ).
    const q = c.quaternion;
    const m11 = 1 - 2 * (q.y * q.y + q.z * q.z), m13 = 2 * (q.x * q.z + q.w * q.y), m23 = 2 * (q.y * q.z - q.w * q.x), m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
    void m11;
    pose.pitch = Math.asin(Math.max(-1, Math.min(1, m23)));
    pose.yaw = Math.atan2(m13, m33);
    const out = [0, 0, 0];
    for (const [x, y, z] of [[30, 0.1, 2], [52.5, 2.44, -3.66], [40, 5, 4]] as const) {
      const s = toScreen(c, g.w, g.h, x, y, z)!;
      poseNdc(pose, x, y, z, g.w / g.h, out);
      e.x = (out[0]! + 1) * 0.5 * g.w; e.y = (1 - out[1]!) * 0.5 * g.h;
      expect(Math.abs(e.x - s.x), `x of ${x},${y},${z}`).toBeLessThan(0.5);
      expect(Math.abs(e.y - s.y), `y of ${x},${y},${z}`).toBeLessThan(0.5);
    }
  });
});

describe('QF-4 skeptic: penalty shoot-out camera', () => {
  it('director: the shoot-out RESULT is on the main camera, every other sub-state behind the taker', () => {
    const i = createDirectorInput();
    i.phase = MatchPhase.SHOOT_OUT;
    expect(chooseShot(i)).toBe(CineShot.BEHIND_TAKER);
    i.shootoutResult = true;
    expect(chooseShot(i)).toBe(CineShot.NONE);
  });

  it('glitch: camera snapping at restarts - shoot-out kicker and keeper swaps are hidden by a cut, never drawn as teleports on a static view', () => {
    const g = createLiveRig({ seed: 5, config: { startPhase: MatchPhase.SHOOT_OUT } as never });
    let lastPos = { x: NaN, y: NaN, z: NaN, qy: NaN };
    let swaps = 0, kicks = 0, resultFrames = 0, resultMain = 0;
    for (let t = 0; t < 1800 && g.s.match.phase !== MatchPhase.POST_MATCH; t++) {
      g.tick();
      const s = g.s, c = g.camera;
      const cut = Math.hypot(c.position.x - lastPos.x, c.position.y - lastPos.y, c.position.z - lastPos.z) > 0.01 || Math.abs(c.quaternion.y - lastPos.qy) > 1e-4;
      for (let i = 0; i < 22; i++) {
        const p = g.prev.players[i]!, q = s.players[i]!;
        if (q.active !== 1 || Math.hypot(q.x - p.x, q.z - p.z) < 1) continue;
        const a = toScreen(c, g.w, g.h, p.x, 1, p.z), b = toScreen(c, g.w, g.h, q.x, 1, q.z);
        const vis = (v: typeof a): boolean => v !== null && v.x > 0 && v.x < g.w && v.y > 0 && v.y < g.h;
        // A teleport may only be drawn on a frame that cuts (or entirely off screen).
        expect(cut || (!vis(a) && !vis(b)), `tick ${s.tick} slot ${i} jumps ${Math.hypot(q.x - p.x, q.z - p.z).toFixed(1)} m on a static view`).toBe(true);
        if (s.match.shootout.sub === ShootoutSub.SETUP) swaps++;
      }
      if (s.match.phase === MatchPhase.SHOOT_OUT && s.match.shootout.sub === ShootoutSub.RESULT) {
        resultFrames++;
        if (c.position.z > HALF_WIDTH + 20) resultMain++;
      }
      if (s.match.phase === MatchPhase.SHOOT_OUT && s.match.shootout.sub === ShootoutSub.AIM && s.match.shootout.subT === 1) {
        kicks++;
        expect(lowCamera(g), `kick ${kicks}: behind the taker`).toBe(true);
      }
      lastPos = { x: c.position.x, y: c.position.y, z: c.position.z, qy: c.quaternion.y };
    }
    expect(kicks).toBeGreaterThanOrEqual(5);
    expect(swaps).toBeGreaterThan(kicks); // the swaps really happen (and were all cut)
    expect(resultMain).toBe(resultFrames);
  }, 120000);

  it('glitch: losing a high ball - a skied shoot-out kick hands over to the main camera before it leaves the behind view', () => {
    for (const vy of [6, 8]) {
      const g = createLiveRig({ seed: 5, config: { startPhase: MatchPhase.SHOOT_OUT } as never });
      let flight = 0, off = 0, kicks = 0, wasTaken = 0;
      for (let t = 0; t < 1200 && g.s.match.phase !== MatchPhase.POST_MATCH; t++) {
        g.tick();
        const s = g.s, so = s.match.shootout, r = s.match.restart;
        if (r.taken === 1 && wasTaken === 0 && so.sub === ShootoutSub.FLIGHT) { kicks++; s.ball.vy = vy; }
        wasTaken = r.taken;
        if (so.sub !== ShootoutSub.FLIGHT) continue;
        flight++;
        const b = g.prev.ball;
        const q = toScreen(g.camera, g.w, g.h, b.x, b.y, b.z);
        if (!q || q.y < 0 || q.y > g.h || q.x < 0 || q.x > g.w) off++;
      }
      expect(kicks, `vy ${vy}`).toBeGreaterThanOrEqual(3);
      expect(flight).toBeGreaterThan(60);
      // Before: 219 of 352 flight frames with the ball above the behind view at vy 8.
      expect(off, `vy ${vy}: flight frames with the ball off screen`).toBe(0);
    }
  }, 120000);

  it('shoot-out: the kicker never hides the ball while he waits, aims and winds up', () => {
    const g = createLiveRig({ seed: 5, config: { startPhase: MatchPhase.SHOOT_OUT } as never });
    let frames = 0, hidden = 0, kicks = 0;
    for (let t = 0; t < 1800 && g.s.match.phase !== MatchPhase.POST_MATCH; t++) {
      g.tick();
      const s = g.s, so = s.match.shootout, r = s.match.restart;
      if (s.match.phase !== MatchPhase.SHOOT_OUT || r.taken === 1 || r.taker < 0) continue;
      if (!(so.sub === ShootoutSub.SETUP || so.sub === ShootoutSub.AIM) || !lowCamera(g)) continue;
      if (so.sub === ShootoutSub.AIM && so.subT === 1) kicks++;
      const b = g.prev.ball;
      const clear = ballClearance(g.camera, g.w, g.h, g.model.skeletons[r.taker]!, b.x, b.y, b.z);
      const q = toScreen(g.camera, g.w, g.h, b.x, b.y, b.z);
      if (!q || (so.sub === ShootoutSub.SETUP && so.subT < 2)) continue; // the set-up frame draws the placed ball (snap)
      const rb = screenRadius(g.camera, g.h, BALL_RADIUS, q.depth);
      frames++;
      // Hidden: more than a quarter of the ball's width behind his body (the waiting kicker covered all of it, -20 px of
      // a ~16 px radius; a boot or thigh passing the edge of the ball in the backswing is not that).
      if (clear < -0.5 * rb) hidden++;
    }
    expect(kicks).toBeGreaterThanOrEqual(5);
    expect(frames).toBeGreaterThan(400);
    expect(hidden, `${hidden} of ${frames} frames with the ball behind the kicker`).toBeLessThanOrEqual(kicks * 3);
  }, 120000);
});

describe('QF-4 skeptic: the taker\'s strike never hides the ball', () => {
  it('free kicks and penalties, both teams, right- and left-footed takers: the ball stays visible through the charged backswing', () => {
    const spots: [number, number][] = [[HALF_LENGTH - PENALTY_SPOT_DIST, 0], [27, 0], [30, 12], [30, -12], [28, -6], [44, -12], [40, 15]];
    let cases = 0;
    for (const [sx, sz] of spots) for (const plus of [true, false]) for (const foot of [0, 1]) {
      const kind = sz === 0 && sx > 40 ? RestartKind.PENALTY : RestartKind.FREE_KICK;
      const g = awarded(kind, plus ? sx : -sx, sz, plus, 7, foot);
      const r = g.s.match.restart;
      let frames = 0, hidden = 0, strike = 0;
      for (let i = 0; i < 400; i++) {
        g.tick();
        if (g.s.match.phase === MatchPhase.IN_PLAY || r.taken === 1) break;
        if (r.ready !== 1 || !lowCamera(g)) continue;
        const p = g.s.players[r.taker]!;
        const b = g.prev.ball;
        const clear = ballClearance(g.camera, g.w, g.h, g.model.skeletons[r.taker]!, b.x, b.y, b.z);
        frames++;
        if (p.act !== ActionKind.SET_PIECE) strike++;
        if (clear < 0) hidden++;
      }
      const tag = `${RestartKind[kind]} ${plus ? sx : -sx},${sz} foot ${foot}`;
      expect(frames, tag).toBeGreaterThan(60);
      expect(strike, `${tag}: wind-up and charge drawn`).toBeGreaterThan(15);
      // A frame or a few as the boot swings through is fine; the 0.35 s charged backswing was not.
      expect(hidden, `${tag}: frames with the ball behind the taker`).toBeLessThanOrEqual(4);
      cases++;
    }
    expect(cases).toBe(spots.length * 4);
  }, 300000);

  it('takerPose: the kicking-foot side puts the camera on the taker\'s right for a right-footer and on his left for a left-footer, either way of play', () => {
    for (const end of [1, -1]) {
      const sx = end * 27, ax = end * HALF_LENGTH;
      const right = takerPose(sx, 0, ax, 0, false, createCinePose(), false, 1);
      const left = takerPose(sx, 0, ax, 0, false, createCinePose(), false, -1);
      // The taker faces the goal (ux = end); his right is (-uz, ux) = (0, end) in (x, z).
      expect(Math.sign(right.z) * end, `end ${end} right-footer`).toBe(1);
      expect(Math.sign(left.z) * end, `end ${end} left-footer`).toBe(-1);
    }
  });
});
