/**
 * QF-3 QA-23 multi-touch matrix and QA-25 button swipes vs pitch gestures, through the real touch source (pointer
 * manager, controls, mapper; qf-3-touch-rig): stick + every button, two buttons + stick, gesture + button, five
 * fingers, a thumb sliding off a held button, a second finger on a held button, and a seeded random multi-touch fuzz
 * (possession swaps mid-hold included) that must always end with nothing held.
 */
import { describe, expect, it } from 'vitest';
import { GestureKind, MatchPhase } from '../../src/contracts/enums';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ClusterMode, ClusterSlot } from '../../src/contracts/touch';
import { makeScenario } from '../harness/scenario';
import { createTouchRig, H, W, type TouchRig } from './qf-3-touch-rig';

function attackState(): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 10, z: 0 }],
    ball: { owner: 9, x: 10.4, y: 0.11, z: 0, lastTouchTeam: 0 },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return s;
}

function defenceState(): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }],
    players: [{ slot: 4, x: -24, z: 2 }, { slot: 18, x: -20, z: 0 }],
    ball: { owner: 18, lastTouchTeam: 1, x: -19.6, y: 0.11, z: 0 },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return s;
}

const STICK = { x: 250, y: 520 };

/** Put a thumb on the stick and push it right (screen), leaving it down. */
function pushStick(r: TouchRig, id = 1): void {
  r.down(id, STICK.x, STICK.y);
  r.drag(id, STICK.x, STICK.y, STICK.x + 70, STICK.y, 50, 3);
}

/** Frames from index `from` on. */
const since = (r: TouchRig, from: number): InputFrame[] => r.frames.slice(from);
const anyBits = (fs: InputFrame[], bits: number): boolean => fs.some((f) => (f.buttons & bits) === bits);
const stickAlways = (fs: InputFrame[]): boolean => fs.every((f) => f.mx > 60);

type Gesture = 'tap' | 'hold' | 'up' | 'down' | 'left' | 'right';

/** Press a cluster slot with finger `id`: a tap, a 400 ms hold, or a flicked swipe in a direction. */
function press(r: TouchRig, slot: ClusterSlot, g: Gesture, id = 2): void {
  const p = r.slot(slot);
  r.down(id, p.x, p.y);
  if (g === 'tap') { r.wait(60); r.up(id, p.x, p.y); return; }
  if (g === 'hold') { r.wait(400); r.up(id, p.x, p.y); return; }
  const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[g];
  r.wait(17); r.move(id, p.x + d[0]! * 15, p.y + d[1]! * 15);
  r.wait(17); r.move(id, p.x + d[0]! * 40, p.y + d[1]! * 40);
  r.wait(17); r.up(id, p.x + d[0]! * 40, p.y + d[1]! * 40);
}

/** Expected bits (any frame) for each attack cell, ATTACK mode (TCH-07 table). 0 = a skill edge instead. */
const ATTACK_CELLS: [ClusterSlot, Gesture, number][] = [
  [ClusterSlot.LOW, 'tap', Btn.PASS], [ClusterSlot.LOW, 'hold', Btn.PASS], [ClusterSlot.LOW, 'up', Btn.LOB],
  [ClusterSlot.LOW, 'down', Btn.MOD_L | Btn.PASS], [ClusterSlot.LOW, 'left', Btn.MOD_L | Btn.MOD_R | Btn.LOB],
  [ClusterSlot.LOW, 'right', Btn.MOD_R | Btn.PASS],
  [ClusterSlot.MID, 'tap', Btn.THROUGH], [ClusterSlot.MID, 'hold', Btn.THROUGH], [ClusterSlot.MID, 'up', Btn.MOD_L | Btn.THROUGH],
  [ClusterSlot.MID, 'down', Btn.MOD_L],
  [ClusterSlot.HIGH, 'tap', Btn.SHOOT], [ClusterSlot.HIGH, 'hold', Btn.SHOOT], [ClusterSlot.HIGH, 'up', Btn.MOD_L | Btn.SHOOT],
  [ClusterSlot.HIGH, 'down', Btn.MOD_R | Btn.SHOOT], [ClusterSlot.HIGH, 'left', Btn.SHOOT],
  [ClusterSlot.HIGH, 'right', Btn.MOD_L | Btn.MOD_R | Btn.SHOOT],
  [ClusterSlot.BIG, 'hold', Btn.SPRINT], [ClusterSlot.BIG, 'tap', 0], [ClusterSlot.BIG, 'up', 0],
];

