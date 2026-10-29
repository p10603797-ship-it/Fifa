/**
 * [FEEL-1] Scripted human-input scenarios that measure how receiving, dribbling, passing and shooting feel (the user's
 * playtest feedback). Every scenario drives the real pipeline (makeScenario + step) with InputFrames exactly as a pad
 * produces them (stick -127..127, button bits). Shared by tests/scenario/feel-1-*.test.ts and the before / after
 * measurement runner (tools are not ours: the runner lives in the scratchpad and imports this file).
 */
import { ActionKind, AutoSwitch, AssistLevel, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_BALL } from '../../src/contracts/tuning';
import { makeScenario, runTicks } from '../harness/scenario';

/** Human controls team 0 slot HS; team 0 attacks +x. */
export const HS = 9;

function stick(f: InputFrame, dx: number, dz: number, mag = 1): void {
  const l = Math.sqrt(dx * dx + dz * dz);
  if (!(l > 1e-9)) return;
  f.mx = Math.round((dx / l) * 127 * mag);
  f.mz = Math.round((dz / l) * 127 * mag);
}

function rot(dx: number, dz: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  return [dx * c - dz * s, dx * s + dz * c];
}

/** Opponents (team 1) far away and out of the play unless `keepOpp` lists slots to keep where they are. */
function clearField(s: SimState, keep: readonly number[] = []): void {
  for (let i = 0; i < 22; i++) {
    if (i === HS || keep.includes(i)) continue;
    const p = s.players[i]!;
    if (i === 0 || i === 11) continue; // keepers stay in goal
    // Park everyone else out of the play, standing: teammates deep behind (never a candidate in front of the passer),
    // opponents along the far touchline.
    if (i < 11) { p.x = -48; p.z = -30 + (i % 11) * 6; } else { p.x = -40 + (i % 11) * 7; p.z = 32; }
    p.vx = 0; p.vz = 0;
  }
}

export interface Setup { s: SimState; }

function base(seed: number, assist = AssistLevel.ASSISTED, keep: readonly number[] = []): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed,
    humans: [{ side: 0, slot: HS, assist, autoSwitch: AutoSwitch.OFF }],
  });
  clearField(s, keep);
  return s;
}

// ------------------------------------------------------------------ receiving

export interface ReceiveCase {
  /** Ball speed toward the meeting area, m/s. */
  ballSpeed: number;
  /** Angle of the ball path relative to the straight line ball -> player, deg (0 = straight at him). */
  pathDeg: number;
  /** Distance ball -> player at the start, m. */
  dist: number;
  /** How the user steers: 'chase' = stick at the ball every tick; 'fixed' = stick at where the ball was at the start,
   *  rotated by aimErrDeg; 'cross' = he runs forward (+x) and the ball crosses in front of him from the side. */
  mode: 'chase' | 'fixed' | 'cross';
  aimErrDeg: number;
  sprint: boolean;
  /** 'pass' = an untouched pass to him (passTarget set); 'loose' = a loose ball nobody passed. */
  kind: 'pass' | 'loose';
  seed: number;
}

export interface ReceiveResult {
  got: boolean;
  /** Still his ball 30 ticks after he first had it. */
  kept30: boolean;
  /** Ticks until he had the ball. */
  ticks: number;
  /** Closest approach of the ball to his centre, m. */
  closest: number;
  /** Ball distance from his feet 30 ticks after he got it (control check), m. */
  after30: number;
  outcome: 'clean' | 'heavy' | 'miss' | 'none';
}

