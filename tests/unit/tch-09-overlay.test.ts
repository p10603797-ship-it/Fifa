/**
 * TCH-09 touch overlay: write-on-change DOM logic (on a tiny fake DOM, tests/unit/tch-09-fakedom.ts), labels per
 * mode from the TCH-04 cluster controller and from the intent state alone, pressed state, power ring, hints, stick,
 * set-piece preview dots, Gestures Only, controller hiding (createPadDriveWatcher), and the pure layout checks
 * (safe area + HUD regions at 4:3, 16:10 and 21:9).
 */
import { describe, expect, it } from 'vitest';
import { createDefaultSettings, type TouchSettings } from '../../src/contracts/settings';
import { ClusterMode, ClusterSlot, createTouchIntentState, TouchButtonId, type TouchIntentState } from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import { computeClusterLayout, createAttackCluster, type ClusterLayout } from '../../src/input/touch/attack';
import { createClusterController, createDefenceCluster } from '../../src/input/touch/cluster';
import {
  circleClearOfRect, createPadDriveWatcher, createTouchOverlay, hintDirMask, hudRegions, layoutClearOfHud, powerRingAngles,
  PREVIEW_DOTS, rectDistance, slotCaption, type TouchOverlay,
} from '../../src/input/touch/overlay';
import { computeStickConfig, createStickConfig } from '../../src/input/touch/stick';
import { asHtml, fakeRoot, type FakeEl } from './tch-09-fakedom';

const W = 1180, H = 820;
const NO_SAFE = { top: 0, right: 0, bottom: 0, left: 0 };

interface Rig {
  root: FakeEl;
  st: TouchIntentState;
  ov: TouchOverlay;
  layout: ClusterLayout;
  slot(s: ClusterSlot): FakeEl;
  text(s: ClusterSlot): string;
  layer(): FakeEl;
}

function rig(touch?: Partial<TouchSettings>): Rig {
  const root = fakeRoot();
  const st = createTouchIntentState();
  const ts = { ...createDefaultSettings().controls.touch, ...touch };
  const ov = createTouchOverlay(asHtml(root), st, T_TOUCHUI.stickRadius, { touchSettings: () => ts, now: () => 10_000 });
  const layout = computeClusterLayout(W, H, NO_SAFE);
  ov.layout(layout);
  ov.sync();
  const slot = (s: ClusterSlot): FakeEl => ov.slotEl(s) as unknown as FakeEl;
  return {
    root, st, ov, layout, slot,
    text: (s) => slot(s).one('dk-tbtn-label').textContent,
    layer: () => root.children[0]!,
  };
}

const LABEL_ORDER = [ClusterSlot.BIG, ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH];

describe('TCH-09 structure', () => {
  it('one pointer layer, four cluster slots + pause as .dk-tbtn (BIG = .dk-tbtn--big), stick, preview dots', () => {
    const r = rig();
    const layer = r.layer();
    expect(layer.classList.contains('dk-touch')).toBe(true);
    expect(layer.hasAttribute('data-touch-layer')).toBe(true);
    expect(layer.all('dk-tbtn')).toHaveLength(5);
    expect(layer.all('dk-tbtn--big')).toHaveLength(1);
    expect(layer.all('dk-tbtn--pause')).toHaveLength(1);
    expect(layer.all('dk-stick')).toHaveLength(1);
    expect(layer.all('dk-dot')).toHaveLength(PREVIEW_DOTS);
    expect(r.slot(ClusterSlot.BIG).getAttribute('data-btn')).toBe(String(TouchButtonId.SPRINT_SKILL));
    r.ov.dispose();
    expect(r.root.children).toHaveLength(0);
  });

  it('layout() positions slots and pause with translate3d only (size from the layout radius)', () => {
    const r = rig();
    const g = r.layout.slots[ClusterSlot.LOW];
    const el = r.slot(ClusterSlot.LOW);
    expect(el.style.transform).toBe(`translate3d(${g.cx - g.r}px, ${g.cy - g.r}px, 0)`);
    expect(el.style.width).toBe(`${g.r * 2}px`);
    expect(el.style.left).toBeUndefined();
  });
});