const DEFENCE_CELLS: [ClusterSlot, Gesture, number][] = [
  [ClusterSlot.BIG, 'tap', Btn.SHOOT], [ClusterSlot.BIG, 'hold', Btn.SPRINT], [ClusterSlot.BIG, 'left', Btn.MOD_R | Btn.SHOOT],
  [ClusterSlot.HIGH, 'tap', Btn.LOB], [ClusterSlot.LOW, 'tap', Btn.MOD_L], [ClusterSlot.LOW, 'up', Btn.RS_FLICK],
  [ClusterSlot.MID, 'tap', Btn.MOD_R], [ClusterSlot.MID, 'hold', Btn.MOD_R], [ClusterSlot.MID, 'down', Btn.THROUGH],
];

function neutralAfter(r: TouchRig): void {
  r.tick(40);
  const f = r.frames.at(-1)!;
  expect(f.buttons).toBe(0);
  expect(f.mx).toBe(0);
  expect(f.mz).toBe(0);
  expect(r.st.held).toBe(0);
  expect(r.st.stickActive).toBe(false);
  expect(r.st.power).toBe(0);
}

describe('QF-3 QA-23 multi-touch matrix', () => {
  it('stick + every attack button cell: the cell reaches the frame and the stick never drops', () => {
    for (const [slot, g, bits] of ATTACK_CELLS) {
      const r = createTouchRig(attackState(), { stepSim: false });
      r.tick(2);
      pushStick(r);
      const from = r.frames.length;
      press(r, slot, g);
      r.tick(12);
      const fs = since(r, from);
      if (bits !== 0) expect(anyBits(fs, bits), `slot ${slot} ${g}`).toBe(true);
      else expect(fs.some((f) => f.skill !== 0), `slot ${slot} ${g}: skill`).toBe(true);
      expect(stickAlways(fs), `slot ${slot} ${g}: stick held`).toBe(true);
      r.up(1, STICK.x + 70, STICK.y);
      neutralAfter(r);
    }
  });

  it('stick + every defence button cell', () => {
    for (const [slot, g, bits] of DEFENCE_CELLS) {
      const r = createTouchRig(defenceState(), { stepSim: false });
      r.tick(2);
      expect(r.st.mode).toBe(ClusterMode.DEFENCE);
      pushStick(r);
      const from = r.frames.length;
      press(r, slot, g);
      r.tick(12);
      const fs = since(r, from);
      expect(anyBits(fs, bits), `slot ${slot} ${g}`).toBe(true);
      expect(stickAlways(fs), `slot ${slot} ${g}: stick held`).toBe(true);
      r.up(1, STICK.x + 70, STICK.y);
      neutralAfter(r);
    }
  });

  it('two buttons + stick: SPRINT held and PASS held together, with the stick pushed', () => {
    const r = createTouchRig(attackState(), { stepSim: false });
    r.tick(2);
    pushStick(r);
    const big = r.slot(ClusterSlot.BIG), low = r.slot(ClusterSlot.LOW);
    r.down(2, big.x, big.y);
    r.wait(50);
    r.down(3, low.x, low.y);
    r.wait(400);
    const f = r.frames.at(-1)!;
    expect(f.buttons & (Btn.SPRINT | Btn.PASS)).toBe(Btn.SPRINT | Btn.PASS);
    expect(f.mx).toBeGreaterThan(60);
    r.up(3, low.x, low.y);
    r.wait(50);
    expect(r.frames.at(-1)!.buttons & Btn.PASS).toBe(0);
    expect(r.frames.at(-1)!.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    r.up(2, big.x, big.y);
    r.up(1, STICK.x + 70, STICK.y);
    neutralAfter(r);
  });

  it('gesture + button: a pitch swipe while SPRINT is held is a gesture, and SPRINT stays held', () => {
    const r = createTouchRig(attackState(), { stepSim: false });
    r.tick(2);
    pushStick(r);
    const big = r.slot(ClusterSlot.BIG);
    r.down(2, big.x, big.y);
    r.wait(300);
    const from = r.frames.length;
    r.down(4, 800, 300);
    r.drag(4, 800, 300, 950, 250, 120, 6);
    r.up(4, 950, 250);
    r.tick(10);
    const fs = since(r, from);
    expect(fs.some((f) => f.gesture === GestureKind.SWIPE || f.gesture === GestureKind.CURVED_SWIPE)).toBe(true);
    expect(fs.every((f) => (f.buttons & Btn.SPRINT) !== 0)).toBe(true);
    expect(stickAlways(fs)).toBe(true);
    r.up(2, big.x, big.y);
    r.up(1, STICK.x + 70, STICK.y);
    neutralAfter(r);
  });

  it('five fingers at once: stick, SPRINT, SHOOT (held), two pitch fingers; all lifted -> nothing held', () => {
    const r = createTouchRig(attackState(), { stepSim: false });
    r.tick(2);
    pushStick(r);
    const big = r.slot(ClusterSlot.BIG), high = r.slot(ClusterSlot.HIGH);
    r.down(2, big.x, big.y);
    r.down(3, high.x, high.y);
    r.down(4, 800, 200);
    r.down(5, 700, 300);
    r.wait(400);
    expect(r.src.overlay.el).toBeTruthy();
    const f = r.frames.at(-1)!;
    expect(f.buttons & (Btn.SPRINT | Btn.SHOOT)).toBe(Btn.SPRINT | Btn.SHOOT);
    expect(f.mx).toBeGreaterThan(60);
    for (const [id, x, y] of [[5, 700, 300], [3, high.x, high.y], [1, STICK.x + 70, STICK.y], [4, 800, 200], [2, big.x, big.y]] as const) r.up(id, x, y);
    neutralAfter(r);
  });

  it('a thumb that slides off a held button keeps the hold until it lifts (and is no pitch gesture)', () => {
    const r = createTouchRig(attackState(), { stepSim: false });
    r.tick(2);
    const big = r.slot(ClusterSlot.BIG);
    r.down(2, big.x, big.y);
    r.wait(300);
    // Slide slowly off the button toward the pitch (slow drift is no swipe).
    for (let i = 1; i <= 20; i++) { r.wait(40); r.move(2, big.x - i * 8, big.y - i * 6); }
    const fs = r.frames.slice(-20);
    expect(fs.every((f) => (f.buttons & Btn.SPRINT) !== 0)).toBe(true);
    r.up(2, big.x - 160, big.y - 120);
    r.tick(20);
    expect(r.frames.slice(-20).every((f) => f.gesture === GestureKind.NONE && f.skill === 0)).toBe(true);
    neutralAfter(r);
  });

  it('a second finger landing on a held button is swallowed: no second press, no pitch gesture', () => {
    const r = createTouchRig(attackState(), { stepSim: false });
    r.tick(2);
    const low = r.slot(ClusterSlot.LOW);
    r.down(2, low.x, low.y);
    r.wait(300);
    const from = r.frames.length;
    r.down(3, low.x + 5, low.y + 5); r.wait(50); r.up(3, low.x + 5, low.y + 5);
    r.wait(200);
    const fs = since(r, from);
    expect(fs.every((f) => (f.buttons & Btn.PASS) !== 0 && f.gesture === GestureKind.NONE)).toBe(true);
    r.up(2, low.x, low.y);
    neutralAfter(r);
  });
});

describe('QF-3 QA-25 button swipes vs pitch gestures', () => {
  it('glitch: button swipe read as a pitch gesture - every attack and defence swipe that starts on a button stays a button swipe, even when it ends on the pitch', () => {
    for (const make of [attackState, defenceState]) {
      for (const slot of [ClusterSlot.BIG, ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH]) {
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-0.7, -0.7]] as const) {
          const r = createTouchRig(make(), { stepSim: false });
          r.tick(2);
          const p = r.slot(slot);
          r.down(2, p.x, p.y);
          // A long fast swipe that leaves the button and ends far out on the pitch.
          for (let i = 1; i <= 6; i++) { r.wait(17); r.move(2, p.x + dx * i * 40, p.y + dy * i * 40); }
          r.up(2, p.x + dx * 240, p.y + dy * 240);
          r.tick(30);
          expect(r.frames.every((f) => f.gesture === GestureKind.NONE), `mode ${make.name} slot ${slot} dir ${dx},${dy}`).toBe(true);
        }
      }
    }
  });

  it('a pitch swipe that ends on a button stays a pitch gesture (no button press)', () => {
    const r = createTouchRig(attackState(), { stepSim: false });
    r.tick(2);
    const high = r.slot(ClusterSlot.HIGH);
    r.down(4, 700, 250);
    r.drag(4, 700, 250, high.x, high.y, 120, 6);
    r.up(4, high.x, high.y);
    r.tick(20);
    expect(r.frames.some((f) => f.gesture !== GestureKind.NONE)).toBe(true);
    expect(r.frames.every((f) => f.buttons === 0)).toBe(true);
  });
});

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('QF-3 QA-23/24 seeded multi-touch fuzz', () => {
  it('random down / move / up / cancel on every zone, possession swaps mid-hold: never stuck, never a crash', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const rand = rng(seed);
      const s = attackState();
      const r = createTouchRig(s, { stepSim: false });
      r.tick(1);
      const down = new Map<number, { x: number; y: number }>();
      const spots = (): { x: number; y: number } => {
        const k = rand();
        if (k < 0.45) {
          const sl = [ClusterSlot.BIG, ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH][Math.floor(rand() * 4)]!;
          const p = r.slot(sl);
          return { x: p.x + (rand() - 0.5) * 30, y: p.y + (rand() - 0.5) * 30 };
        }
        return { x: rand() * W, y: rand() * H };
      };
      for (let step = 0; step < 240; step++) {
        const k = rand();
        if (k < 0.12 && down.size < 6) {
          const id = 10 + Math.floor(rand() * 8);
          const p = spots();
          r.down(id, p.x, p.y);
          down.set(id, p);
        } else if (k < 0.5 && down.size > 0) {
          const ids = [...down.keys()];
          const id = ids[Math.floor(rand() * ids.length)]!;
          const p = down.get(id)!;
          p.x += (rand() - 0.5) * 60; p.y += (rand() - 0.5) * 60;
          r.move(id, p.x, p.y);
        } else if (k < 0.6 && down.size > 0) {
          const ids = [...down.keys()];
          const id = ids[Math.floor(rand() * ids.length)]!;
          const p = down.get(id)!;
          if (rand() < 0.2) r.cancel(id); else r.up(id, p.x, p.y);
          down.delete(id);
        } else if (k < 0.63) {
          // Possession swap mid-hold (the cluster swaps; held thumbs keep their meaning).
          const b = s.ball;
          if (b.owner === 9) { b.owner = 18; b.lastTouchTeam = 1; } else { b.owner = 9; b.lastTouchTeam = 0; }
        } else if (k < 0.64) {
          r.releaseAll();
          down.clear();
        }
        r.wait(rand() * 40);
      }
      for (const [id, p] of down) r.up(id, p.x, p.y);
      r.tick(60);
      const f = r.frames.at(-1)!;
      expect(f.buttons, `seed ${seed}`).toBe(0);
      expect(f.mx === 0 && f.mz === 0, `seed ${seed}: stick`).toBe(true);
      expect(r.st.held, `seed ${seed}: held`).toBe(0);
      expect(r.st.stickActive, `seed ${seed}: stick active`).toBe(false);
      expect(r.st.power, `seed ${seed}: power`).toBe(0);
      expect(r.st.previewCount, `seed ${seed}: preview`).toBe(0);
      for (const fr of r.frames) {
        for (const v of Object.values(fr)) expect(Number.isFinite(v), `seed ${seed}: finite frame`).toBe(true);
      }
    }
  });
});