export function receiveScenario(c: ReceiveCase): ReceiveResult {
  const s = base(c.seed);
  const p = s.players[HS]!;
  p.x = 0; p.z = 0; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0;
  const b = s.ball;
  let bx: number, bz: number, vx: number, vz: number;
  if (c.mode === 'cross') {
    // He runs forward along +x; the ball comes from his left (z = -dist) across his path to where he would be when it
    // arrives (the user steers at that meeting point, with the aim error).
    const vp = c.sprint ? 7.5 : 5;
    p.vx = vp;
    // Time for the ball to roll dist m (the sim's rolling model: decel = rollDecel + rollDamping x v).
    let tArr = 0, rolled = 0, vb = c.ballSpeed;
    while (rolled < c.dist && vb > 0.3 && tArr < 6) { rolled += vb / 60; vb -= (T_BALL.rollDecel + T_BALL.rollDamping * vb) / 60; tArr += 1 / 60; }
    const meetX = vp * tArr;
    bx = meetX + (c.pathDeg / 45) * 4; bz = -c.dist;
    const dx = meetX - bx, dz = 0 - bz, l = Math.hypot(dx, dz);
    vx = (dx / l) * c.ballSpeed; vz = (dz / l) * c.ballSpeed;
  } else {
    bx = -c.dist; bz = 0;
    // From behind-left toward him: a pass from a teammate deep (x < 0) in front of him (he faces the ball: fx -1).
    p.fx = -1;
    const [dx, dz] = rot(1, 0, c.pathDeg);
    vx = dx * c.ballSpeed; vz = dz * c.ballSpeed;
  }
  Object.assign(b, { x: bx, y: 0.11, z: bz, px: bx, py: 0.11, pz: bz, vx, vy: 0, vz, grounded: 1, owner: -1, heldBy: -1 });
  const passer = 6;
  if (c.kind === 'pass') {
    Object.assign(b, {
      lastKickBy: passer, lastKickTeam: 0, lastKickKind: KickKind.GROUND_PASS, lastKickTick: s.tick,
      lastTouch: passer, lastTouchTeam: 0, lastTouchTick: s.tick, passTarget: HS, passX: 0, passZ: 0,
    });
  } else {
    Object.assign(b, { lastKickBy: -1, lastTouch: 13, lastTouchTeam: 1, lastTouchTick: s.tick - 30, passTarget: -1 });
  }
  const aim0x = bx - p.x, aim0z = bz - p.z;
  let got = -1;
  let closest = 1e9;
  let outcome: ReceiveResult['outcome'] = 'none';
  let after30 = NaN;
  let kept = false;
  const n = 260;
  runTicks(s, n, (_t, st, out) => {
    const f = out[0]!;
    const q = st.players[HS]!;
    const bb = st.ball;
    if (got >= 0) { // after the reception: keep running the same way
      stick(f, c.mode === 'cross' ? 1 : -1, 0);
      if (c.sprint) f.buttons |= Btn.SPRINT;
      return;
    }
    if (c.mode === 'chase') { const [dx, dz] = rot(bb.x - q.x, bb.z - q.z, c.aimErrDeg); stick(f, dx, dz); }
    else if (c.mode === 'fixed') { const [dx, dz] = rot(aim0x, aim0z, c.aimErrDeg); stick(f, dx, dz); }
    else {
      // Leads the ball like a player does: where it will be by the time he could get there.
      const tau = Math.hypot(bb.x - q.x, bb.z - q.z) / (Math.hypot(bb.vx, bb.vz) + 7);
      const [dx, dz] = rot(bb.x + bb.vx * tau - q.x, bb.z + bb.vz * tau - q.z, c.aimErrDeg); stick(f, dx, dz);
    }
    if (c.sprint) f.buttons |= Btn.SPRINT;
  }, {
    until: (st, ev) => {
      const q = st.players[HS]!;
      const d = Math.hypot(st.ball.x - q.x, st.ball.z - q.z);
      if (got < 0) {
        if (d < closest) closest = d;
        for (const e of ev) {
          if (e.type === EventType.KICK && e.a === HS && e.b === KickKind.FIRST_TOUCH) {
            outcome = q.act === ActionKind.FIRST_TOUCH && q.actA === 2 ? 'heavy' : 'clean';
          }
        }
        if (outcome === 'heavy') { got = st.tick; return false; }
        if (q.noTouchT > 0 && outcome === 'none' && q.act === 0 && d < 3) outcome = 'miss';
        if (st.ball.owner === HS) { got = st.tick; if (outcome === 'none') outcome = 'clean'; }
      } else if (st.tick - got === 30) { after30 = d; kept = st.ball.owner === HS; return true; }
      return false;
    },
  });
  return { got: got >= 0, kept30: kept, ticks: got, closest, after30, outcome };
}

// ------------------------------------------------------------------ dribbling

export interface DribbleCase {
  style: 'jog' | 'sprint' | 'r1' | 'walk';
  /** Optional turn after turnAt ticks by turnDeg. */
  turnDeg?: number;
  turnAt?: number;
  ticks: number;
  seed: number;
  /** Override the dribbler's dribbling / ballControl / agility (1..99). */
  skill?: number;
}