describe('TCH-09 labels per mode (intent-state view, no cluster bound)', () => {
  it('attack, defence, CLEAR, keeper and cut-scene labels; the big button names both meanings', () => {
    const r = rig();
    expect(LABEL_ORDER.map((s) => r.text(s))).toEqual(['SPRINT', 'PASS', 'THROUGH', 'SHOOT']);
    expect(r.slot(ClusterSlot.BIG).one('dk-tbtn-cap').textContent).toBe('& SKILL');
    r.st.mode = ClusterMode.DEFENCE;
    r.ov.sync();
    expect(LABEL_ORDER.map((s) => r.text(s))).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'SLIDE']);
    expect(r.slot(ClusterSlot.BIG).one('dk-tbtn-cap').textContent).toBe('& SPRINT');
    expect(r.slot(ClusterSlot.HIGH).getAttribute('data-btn')).toBe(String(TouchButtonId.SLIDE));
    r.st.clearOn = true;
    r.ov.sync();
    expect(r.text(ClusterSlot.HIGH)).toBe('CLEAR');
    r.st.clearOn = false;
    r.st.mode = ClusterMode.KEEPER;
    r.ov.sync();
    expect(LABEL_ORDER.map((s) => r.text(s))).toEqual(['DROP', 'THROW', 'DRIVEN THROW', 'DROP KICK']);
    expect(r.slot(ClusterSlot.BIG).one('dk-tbtn-cap').textContent).toBe('');
    r.st.mode = ClusterMode.HIDDEN;
    r.ov.sync();
    for (const s of LABEL_ORDER) expect(r.slot(s).classList.contains('is-hidden')).toBe(true);
    r.st.mode = ClusterMode.ATTACK;
    r.ov.sync();
    for (const s of LABEL_ORDER) expect(r.slot(s).classList.contains('is-hidden')).toBe(false);
  });

  it('a held thumb keeps its touch-down meaning across a swap; the slot relabels when it lifts', () => {
    const r = rig();
    r.st.held = 1 << TouchButtonId.SHOOT;
    r.ov.sync();
    expect(r.slot(ClusterSlot.HIGH).classList.contains('is-pressed')).toBe(true);
    r.st.mode = ClusterMode.DEFENCE;
    r.ov.sync();
    expect(r.text(ClusterSlot.HIGH)).toBe('SHOOT');
    expect(r.slot(ClusterSlot.HIGH).classList.contains('is-pressed')).toBe(true);
    expect(r.text(ClusterSlot.LOW)).toBe('SWITCH');
    r.st.held = 0;
    r.ov.sync();
    expect(r.text(ClusterSlot.HIGH)).toBe('SLIDE');
    expect(r.slot(ClusterSlot.HIGH).classList.contains('is-pressed')).toBe(false);
  });

  it('pause pressed state follows the PAUSE held bit', () => {
    const r = rig();
    const pause = r.layer().one('dk-tbtn--pause');
    r.st.held = 1 << TouchButtonId.PAUSE;
    r.ov.sync();
    expect(pause.classList.contains('is-pressed')).toBe(true);
    r.st.held = 0;
    r.ov.sync();
    expect(pause.classList.contains('is-pressed')).toBe(false);
  });
});