describe('QF-3 QA-23/24 seeded multi-touch fuzz with the sim stepping', () => {
  it('random touches on the real pipeline: once every finger is up, no bit, stick or power bar stays (sim and overlay)', () => {
    for (let seed = 101; seed <= 115; seed++) {
      const rand = rng(seed);
      const s = attackState();
      const r = createTouchRig(s);
      r.tick(1);
      const down = new Map<number, { x: number; y: number }>();
      for (let step = 0; step < 200; step++) {
        const k = rand();
        if (k < 0.15 && down.size < 5) {
          const id = 20 + Math.floor(rand() * 8);
          const sl = [ClusterSlot.BIG, ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH][Math.floor(rand() * 4)]!;
          const p = rand() < 0.6 ? { ...r.slot(sl) } : { x: rand() * W, y: 60 + rand() * (H - 120) };
          r.down(id, p.x, p.y);
          down.set(id, p);
        } else if (k < 0.45 && down.size > 0) {
          const ids = [...down.keys()];
          const id = ids[Math.floor(rand() * ids.length)]!;
          const p = down.get(id)!;
          p.x += (rand() - 0.5) * 50; p.y += (rand() - 0.5) * 50;
          r.move(id, p.x, p.y);
        } else if (k < 0.55 && down.size > 0) {
          const ids = [...down.keys()];
          const id = ids[Math.floor(rand() * ids.length)]!;
          const p = down.get(id)!;
          if (rand() < 0.25) r.cancel(id); else r.up(id, p.x, p.y);
          down.delete(id);
        }
        r.wait(rand() * 50);
      }
      for (const [id, p] of down) r.up(id, p.x, p.y);
      r.tick(240);
      const f = r.frames.at(-1)!;
      expect(f.buttons, `seed ${seed}`).toBe(0);
      expect(f.mx === 0 && f.mz === 0, `seed ${seed}: stick`).toBe(true);
      expect(r.st.power, `seed ${seed}: overlay power`).toBe(0);
      expect(r.st.powerButton, `seed ${seed}: power button`).toBe(-1);
      expect(s.ctrl[0]!.powerBtn, `seed ${seed}: sim charge`).toBe(0);
      expect(s.ctrl[0]!.buttons, `seed ${seed}: sim buttons`).toBe(0);
    }
  });
});

