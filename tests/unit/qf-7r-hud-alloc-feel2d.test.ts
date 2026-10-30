/**
 * [FEEL-2D] Regressions behind tests/unit/qf-7r-hud-alloc.test.ts failing after FEEL-2 / FEEL-2C ("everything but the
 * power bar while charging: expected 49 to be less than 40", and the power bar at 118 B per charging frame). FEEL-2
 * changed the match flow of the probe's charging window: the human's first throw-in of the match now falls inside the
 * measured window (a set-piece hint card and its settings write), the human's player switches 14 times instead of 11,
 * and he moves on most charging frames. The paths were warm (the probe replays the same match first); what they
 * allocated was real:
 *  1. radar.ts re-resolved its colours and rebuilt all six mark sprites on every settings write (its subscription),
 *     even one that changes no colour (the hint's use count): ~80 allocations and six canvases redrawn per write.
 *  2. powerBar.ts built a `translate3d(...)` string on every frame the bar moved (most charging frames: the charging
 *     player runs).
 *  3. playerInfo.ts rebuilt the name and the aria-label strings on every switch, back to a known player included.
 *  4. hints.ts rebuilt a set-piece card (~125 allocations) on every use of its restart kind.
 * Each test pins the fixed behaviour (content unchanged, the allocation gone); the probe pins the allocation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AppContext, FrameInfo, HudPart } from '../../src/contracts/app';
import { ControllerKind, MatchPhase, PadFamily, RestartKind } from '../../src/contracts/enums';
import type { CameraProjector } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { initMatch } from '../../src/sim/init';
import { createHints, setPieceCardKey } from '../../src/ui/hud/hints';
import { createPlayerInfo } from '../../src/ui/hud/playerInfo';
import { POWER_BAR_TUNING, createPowerBar, powerBarPosition, pxStr } from '../../src/ui/hud/powerBar';
import { createRadar, RADAR_TUNING } from '../../src/ui/hud/radar';
import { installFakeDom, type FakeDom, type FakeElement } from './qf-7r-fake-dom';

let dom: FakeDom | null = null;
afterEach(() => {
  dom?.uninstall();
  dom = null;
});

type Node = Omit<FakeElement, 'childNodes'> & {
  childNodes: Node[]; style: Record<string, unknown>; textContent: string; classList: { contains(c: string): boolean };
};

function byTestId(root: Node, id: string): Node | null {
  if (root.dataset?.testid === id) return root;
  for (const c of root.childNodes ?? []) {
    const f = byTestId(c, id);
    if (f) return f;
  }
  return null;
}

function mount<T extends HudPart>(part: T) {
  dom = installFakeDom({ record: true });
  const settings = createSettingsStore(createMemoryStorage());
  const ctx = {
    settings, session: { getSetup: () => null }, devices: { list: () => [], lastActive: () => null }, platform: { isTouch: false },
  } as unknown as AppContext;
  part.mount(dom.root as unknown as HTMLElement, ctx);
  return { part, settings, root: dom.root as unknown as Node, dom };
}

/** A fresh match with human 1 controlling a player of his side (the slot is assigned on the first sim step). */
function match(cfg = createMatchConfig()): SimState {
  const s = initMatch(cfg) as SimState;
  const c = s.ctrl[0]!;
  c.slot = s.players.findIndex((p) => p.team === c.side && p.active === 1);
  return s;
}

const frame = (): FrameInfo => ({ nowMs: 0, dtMs: 1000 / 60, frame: 1, ticks: 1, paused: false });