describe('TCH-09 bound to the TCH-04 cluster controller', () => {
  function bound(): Rig & { press(slot: ClusterSlot, t: number): void; lift(slot: ClusterSlot, t: number): void; tick(t: number): void } {
    const r = rig();
    const hints = { on: true };
    const attack = createAttackCluster(r.st, r.layout, undefined, { hints: () => hints.on });
    const defence = createDefenceCluster(r.st, r.layout, undefined, { hints: () => hints.on });
    const cluster = createClusterController({ state: r.st, attack, defence });
    r.ov.bind({ cluster });
    cluster.sync(0);
    r.ov.sync();
    const ctl = (slot: ClusterSlot) => (r.st.mode === ClusterMode.DEFENCE ? defence.slot(slot) : attack.slot(slot));
    return {
      ...r,
      press(slot, t) {
        const g = r.layout.slots[slot];
        const c = ctl(slot);
        c.down(slot + 1, g.cx, g.cy, t);
        cluster.sync(t);
        r.ov.sync();
      },
      lift(slot, t) {
        const g = r.layout.slots[slot];
        for (const c of cluster.controls) if (c.pointerId === slot + 1) c.up(slot + 1, g.cx, g.cy, t);
        cluster.sync(t);
        r.ov.sync();
      },
      tick(t) {
        cluster.update(t);
        r.ov.sync();
      },
    };
  }

  it('the pressed class is written synchronously in the pointer-down path (cluster.sync + overlay.sync)', () => {
    const b = bound();
    b.press(ClusterSlot.BIG, 1000);
    expect(b.slot(ClusterSlot.BIG).classList.contains('is-pressed')).toBe(true);
    expect(b.st.held & (1 << TouchButtonId.SPRINT_SKILL)).not.toBe(0);
    b.lift(ClusterSlot.BIG, 1100);
    expect(b.slot(ClusterSlot.BIG).classList.contains('is-pressed')).toBe(false);
  });

  it('labels swap with possession and a held press keeps its meaning until it lifts', () => {
    const b = bound();
    b.press(ClusterSlot.HIGH, 1000);
    b.st.mode = ClusterMode.DEFENCE;
    b.tick(1010);
    expect(b.text(ClusterSlot.HIGH)).toBe('SHOOT');
    expect(b.text(ClusterSlot.BIG)).toBe('TACKLE');
    b.lift(ClusterSlot.HIGH, 1020);
    expect(b.text(ClusterSlot.HIGH)).toBe('SLIDE');
    expect(b.slot(ClusterSlot.HIGH).getAttribute('data-btn')).toBe(String(TouchButtonId.SLIDE));
  });

  it('direction hints show around a 250 ms hold with the section 9 swipe labels, and go when it lifts', () => {
    const b = bound();
    b.press(ClusterSlot.LOW, 1000);
    const hints = b.slot(ClusterSlot.LOW).all('dk-hint');
    expect(hints.filter((h) => h.classList.contains('is-on'))).toHaveLength(0);
    b.tick(1000 + T_TOUCHUI.hintHoldMs + 5);
    const on = hints.filter((h) => h.classList.contains('is-on')).map((h) => h.one('dk-hint-text').textContent);
    expect(on).toEqual(['Lob', 'Pass and go', 'Driven lob', 'Driven pass']);
    b.lift(ClusterSlot.LOW, 1400);
    expect(hints.filter((h) => h.classList.contains('is-on'))).toHaveLength(0);
  });

  it('Gestures Only hides PASS, THROUGH and SHOOT (live() false) but never the big button', () => {
    const r = rig();
    const g = { only: true };
    const attack = createAttackCluster(r.st, r.layout, undefined, { gesturesOnly: () => g.only });
    const defence = createDefenceCluster(r.st, r.layout);
    const cluster = createClusterController({ state: r.st, attack, defence });
    r.ov.bind({ cluster });
    cluster.sync(0);
    r.ov.sync();
    expect([ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH].map((s) => r.slot(s).classList.contains('is-hidden'))).toEqual([true, true, true]);
    expect(r.slot(ClusterSlot.BIG).classList.contains('is-hidden')).toBe(false);
    r.st.mode = ClusterMode.DEFENCE;
    cluster.sync(1);
    r.ov.sync();
    expect([ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH].map((s) => r.slot(s).classList.contains('is-hidden'))).toEqual([false, false, false]);
  });
});

describe('TCH-09 write-on-change', () => {
  it('sync() with nothing changed writes nothing; a change writes only what changed', () => {
    const r = rig();
    r.ov.sync();
    const w0 = r.ov.domWrites;
    for (let i = 0; i < 10; i++) r.ov.sync();
    expect(r.ov.domWrites).toBe(w0);
    r.st.held = 1 << TouchButtonId.PASS;
    r.ov.sync();
    expect(r.ov.domWrites - w0).toBe(1); // one class toggle
    const w1 = r.ov.domWrites;
    r.ov.sync();
    expect(r.ov.domWrites).toBe(w1);
  });

  it('a held stick that does not move writes nothing per frame', () => {
    const r = rig();
    r.st.stickActive = true;
    r.st.stickOriginX = 200; r.st.stickOriginY = 500; r.st.stickThumbX = 240; r.st.stickThumbY = 500;
    r.ov.sync();
    const w = r.ov.domWrites;
    r.ov.sync();
    r.ov.sync();
    expect(r.ov.domWrites).toBe(w);
    r.st.stickThumbX = 250;
    r.ov.sync();
    expect(r.ov.domWrites - w).toBe(1); // knob transform only
  });
});