describe('QF-3 QA-23 layouts: mirrored (left-handed) and fixed stick', () => {
  it('mirrored: the stick lives on the right half, the cluster bottom left, pitch gestures on the left half', () => {
    const r = createTouchRig(attackState(), { stepSim: false, settings: { mirror: true } });
    r.tick(2);
    const low = r.slot(ClusterSlot.LOW);
    expect(low.x).toBeLessThan(W / 2);
    // Stick on the right half.
    r.down(1, 900, 450);
    r.drag(1, 900, 450, 970, 450, 50, 3);
    expect(r.frames.at(-1)!.mx).toBeGreaterThan(60);
    // PASS on the left cluster while the stick is held.
    r.down(2, low.x, low.y); r.wait(400);
    expect(r.frames.at(-1)!.buttons & Btn.PASS).toBe(Btn.PASS);
    r.up(2, low.x, low.y);
    // A swipe on the left half (above the cluster) is a pitch gesture.
    const from = r.frames.length;
    r.down(4, 150, 200);
    r.drag(4, 150, 200, 380, 180, 120, 6);
    r.up(4, 380, 180);
    r.tick(5);
    expect(r.frames.slice(from).some((f) => f.gesture !== GestureKind.NONE)).toBe(true);
    r.up(1, 970, 450);
    neutralAfter(r);
  });

  it('fixed stick: a touch near its ring drives it from the fixed origin; a tap far from it on the same half is a pitch gesture', () => {
    const r = createTouchRig(attackState(), { stepSim: false, settings: { floatingStick: false } });
    r.tick(2);
    const cfg = r.src.stickConfig;
    expect(cfg.floating).toBe(false);
    // Touch 20 px right of the fixed origin: the stick deflects right at once (origin stays fixed).
    r.down(1, cfg.fixedX + 60, cfg.fixedY);
    r.tick(1);
    expect(r.frames.at(-1)!.mx).toBeGreaterThan(30);
    expect(r.st.stickOriginX).toBe(cfg.fixedX);
    r.up(1, cfg.fixedX + 60, cfg.fixedY);
    // A quick tap high on the left half, far from the ring, reaches the pitch gestures (a held-back TAP).
    const from = r.frames.length;
    r.down(5, 200, 150); r.wait(40); r.up(5, 200, 150);
    r.tick(30);
    expect(r.frames.slice(from).some((f) => f.gesture === GestureKind.TAP)).toBe(true);
    neutralAfter(r);
  });
});

describe('QF-3 touch power bar (section 9 "The power bar shows by the player and on the button")', () => {
  it('a held PASS fills the bar on the PASS button while it charges; it empties when the kick goes', () => {
    const r = createTouchRig(attackState());
    r.tick(2);
    const low = r.slot(ClusterSlot.LOW);
    r.down(2, low.x, low.y);
    let maxPower = 0;
    let onPass = false;
    for (let i = 0; i < 24; i++) {
      r.tick();
      if (r.st.power > maxPower) maxPower = r.st.power;
      if (r.st.power > 0 && r.st.powerButton === 0) onPass = true; // TouchButtonId.PASS
    }
    expect(maxPower).toBeGreaterThan(0.2);
    expect(onPass).toBe(true);
    r.up(2, low.x, low.y);
    r.tick(40);
    expect(r.st.power).toBe(0);
    expect(r.st.powerButton).toBe(-1);
  });
});