export interface DribbleResult {
  kept: boolean;
  /** Ball distance from his centre over the run after the first second: mean, 90th percentile, max (m). */
  mean: number; p90: number; max: number;
  /** Lead along his velocity, mean (m). */
  lead: number;
  /** His mean speed over the measured window, m/s. */
  speed: number;
  touches: number;
}

export function dribbleScenario(c: DribbleCase): DribbleResult {
  const s = base(c.seed);
  const p = s.players[HS]!;
  p.x = -30; p.z = 0; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0;
  if (c.skill !== undefined) { const a = s.attrs[HS]!; a.dribbling = c.skill; a.ballControl = c.skill; a.agility = c.skill; }
  Object.assign(s.ball, { x: -29.5, y: 0.11, z: 0, px: -29.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
  const ds: number[] = [];
  const leads: number[] = [];
  let sp = 0, nsp = 0, touches = 0, kept = true;
  runTicks(s, c.ticks, (t, st, out) => {
    const f = out[0]!;
    let dx = 1, dz = 0;
    if (c.turnDeg !== undefined && c.turnAt !== undefined && t - 1 >= c.turnAt) [dx, dz] = rot(1, 0, c.turnDeg);
    stick(f, dx, dz, c.style === 'walk' ? 0.4 : 1);
    if (c.style === 'sprint') f.buttons |= Btn.SPRINT;
    if (c.style === 'r1') f.buttons |= Btn.MOD_R;
  }, {
    until: (st, ev) => {
      const q = st.players[HS]!;
      for (const e of ev) if (e.type === EventType.KICK && e.a === HS && e.b === KickKind.DRIBBLE_TOUCH) touches++;
      if (st.ball.owner !== HS) { kept = false; return true; }
      if (st.tick > 60) {
        const bx = st.ball.x - q.x, bz = st.ball.z - q.z;
        ds.push(Math.hypot(bx, bz));
        const v = Math.hypot(q.vx, q.vz);
        if (v > 0.5) leads.push((bx * q.vx + bz * q.vz) / v);
        sp += v; nsp++;
      }
      return false;
    },
  });
  ds.sort((a, b) => a - b);
  const mean = ds.reduce((a, b) => a + b, 0) / Math.max(1, ds.length);
  return {
    kept, mean, p90: ds[Math.floor(ds.length * 0.9)] ?? NaN, max: ds[ds.length - 1] ?? NaN,
    lead: leads.reduce((a, b) => a + b, 0) / Math.max(1, leads.length), speed: sp / Math.max(1, nsp), touches,
  };
}

// ------------------------------------------------------------------ passing

export interface PassCase {
  /** Angle between the stick and the line to the intended teammate, deg. */
  offDeg: number;
  /** Distance to the intended teammate, m. */
  dist: number;
  /** PASS hold, ticks (3 = tap). */
  hold: number;
  assist: AssistLevel;
  seed: number;
  /** A decoy teammate at this angle from the intended one (deg) and distance (m), or none. */
  decoyDeg?: number;
  decoyDist?: number;
  /** Through ball (THROUGH) instead of a ground pass; the target runs forward at 6 m/s. */
  through?: boolean;
  sprint?: boolean;
}

export interface PassResult {
  target: number;
  /** Intended teammate controlled it (owner) within 4 s. */
  reached: boolean;
  /** Who had it after 4 s (-1 loose). */
  owner: number;
  /** Launch speed, m/s; where the ball came to rest / was received relative to the intended teammate, m. */
  speed: number;
  miss: number;
  /** Travel distance of the ball from the passer to the rest / receive point, m. */
  travel: number;
}

export const INTENDED = 7;
export const DECOY = 8;

export function passScenario(c: PassCase): PassResult {
  const s = base(c.seed, c.assist);
  const p = s.players[HS]!;
  p.x = -10; p.z = 0; p.fx = 1; p.fz = 0; p.vx = c.sprint ? 7 : 0; p.vz = 0;
  Object.assign(s.ball, { x: -9.5, y: 0.11, z: 0, px: -9.5, py: 0.11, pz: 0, vx: p.vx, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
  const t = s.players[INTENDED]!;
  t.x = p.x + c.dist; t.z = 0; t.vx = 0; t.vz = 0; t.fx = -1; t.fz = 0;
  if (c.decoyDeg !== undefined) {
    const d = s.players[DECOY]!;
    const [dx, dz] = rot(c.decoyDist ?? c.dist, 0, c.decoyDeg);
    d.x = p.x + dx; d.z = dz; d.vx = 0; d.vz = 0;
  }
  const [sx, sz] = rot(1, 0, c.offDeg);
  let kickTick = -1, speed = 0, owner = -1, recX = NaN, recZ = NaN, target = -1;
  const btn = c.through ? Btn.THROUGH : Btn.PASS;
  runTicks(s, 240, (tk, st, out) => {
    const f = out[0]!;
    if (kickTick < 0) {
      stick(f, sx, sz);
      if (c.sprint) f.buttons |= Btn.SPRINT;
      if (tk - 1 - 0 < c.hold) f.buttons |= btn;
    }
    if (c.through) { const q = st.players[INTENDED]!; if (q.ctrl < 0) { q.moveMode = MoveMode.DIRECT; } }
  }, {
    until: (st, ev) => {
      for (const e of ev) {
        if (e.type === EventType.KICK && e.a === HS && kickTick < 0 && e.b !== KickKind.DRIBBLE_TOUCH) {
          kickTick = st.tick; speed = Math.hypot(st.ball.vx, st.ball.vz); target = st.ball.passTarget;
        }
      }
      if (kickTick >= 0 && st.ball.owner >= 0 && st.ball.owner !== HS && owner < 0) {
        owner = st.ball.owner; recX = st.ball.x; recZ = st.ball.z; return true;
      }
      if (kickTick >= 0 && st.ball.owner < 0 && Math.hypot(st.ball.vx, st.ball.vz) < 0.3) { recX = st.ball.x; recZ = st.ball.z; return true; }
      return false;
    },
  });
  const q = s.players[INTENDED]!;
  return {
    target, reached: owner === INTENDED, owner, speed,
    miss: Math.hypot(recX - q.x, recZ - q.z), travel: Math.hypot(recX + 9.5, recZ),
  };
}

// ------------------------------------------------------------------ shooting

export type ShotStyle = 'normal' | 'finesse' | 'power' | 'trivela' | 'chip' | 'low';

export interface ShotCase {
  style: ShotStyle;
  /** Shooter position (x toward the goal at +52.5), stick aim z on the goal line. */
  x: number; z: number; aimZ: number;
  hold: number;
  seed: number;
}

export interface ShotResult {
  kind: number;
  speed: number;
  /** Max sideways deviation of the flight from the straight launch line before the goal line, m (+ = toward +z). */
  curve: number;
  /** Where it crossed the goal line (z, y) or NaN. */
  crossZ: number; crossY: number;
  /** Flight time to the goal line, s. */
  time: number;
  /** Wind-up ticks from the press to contact. */
  windup: number;
}

export function shotScenario(c: ShotCase): ShotResult {
  const s = base(c.seed);
  const p = s.players[HS]!;
  p.x = c.x; p.z = c.z; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0;
  // Keeper out of the way (the flight is what we measure).
  const k = s.players[11]!; k.x = 60; k.z = 30; k.active = 1;
  Object.assign(s.ball, { x: c.x + 0.5, y: 0.11, z: c.z, px: c.x + 0.5, py: 0.11, pz: c.z, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
  const gx = 52.5;
  const adx = gx - c.x, adz = c.aimZ - c.z;
  let kick = -1, kind = 0, speed = 0, lx = 0, lz = 0, ux = 0, uz = 0, curve = 0, crossZ = NaN, crossY = NaN, time = NaN;
  runTicks(s, 200, (tk, _st, out) => {
    const f = out[0]!;
    if (kick >= 0) return;
    stick(f, adx, adz);
    const pressed = tk - 1 < c.hold;
    if (c.style === 'finesse') f.buttons |= Btn.MOD_R;
    if (c.style === 'power') f.buttons |= Btn.MOD_R | Btn.MOD_L;
    if (c.style === 'chip') f.buttons |= Btn.MOD_L;
    if (c.style === 'trivela') f.buttons |= Btn.SHIELD;
    if (pressed) f.buttons |= Btn.SHOOT;
    if (c.style === 'low' && tk - 1 === c.hold + 1) f.buttons |= Btn.SHOOT;
  }, {
    until: (st, ev) => {
      for (const e of ev) {
        if (e.type === EventType.KICK && e.a === HS && kick < 0 && e.b !== KickKind.DRIBBLE_TOUCH) {
          kick = st.tick; kind = e.b; speed = Math.hypot(st.ball.vx, st.ball.vy, st.ball.vz);
          lx = st.ball.x; lz = st.ball.z;
          const h = Math.hypot(st.ball.vx, st.ball.vz); ux = st.ball.vx / h; uz = st.ball.vz / h;
        }
      }
      if (kick >= 0) {
        const b = st.ball;
        const side = (b.x - lx) * -uz + (b.z - lz) * ux;
        if (b.x < gx && Math.abs(side) > Math.abs(curve)) curve = side;
        if (b.x >= gx && Number.isNaN(crossZ)) {
          crossZ = b.z; crossY = b.y; time = (st.tick - kick) / 60; return true;
        }
        if (st.tick - kick > 150) return true;
      }
      return false;
    },
  });
  // Sign: + = bends toward +z relative to the launch line, from the shooter's view with the goal at +x (+z is right).
  return { kind, speed, curve, crossZ, crossY, time, windup: kick };
}

// ------------------------------------------------------------------ passing among a full team

export interface CrowdPassResult { n: number; targeted: number; reached: number }

/**
 * Passes from the kick-off shape (no parking: every teammate and opponent where initMatch puts them, the CPU moving them):
 * the human (slot HS, moved to (-6, 0)) aims at each teammate 8-35 m away with the stick offDeg off the line to him
 * (both sides), PASS held `hold` ticks. Counts the passes that targeted / reached that teammate.
 */
export function crowdPassScenario(offDeg: number, hold: number, seed: number, assist = AssistLevel.ASSISTED): CrowdPassResult {
  const res: CrowdPassResult = { n: 0, targeted: 0, reached: 0 };
  for (let mate = 1; mate < 11; mate++) {
    if (mate === HS) continue;
    for (const sg of [1, -1]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: [{ side: 0, slot: HS, assist, autoSwitch: AutoSwitch.OFF }] });
      const p = s.players[HS]!;
      p.x = -6; p.z = 0; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0;
      const q = s.players[mate]!;
      const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
      if (d < 8 || d > 35) continue;
      Object.assign(s.ball, { x: -5.5, y: 0.11, z: 0, px: -5.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
      // Unambiguous targets only: no other teammate within 12 degrees of the line to him (on a shared line the power
      // decides, near or far, by design).
      let amb = false;
      for (let o = 1; o < 11; o++) {
        if (o === mate || o === HS) continue;
        const r = s.players[o]!, ox = r.x - p.x, oz = r.z - p.z, od = Math.hypot(ox, oz);
        if (od > 1 && (ox * dx + oz * dz) / (od * d) > Math.cos((12 * Math.PI) / 180)) amb = true;
      }
      if (amb) continue;
      const [sx, sz] = rot(dx, dz, offDeg * sg);
      // "Slightly off" means the stick still points nearer to him than to anyone else (else EA FC picks the other man too).
      const sl = Math.hypot(sx, sz);
      const cm = (sx * dx + sz * dz) / (sl * d);
      let nearer = false;
      for (let o = 0; o < 11; o++) {
        if (o === mate || o === HS) continue;
        const r = s.players[o]!, ox = r.x - p.x, oz = r.z - p.z, od = Math.hypot(ox, oz);
        if (od > 1 && (sx * ox + sz * oz) / (sl * od) > cm) nearer = true;
      }
      if (nearer) continue;
      let kick = -1, target = -1, owner = -1;
      runTicks(s, 200, (tk, _st, out) => {
        if (kick >= 0) return;
        stick(out[0]!, sx, sz);
        if (tk - 1 < hold) out[0]!.buttons |= Btn.PASS;
      }, {
        until: (st, ev) => {
          for (const e of ev) if (e.type === EventType.KICK && e.a === HS && kick < 0 && e.b !== KickKind.DRIBBLE_TOUCH) { kick = st.tick; target = st.ball.passTarget; }
          if (kick >= 0 && st.ball.owner >= 0 && st.ball.owner !== HS) { owner = st.ball.owner; return true; }
          return false;
        },
      });
      res.n++;
      if (target === mate) res.targeted++;
      if (owner === mate) res.reached++;
    }
  }
  return res;
}