describe('TCH-09 power ring, stick, preview, hiding', () => {
  it('power ring on the charging button: two rotating half rings (0.25 -> 90/0 deg, 0.75 -> 180/90 deg)', () => {
    const r = rig();
    r.st.held = 1 << TouchButtonId.SHOOT;
    r.st.powerButton = TouchButtonId.SHOOT;
    r.st.power = 0.25;
    r.ov.sync();
    const ring = r.slot(ClusterSlot.HIGH).one('dk-pring');
    expect(ring.classList.contains('is-on')).toBe(true);
    const arcs = ring.all('dk-pring-arc');
    expect(arcs.map((a) => a.style.transform)).toEqual(['rotate(90deg)', 'rotate(0deg)']);
    r.st.power = 0.75;
    r.ov.sync();
    expect(arcs.map((a) => a.style.transform)).toEqual(['rotate(180deg)', 'rotate(90deg)']);
    expect(r.slot(ClusterSlot.LOW).one('dk-pring').classList.contains('is-on')).toBe(false);
    r.st.powerButton = -1;
    r.st.power = 0;
    r.ov.sync();
    expect(ring.classList.contains('is-on')).toBe(false);
  });

  it('powerRingAngles is clamped and continuous', () => {
    const o = { a: 0, b: 0 };
    expect(powerRingAngles(-1, o)).toEqual({ a: 0, b: 0 });
    expect(powerRingAngles(0.5, o)).toEqual({ a: 180, b: 0 });
    expect(powerRingAngles(1, o)).toEqual({ a: 180, b: 180 });
    expect(powerRingAngles(Number.NaN, o)).toEqual({ a: 0, b: 0 });
    expect(powerRingAngles(9, o)).toEqual({ a: 180, b: 180 });
  });

  it('floating stick: shown at the origin while active, thumb clamped to the rim, hidden on release', () => {
    const r = rig();
    const stick = r.layer().one('dk-stick');
    expect(stick.classList.contains('is-active')).toBe(false);
    r.st.stickActive = true;
    r.st.stickOriginX = 200; r.st.stickOriginY = 500; r.st.stickThumbX = 500; r.st.stickThumbY = 500;
    r.ov.sync();
    expect(stick.classList.contains('is-active')).toBe(true);
    const R = T_TOUCHUI.stickRadius;
    expect(stick.one('dk-stick-base').style.transform).toBe(`translate3d(${200 - R}px, ${500 - R}px, 0)`);
    expect(stick.one('dk-stick-knob').style.transform).toBe(`translate3d(${200 + R - 28}px, ${500 - 28}px, 0)`);
    r.st.stickActive = false;
    r.ov.sync();
    expect(stick.classList.contains('is-active')).toBe(false);
  });

  it('fixed stick: the ring sits at the fixed origin while idle, scaled with the editor size', () => {
    const r = rig();
    const cfg = computeStickConfig(W, H, NO_SAFE, { floatingStick: false, mirror: false, layout: { stick: { dx: 180, dy: 170, scale: 1.2 } } }, createStickConfig());
    r.ov.bind({ stickConfig: cfg });
    r.ov.sync();
    const stick = r.layer().one('dk-stick');
    expect(stick.classList.contains('is-fixed')).toBe(true);
    expect(stick.classList.contains('is-active')).toBe(false);
    const base = stick.one('dk-stick-base');
    expect(base.style.width).toBe(`${cfg.radius * 2}px`);
    expect(base.style.transform).toBe(`translate3d(${cfg.fixedX - cfg.radius}px, ${cfg.fixedY - cfg.radius}px, 0)`);
  });

  it('set-piece preview: one dot per point up to PREVIEW_DOTS, spread over longer paths, cleared with count 0', () => {
    const r = rig();
    const dots = r.layer().all('dk-dot');
    r.st.previewCount = 5;
    for (let i = 0; i < 5; i++) { r.st.previewX[i] = 100 + i * 10; r.st.previewY[i] = 300; }
    r.ov.sync();
    expect(dots.filter((d) => d.classList.contains('is-on'))).toHaveLength(5);
    expect(dots[4]!.style.transform).toBe('translate3d(140px, 300px, 0)');
    r.st.previewCount = 60;
    for (let i = 0; i < 60; i++) { r.st.previewX[i] = i; r.st.previewY[i] = 2 * i; }
    r.ov.sync();
    expect(dots.filter((d) => d.classList.contains('is-on'))).toHaveLength(PREVIEW_DOTS);
    expect(dots[PREVIEW_DOTS - 1]!.style.transform).toBe('translate3d(59px, 118px, 0)');
    r.st.previewCount = 0;
    r.ov.sync();
    expect(dots.filter((d) => d.classList.contains('is-on'))).toHaveLength(0);
  });

  it('hiddenByPad fades the controls out; clearing it (the next touch) brings them back', () => {
    const r = rig();
    r.st.hiddenByPad = true;
    r.ov.sync();
    expect(r.layer().classList.contains('is-pad-hidden')).toBe(true);
    r.st.hiddenByPad = false;
    r.ov.sync();
    expect(r.layer().classList.contains('is-pad-hidden')).toBe(false);
  });

  it('setOpacity clamps to 0.2..1 through a CSS variable on the visual layer', () => {
    const r = rig();
    const vis = r.layer().one('dk-touch-vis');
    r.ov.setOpacity(0.05);
    expect(vis.style.getPropertyValue('--dk-touch-opacity')).toBe('0.2');
    r.ov.setOpacity(0.6);
    expect(vis.style.getPropertyValue('--dk-touch-opacity')).toBe('0.6');
  });

  it('Gestures Only without a cluster bound hides PASS, THROUGH and SHOOT from the settings', () => {
    const r = rig({ gesturesOnly: true });
    expect([ClusterSlot.BIG, ClusterSlot.LOW, ClusterSlot.MID, ClusterSlot.HIGH].map((s) => r.slot(s).classList.contains('is-hidden')))
      .toEqual([false, true, true, true]);
  });

  it('hint fallback (no cluster): arrows after a 250 ms hold while hintMatchesLeft > 0', () => {
    const r = rig({ hintMatchesLeft: 2 });
    r.st.held = 1 << TouchButtonId.SHOOT;
    r.st.downAt[TouchButtonId.SHOOT] = 10_000 - T_TOUCHUI.hintHoldMs - 1;
    r.ov.sync();
    const on = r.slot(ClusterSlot.HIGH).all('dk-hint').filter((h) => h.classList.contains('is-on')).map((h) => h.one('dk-hint-text').textContent);
    expect(on).toEqual(['Chip', 'Finesse', 'Fake shot', 'Power shot']);
    const r2 = rig({ hintMatchesLeft: 0 });
    r2.st.held = 1 << TouchButtonId.SHOOT;
    r2.st.downAt[TouchButtonId.SHOOT] = 1;
    r2.ov.sync();
    expect(r2.slot(ClusterSlot.HIGH).all('dk-hint').some((h) => h.classList.contains('is-on'))).toBe(false);
  });
});