describe('[FEEL-2D] HUD event-time allocation', () => {
  it('radar: a settings write that changes no colour rebuilds no sprite; a high-contrast toggle still re-colours', () => {
    const { part: radar, settings, dom: d } = mount(createRadar());
    const s = initMatch(createMatchConfig());
    s.match.phase = MatchPhase.IN_PLAY;
    radar.setMatch(s, CLUBS);
    radar.setVisible(true);
    const f = frame();
    const redraw = (): void => {
      s.tick++;
      f.dtMs = RADAR_TUNING.redrawMs;
      radar.update(s, f, null);
    };
    redraw();
    // canvases[0] is the radar, [1] its pitch layer, the rest the mark sprites.
    const sprites = d.canvases.slice(2);
    expect(sprites.length).toBe(6);
    const spriteCalls = (): number => sprites.reduce((n, c) => n + c.getContext('2d')!.calls.length, 0);
    const before = spriteCalls();
    expect(before).toBeGreaterThan(0);
    settings.update((st) => {
      (st.setPieceHintsSeen ??= {})[String(RestartKind.THROW_IN)] = 1;
    });
    redraw();
    expect(spriteCalls(), 'an unrelated settings write (a hint use count) rebuilt the sprites').toBe(before);
    settings.update((st) => {
      st.accessibility.highContrastKits = true;
    });
    redraw();
    expect(spriteCalls(), 'high-contrast kits re-colour the dots').toBeGreaterThan(before);
  });

  it('power bar: positioned by cached whole-pixel --pbx / --pby strings, written only when they change', () => {
    const { part: bar, root } = mount(createPowerBar());
    const pb = byTestId(root, 'pb-p1')!;
    const writes: [string, string][] = [];
    pb.style.setProperty = (k: string, v: string): void => { writes.push([k, v]); };
    const s = match();
    bar.setMatch(s, CLUBS);
    const c = s.ctrl[0]!;
    expect(c.kind).toBe(ControllerKind.HUMAN);
    c.powerBtn = 1;
    c.power = 0.5;
    const p = s.players[c.slot]!;
    p.x = 3.37;
    p.z = -2.11;
    const projector = {
      pitchToScreen(x: number, y: number, z: number, out: { x: number; y: number }): boolean { out.x = 590 + x * 9; out.y = 410 + z * 5 - y * 9; return true; },
    } as unknown as CameraProjector;
    const f = frame();
    bar.update(s, f, projector);
    const T = POWER_BAR_TUNING;
    const ax = 590 + p.x * 9;
    const ay = 410 + p.z * 5 - T.anchorY * 9;
    const marker = Math.min(T.markerMaxPx, Math.max(T.markerMinPx, T.markerWorld * 9));
    const want = powerBarPosition(ax, ay, 1180, 820, T.width, T.height, marker + T.lift, T.edge, { x: 0, y: 0 });
    expect(writes).toEqual([['--pbx', `${want.x}px`], ['--pby', `${want.y}px`]]);
    expect(pb.style.transform, 'no per-move transform string').toBe('');
    expect(pb.classList.contains('is-on')).toBe(true);
    // Same whole pixel: nothing written. One pixel right: only --pbx.
    writes.length = 0;
    p.x += 0.01;
    bar.update(s, f, projector);
    expect(writes).toEqual([]);
    p.x += 1 / 9;
    bar.update(s, f, projector);
    expect(writes).toEqual([['--pbx', `${want.x + 1}px`]]);
    expect(pxStr(want.x + 1)).toBe(`${want.x + 1}px`);
    expect(pxStr(-3)).toBe('-3px');
    expect(pxStr(9000)).toBe('9000px');
  });

  it('player panel: the cached name and aria-label follow switches and a new match\'s squads', () => {
    const { part: info, root } = mount(createPlayerInfo());
    const panel = byTestId(root, 'pi-p1')!;
    const nameEl = byTestId(root, 'pi-p1-name')!;
    const check = (s: SimState): void => {
      const p = s.players[s.ctrl[0]!.slot]!;
      const d = s.squads[p.team]![p.rosterIdx]!;
      const nm = (d.short || d.name).toUpperCase();
      expect(nameEl.textContent).toBe(nm);
      expect(panel.getAttribute('aria-label')).toBe(`Player 1: ${d.shirt} ${nm}`);
    };
    const s = match();
    info.setMatch(s, CLUBS);
    const f = frame();
    const a = s.ctrl[0]!.slot;
    const b = s.players.findIndex((p, i) => i !== a && p.team === s.players[a]!.team && p.active === 1);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    for (const slot of [a, b, a, b]) {
      s.ctrl[0]!.slot = slot;
      info.update(s, f, null);
      check(s);
    }
    // A new match with other clubs: the cache is per match, so the names are the new squad's.
    const cfg = createMatchConfig();
    cfg.homeClub = (s.teams[0]!.clubIdx + 3) % CLUBS.length;
    cfg.awayClub = (s.teams[1]!.clubIdx + 5) % CLUBS.length;
    const s2 = match(cfg);
    expect(s2.squads[0]![0]!.name).not.toBe(s.squads[0]![0]!.name);
    info.setMatch(s2, CLUBS);
    s2.ctrl[0]!.slot = a;
    info.update(s2, f, null);
    check(s2);
  });

  it('set-piece card: the next use of a restart reuses the card\'s nodes, with the same content', () => {
    const { part: hints, root, settings } = mount(createHints());
    const card = byTestId(root, 'hud-hint')!;
    const s = match();
    hints.setMatch(s, CLUBS);
    hints.setVisible(true);
    const f = frame();
    const throwIn = (): Node[] => {
      s.match.phase = MatchPhase.IN_PLAY;
      hints.update(s, f, null);
      s.match.phase = MatchPhase.THROW_IN;
      s.match.restart.team = s.ctrl[0]!.side;
      hints.update(s, f, null);
      expect(card.classList.contains('is-on')).toBe(true);
      expect(card.dataset.kind).toBe('setpiece');
      expect(card.getAttribute('aria-label')).toBe('SET PIECE Throw-in');
      expect(byTestId(card, 'hint-title')!.textContent).toBe('Throw-in');
      return card.childNodes.slice();
    };
    const first = throwIn();
    const second = throwIn();
    expect(settings.get().setPieceHintsSeen?.[String(RestartKind.THROW_IN)]).toBe(2);
    expect(second.length).toBe(first.length);
    for (let i = 0; i < first.length; i++) expect(second[i], 'the card was built again').toBe(first[i]);
    // Different devices, tags and content keys never share a card.
    const keys = new Set<number>();
    for (const k of [1000 + RestartKind.THROW_IN * 10, 1000 + RestartKind.PENALTY * 10, 1000 + RestartKind.PENALTY * 10 + 1]) {
      for (const dev of [{ kind: 'touch', family: PadFamily.GENERIC }, { kind: 'keyboard', family: PadFamily.GENERIC },
        { kind: 'pad', family: PadFamily.XBOX }, { kind: 'pad', family: PadFamily.PLAYSTATION }] as const) {
        for (const who of [0, 1, 2]) keys.add(setPieceCardKey(k, dev, who));
      }
    }
    expect(keys.size).toBe(3 * 4 * 3);
  });
});
