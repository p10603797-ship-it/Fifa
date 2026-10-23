/**
 * [QF-7R] The radar's marks are pre-rendered sprites stamped at whole device pixels (src/ui/hud/radar.ts): a redraw
 * passes only integers to the canvas (a fractional number passed to a canvas method is a heap allocation in the
 * browser), and each mark still lands where pitchToRadar puts it (within half a device pixel), with the same look:
 * dots of RADAR_TUNING.dotR in the team colours, away squares with colour-blind markers, the controlled player's ring,
 * the ball on top. Drawn on the DOM stand-in tests/unit/qf-7r-fake-dom.ts, whose canvas contexts log their calls.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext, FrameInfo } from '../../src/contracts/app';
import { ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { initMatch } from '../../src/sim/init';
import { createRadar, pitchToRadar, radarCanvasSize, radarLayout, RADAR_TUNING } from '../../src/ui/hud/radar';
import { installFakeDom, type CanvasCall, type FakeDom, type FakeElement } from './qf-7r-fake-dom';

let dom: FakeDom | null = null;
afterEach(() => {
  dom?.uninstall();
  dom = null;
});

function setup(colourBlind = false) {
  dom = installFakeDom({ record: true });
  const settings = createSettingsStore(createMemoryStorage());
  if (colourBlind) settings.update((s) => { s.accessibility.colourBlindMarkers = true; });
  const ctx = { settings, session: { getSetup: () => null }, devices: { list: () => [], lastActive: () => null }, platform: { isTouch: false } } as unknown as AppContext;
  const radar = createRadar();
  radar.mount(dom.root as unknown as HTMLElement, ctx);
  const s = initMatch(createMatchConfig());
  s.match.phase = MatchPhase.IN_PLAY;
  // Fractional positions everywhere (the case that boxed numbers): players spread over the pitch, the ball off-centre.
  for (let i = 0; i < s.players.length; i++) {
    s.players[i]!.x = -47.3 + i * 4.417;
    s.players[i]!.z = -29.1 + ((i * 7.31) % 57.9);
  }
  s.ball.x = 12.345;
  s.ball.z = -6.789;
  radar.setMatch(s, CLUBS);
  radar.setVisible(true);
  const canvas = dom.canvases[0]!;
  const g = canvas.getContext('2d')!;
  const frame: FrameInfo = { nowMs: 0, dtMs: 1000 / 60, frame: 1, ticks: 1, paused: false };
  g.calls.length = 0;
  s.tick = 1;
  radar.update(s, frame, null);
  const redraw = (): void => {
    s.tick++;
    frame.frame++;
    frame.dtMs = RADAR_TUNING.redrawMs;
    radar.update(s, frame, null);
  };
  return { s, canvas, calls: g.calls.slice(), dom, redraw, g };
}

const nums = (c: CanvasCall): number[] => c.args.filter((a): a is number => typeof a === 'number');

describe('QF-7R radar: integer-only redraw of pre-rendered marks', () => {
  it('a redraw passes only integers to the canvas and stamps every mark where pitchToRadar puts it', () => {
    const { s, canvas, calls, dom: d } = setup();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) for (const n of nums(c)) expect(Number.isInteger(n), `${c.name}(${c.args.join(', ')})`).toBe(true);
    // Layout as the radar computes it: CSS size for HUD scale 1 at the stand-in's 820 px viewport, DPR 2 (cap 2).
    const size = radarCanvasSize(1, 820, { w: 0, h: 0 });
    const dpr = 2;
    expect(canvas.width).toBe(Math.round(size.w * dpr));
    const L = radarLayout(size.w, size.h, (RADAR_TUNING.pad * size.w) / RADAR_TUNING.width);
    const stamps = calls.filter((c) => c.name === 'drawImage').slice(1); // [0] is the pitch layer
    const active = s.players.filter((p) => p.active === 1);
    const humans = s.ctrl.filter((c) => c.kind === ControllerKind.HUMAN && c.slot >= 0).length;
    expect(stamps.length).toBe(active.length + humans + 1);
    const pt = { x: 0, y: 0 };
    const centre = (c: CanvasCall): [number, number] => {
      const sprite = c.args[0] as FakeElement;
      return [(c.args[1] as number) + sprite.width / 2, (c.args[2] as number) + sprite.height / 2];
    };
    let k = 0;
    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i]!;
      if (p.active !== 1) continue;
      pitchToRadar(L, p.x, p.z, pt);
      const [cx, cy] = centre(stamps[k++]!);
      expect(Math.abs(cx - pt.x * dpr), `player ${i} x`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(cy - pt.y * dpr), `player ${i} y`).toBeLessThanOrEqual(0.5);
    }
    k += humans;
    pitchToRadar(L, s.ball.x, s.ball.z, pt);
    const [bx, by] = centre(stamps[k]!);
    expect(Math.abs(bx - pt.x * dpr)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(by - pt.y * dpr)).toBeLessThanOrEqual(0.5);
    // The sprites draw the tuned marks: dot radius, home and away colours, the ball white and last.
    const spriteOf = (c: CanvasCall): FakeElement => c.args[0] as FakeElement;
    const homeSprite = spriteOf(stamps[0]!);
    const awayIdx = s.players.filter((p) => p.active === 1).findIndex((p) => p.team === 1);
    const awaySprite = spriteOf(stamps[awayIdx]!);
    expect(homeSprite).not.toBe(awaySprite);
    const arcs = (el: FakeElement): CanvasCall[] => el.getContext('2d')!.calls.filter((c) => c.name === 'arc');
    expect(arcs(homeSprite)[0]!.args[2]).toBeCloseTo(RADAR_TUNING.dotR * (size.w / RADAR_TUNING.width), 9);
    expect(arcs(spriteOf(stamps[k]!))[0]!.args[2]).toBeCloseTo(RADAR_TUNING.ballR * (size.w / RADAR_TUNING.width), 9);
    expect(spriteOf(stamps[k]!).getContext('2d')!.fillStyle).toBe('#ffffff');
    // A sprite is big enough for its mark and outline.
    for (const sp of [homeSprite, awaySprite]) expect(sp.width).toBeGreaterThanOrEqual(2 * (RADAR_TUNING.dotR + 1) * dpr);
    expect(d.canvases.length).toBeGreaterThanOrEqual(2 + 6);
  });

  it('colour-blind markers stamp the away side as squares; sprites are reused across redraws', () => {
    const { s, calls, dom: d, redraw, g } = setup(true);
    const stamps = calls.filter((c) => c.name === 'drawImage').slice(1);
    const awayIdx = s.players.filter((p) => p.active === 1).findIndex((p) => p.team === 1);
    const away = stamps[awayIdx]!.args[0] as FakeElement;
    const sc = away.getContext('2d')!.calls;
    expect(sc.some((c) => c.name === 'fillRect')).toBe(true);
    expect(sc.some((c) => c.name === 'arc')).toBe(false);
    const before = d.canvases.length;
    const builds = sc.length;
    // Later redraws stamp again and rebuild nothing.
    g.calls.length = 0;
    redraw();
    redraw();
    expect(g.calls.filter((c) => c.name === 'drawImage').length).toBe(2 * (stamps.length + 1));
    expect(d.canvases.length).toBe(before);
    expect(away.getContext('2d')!.calls.length).toBe(builds);
  });
});