describe('TCH-09 pure helpers', () => {
  it('captions and hint direction masks', () => {
    expect(slotCaption(TouchButtonId.SPRINT_SKILL, ClusterMode.ATTACK)).toBe('& SKILL');
    expect(slotCaption(TouchButtonId.SPRINT_TACKLE, ClusterMode.DEFENCE)).toBe('& SPRINT');
    expect(slotCaption(TouchButtonId.PASS, ClusterMode.ATTACK)).toBe('');
    expect(hintDirMask(TouchButtonId.THROUGH, ClusterMode.ATTACK)).toBe((1 << 1) | (1 << 2));
    expect(hintDirMask(TouchButtonId.SECOND_DEF, ClusterMode.DEFENCE)).toBe(1 << 2);
    expect(hintDirMask(TouchButtonId.PASS, ClusterMode.KEEPER)).toBe(0);
  });

  it('rect distance and circle clearance', () => {
    const rc = { x: 10, y: 10, w: 20, h: 10 };
    expect(rectDistance(rc, 15, 15)).toBe(0);
    expect(rectDistance(rc, 0, 15)).toBe(10);
    expect(circleClearOfRect(0, 15, 9, rc)).toBe(true);
    expect(circleClearOfRect(0, 15, 11, rc)).toBe(false);
  });
});

describe('TCH-09 layout inside the safe area and off the HUD at 4:3, 16:10 and 21:9', () => {
  const VIEWPORTS: [string, number, number][] = [
    ['4:3 (1024x768)', 1024, 768], ['4:3 (1366x1024)', 1366, 1024], ['16:10 iPad (1180x820)', 1180, 820],
    ['16:10 (1194x834)', 1194, 834], ['21:9 (1680x720)', 1680, 720], ['21:9 (1260x540)', 1260, 540],
  ];
  const SAFES = [NO_SAFE, { top: 24, right: 20, bottom: 20, left: 20 }, { top: 0, right: 44, bottom: 21, left: 44 }];
  for (const [name, w, h] of VIEWPORTS) {
    it(name, () => {
      for (const safe of SAFES) {
        for (const spacing of [1, 2]) {
          const l = computeClusterLayout(w, h, safe, { spacing });
          expect(layoutClearOfHud(l, w, h, safe), `${name} ${JSON.stringify(safe)} spacing=${spacing}`).toBe(true);
          // Mirrored (left-handed): the cluster moves bottom left and stays inside the safe area, off the HUD.
          const m = computeClusterLayout(w, h, safe, { spacing, mirror: true });
          const clusterOnly = { slots: m.slots, pause: l.pause };
          expect(layoutClearOfHud(clusterOnly, w, h, safe), `${name} ${JSON.stringify(safe)} mirrored spacing=${spacing}`).toBe(true);
        }
        // The fixed stick's default spot is clear of the HUD too.
        const cfg = computeStickConfig(w, h, safe, { floatingStick: false, mirror: false, layout: {} });
        for (const rc of hudRegions(w, h, safe)) expect(circleClearOfRect(cfg.fixedX, cfg.fixedY, cfg.radius, rc)).toBe(true);
      }
    });
  }
});

// TCH-03 computeClusterLayout used to mirror the pause button to the top left, onto the scoreboard; INT-B applied the
// TCH-09 CR (keep the pause top right when mirrored). The overlay draws the pause where its hit area is.
it('mirrored layout: the pause button stays top right, clear of the scoreboard', () => {
  for (const [w, h] of [[1024, 768], [1180, 820], [1260, 540]] as [number, number][]) {
    for (const safe of [NO_SAFE, { top: 24, right: 20, bottom: 20, left: 20 }, { top: 0, right: 44, bottom: 21, left: 44 }]) {
      const n = computeClusterLayout(w, h, safe);
      const m = computeClusterLayout(w, h, safe, { mirror: true });
      expect(m.pause).toEqual(n.pause);
      expect(m.pause.cx).toBeGreaterThan(w / 2);
      expect(layoutClearOfHud(m, w, h, safe), `${w}x${h} ${JSON.stringify(safe)}`).toBe(true);
    }
  }
});

describe('TCH-09 createPadDriveWatcher (touch controls hide while a controller drives that side)', () => {
  function pads(): { list: Record<string, { connected: boolean; lastInputMs: number }>; find(k: string): { connected: boolean; lastInputMs: number } | null } {
    const list: Record<string, { connected: boolean; lastInputMs: number }> = {
      'pad:1': { connected: true, lastInputMs: 500 },
      'pad:2': { connected: true, lastInputMs: 500 },
    };
    return { list, find: (k) => list[k] ?? null };
  }

  it('fresh input on a pad bound to the same human hides; input seen before the first update never does', () => {
    const st = createTouchIntentState();
    const p = pads();
    const w = createPadDriveWatcher(st, p, () => ['pad:1']);
    w.update();
    expect(st.hiddenByPad).toBe(false);
    p.list['pad:1']!.lastInputMs = 900;
    w.update();
    expect(st.hiddenByPad).toBe(true);
    st.hiddenByPad = false; // the next screen touch (index.ts onDown)
    w.update();
    expect(st.hiddenByPad).toBe(false);
  });

  it("another human's pad and a disconnected pad never hide this side's controls", () => {
    const st = createTouchIntentState();
    const p = pads();
    const w = createPadDriveWatcher(st, p, () => ['pad:1']);
    w.update();
    p.list['pad:2']!.lastInputMs = 2000;
    w.update();
    expect(st.hiddenByPad).toBe(false);
    p.list['pad:1']!.connected = false;
    p.list['pad:1']!.lastInputMs = 3000;
    w.update();
    expect(st.hiddenByPad).toBe(false);
  });
});
