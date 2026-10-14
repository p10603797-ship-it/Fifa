/**
 * UIX-04 unit tests: the side assignment model (src/ui/screens/sideAssign.ts) and the per-pad step reader
 * (sideSelect.ts padStep): lanes, max two humans, P1 / P2 by assignment order, disconnects, bindings and
 * MatchConfig.humans, restore on Back, defaults per mode, readiness, D-pad / stick edges.
 */
import { describe, expect, it } from 'vitest';
import type { DeviceInfo, MatchSetup } from '../../src/contracts/app';
import { AssistLevel, AutoSwitch, ControllerKind, ModeId, PadFamily } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig } from '../../src/contracts/state';
import { PadButton } from '../../src/input/pad/manager';
import { MENU_STICK_RELEASE, MENU_STICK_THRESHOLD } from '../../src/input/menuInput';
import {
  applyAssignment, assignment, buildBindings, createSideModel, defaultLanes, findToken, humanIndexOf, moveToken, players,
  primaryDevice, readiness, restoreFromSetup, setLane, sideHasHuman, syncDevices,
} from '../../src/ui/screens/sideAssign';
import { padStep } from '../../src/ui/screens/sideSelect';

const dev = (id: string, kind: DeviceInfo['kind'], label = id, connected = true): DeviceInfo => ({ id, kind, label, family: PadFamily.GENERIC, connected });
const TOUCH = dev('touch', 'touch', 'Touch');
const PAD1 = dev('pad:1', 'pad', 'Controller 1');
const PAD2 = dev('pad:2', 'pad', 'Controller 2');
const KEYS = dev('keyboard', 'keyboard', 'Keyboard');

function model(...devices: DeviceInfo[]) {
  const m = createSideModel();
  syncDevices(m, devices, 0);
  return m;
}

function setupWithNoHumans(): MatchSetup {
  const config = createMatchConfig();
  config.humans[0] = { kind: ControllerKind.NONE, side: -1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 };
  return { config, bindings: [] };
}

describe('UIX-04 side assignment model', () => {
  it('lists every device as a token in the centre, in registry order, and follows the list', () => {
    const m = model(TOUCH, PAD1, KEYS);
    expect(m.tokens.map((t) => [t.id, t.lane])).toEqual([['touch', 0], ['pad:1', 0], ['keyboard', 0]]);
    // A pad appears (pressed) between: order follows the registry; existing lanes stay.
    setLane(m, 'touch', -1);
    expect(syncDevices(m, [TOUCH, PAD1, PAD2, KEYS], 5)).toBe(true);
    expect(m.tokens.map((t) => t.id)).toEqual(['touch', 'pad:1', 'pad:2', 'keyboard']);
    expect(findToken(m, 'pad:2')!.addedAt).toBe(5);
    expect(findToken(m, 'touch')!.lane).toBe(-1);
    // Same list again: nothing changes.
    expect(syncDevices(m, [TOUCH, PAD1, PAD2, KEYS], 6)).toBe(false);
    // A device that leaves the list is dropped.
    syncDevices(m, [TOUCH, PAD1, KEYS], 7);
    expect(findToken(m, 'pad:2')).toBeNull();
  });

  it('steps lanes with the device\'s own left / right, clamped at the edges', () => {
    const m = model(TOUCH, PAD1);
    expect(moveToken(m, 'pad:1', 1)).toBe('moved');
    expect(findToken(m, 'pad:1')!.lane).toBe(1);
    expect(moveToken(m, 'pad:1', 1)).toBe('edge');
    expect(moveToken(m, 'pad:1', -1)).toBe('moved');
    expect(findToken(m, 'pad:1')!.lane).toBe(0);
    expect(moveToken(m, 'pad:1', -1)).toBe('moved');
    expect(findToken(m, 'pad:1')!.lane).toBe(-1);
    expect(moveToken(m, 'pad:1', -1)).toBe('edge');
    expect(moveToken(m, 'nope', 1)).toBe('unknown');
    expect(moveToken(m, 'touch', 0)).toBe('edge');
  });

  it('allows at most two humans: a third device cannot leave the centre', () => {
    const m = model(TOUCH, PAD1, PAD2, KEYS);
    expect(setLane(m, 'touch', -1)).toBe('moved');
    expect(setLane(m, 'pad:1', 1)).toBe('moved');
    expect(moveToken(m, 'pad:2', 1)).toBe('blocked-max');
    expect(moveToken(m, 'keyboard', -1)).toBe('blocked-max');
    expect(findToken(m, 'pad:2')!.lane).toBe(0);
    // A human moving between sides is not a third human.
    expect(setLane(m, 'pad:1', -1)).toBe('moved');
    // One back to the centre frees a place.
    expect(moveToken(m, 'touch', 1)).toBe('moved');
    expect(moveToken(m, 'pad:2', 1)).toBe('moved');
  });

  it('numbers players by assignment order: P1 = first assigned; the centre gives the number up', () => {
    const m = model(TOUCH, PAD1, PAD2);
    setLane(m, 'pad:2', 1);
    setLane(m, 'touch', -1);
    expect(humanIndexOf(m, 'pad:2')).toBe(0);
    expect(humanIndexOf(m, 'touch')).toBe(1);
    expect(humanIndexOf(m, 'pad:1')).toBe(-1);
    // P1 to the centre: the other player becomes P1; coming back makes it P2.
    moveToken(m, 'pad:2', -1);
    expect(humanIndexOf(m, 'touch')).toBe(0);
    moveToken(m, 'pad:2', 1);
    expect(humanIndexOf(m, 'pad:2')).toBe(1);
    // A drag straight across (side to side) keeps the number.
    setLane(m, 'touch', 1);
    expect(humanIndexOf(m, 'touch')).toBe(0);
    expect(players(m).map((t) => t.id)).toEqual(['touch', 'pad:2']);
  });

  it('touch is a single token: it is never on both sides', () => {
    const m = model(TOUCH, PAD1);
    setLane(m, 'touch', -1);
    setLane(m, 'touch', 1);
    expect(m.tokens.filter((t) => t.id === 'touch')).toHaveLength(1);
    expect(assignment(m).filter((a) => a.deviceIds.includes('touch'))).toHaveLength(1);
  });

  it('allows two humans on the same side (co-op v CPU)', () => {
    const m = model(PAD1, PAD2);
    setLane(m, 'pad:1', -1);
    expect(setLane(m, 'pad:2', -1)).toBe('moved');
    expect(sideHasHuman(m, 0)).toBe(true);
    expect(sideHasHuman(m, 1)).toBe(false);
    const r = readiness(m, ModeId.KICK_OFF);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/together/);
  });

  it('a disconnected device returns to the centre and cannot move until it reconnects', () => {
    const m = model(TOUCH, PAD1);
    setLane(m, 'pad:1', 1);
    syncDevices(m, [TOUCH, { ...PAD1, connected: false }], 1);
    const t = findToken(m, 'pad:1')!;
    expect(t.lane).toBe(0);
    expect(t.connected).toBe(false);
    expect(moveToken(m, 'pad:1', 1)).toBe('blocked-disconnected');
    syncDevices(m, [TOUCH, PAD1], 2);
    expect(moveToken(m, 'pad:1', 1)).toBe('moved');
  });

  it('builds HumanBinding[] and MatchConfig.humans (side, assist and auto-switch from settings)', () => {
    const settings = createDefaultSettings();
    settings.controls.assist = AssistLevel.MANUAL;
    settings.controls.autoSwitch = AutoSwitch.AUTO;
    const m = model(TOUCH, PAD1, KEYS);
    setLane(m, 'pad:1', 1);
    setLane(m, 'touch', -1);
    const setup = setupWithNoHumans();
    applyAssignment(setup, m, settings);
    expect(setup.bindings).toEqual([{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['touch'] }]);
    expect(setup.config.humans.map((h) => [h.kind, h.side, h.assist, h.autoSwitch])).toEqual([
      [ControllerKind.HUMAN, 1, AssistLevel.MANUAL, AutoSwitch.AUTO],
      [ControllerKind.HUMAN, 0, AssistLevel.MANUAL, AutoSwitch.AUTO],
    ]);
    expect(buildBindings(m)).toEqual(setup.bindings);
    // One human left: human 1 is NONE again.
    setLane(m, 'touch', 0);
    applyAssignment(setup, m, settings);
    expect(setup.bindings).toEqual([{ human: 0, deviceIds: ['pad:1'] }]);
    expect(setup.config.humans[1]!.kind).toBe(ControllerKind.NONE);
    expect(setup.config.humans[1]!.side).toBe(-1);
  });

  it('restores lanes and numbering from a setup (Back to side select)', () => {
    const settings = createDefaultSettings();
    const a = model(TOUCH, PAD1, PAD2);
    setLane(a, 'pad:2', -1);
    setLane(a, 'pad:1', 1);
    const setup = setupWithNoHumans();
    applyAssignment(setup, a, settings);
    const b = model(TOUCH, PAD1, PAD2);
    expect(restoreFromSetup(b, setup)).toBe(true);
    expect(findToken(b, 'pad:2')!.lane).toBe(-1);
    expect(findToken(b, 'pad:1')!.lane).toBe(1);
    expect(humanIndexOf(b, 'pad:2')).toBe(0);
    // Bound device gone: nothing placed.
    const c = model(TOUCH);
    expect(restoreFromSetup(c, setup)).toBe(false);
  });

  it('defaults: the last used device at home; Play a Friend adds a known second controller away', () => {
    const k = model(TOUCH, PAD1, KEYS);
    defaultLanes(k, ModeId.KICK_OFF, 'keyboard');
    expect(findToken(k, 'keyboard')!.lane).toBe(-1);
    expect(assignment(k)).toHaveLength(1);
    const f = model(TOUCH, PAD1, PAD2);
    defaultLanes(f, ModeId.FRIEND_LOCAL, 'pad:2');
    expect(findToken(f, 'pad:2')!.lane).toBe(-1);
    expect(findToken(f, 'pad:1')!.lane).toBe(1);
    // Friend with touch and one pad only: touch is not placed by default (a friend's pad must still be able to join).
    const g = model(TOUCH, PAD1);
    defaultLanes(g, ModeId.FRIEND_LOCAL, 'pad:1');
    expect(findToken(g, 'touch')!.lane).toBe(0);
    // Nothing known: touch, then keyboard, then a pad.
    expect(primaryDevice(model(PAD1, KEYS), null)!.id).toBe('keyboard');
    expect(primaryDevice(model(TOUCH, PAD1, KEYS), null)!.id).toBe('touch');
    expect(primaryDevice(model(PAD1), 'gone')!.id).toBe('pad:1');
  });

  it('readiness: one human for Kick-Off, two for Play a Friend; CPU sides named', () => {
    const m = model(TOUCH, PAD1);
    expect(readiness(m, ModeId.KICK_OFF).ok).toBe(false);
    setLane(m, 'touch', 1);
    expect(readiness(m, ModeId.KICK_OFF)).toEqual({ ok: true, message: 'CPU at home, you away.' });
    expect(readiness(m, ModeId.FRIEND_LOCAL).ok).toBe(false);
    expect(readiness(m, ModeId.FRIEND_LOCAL).message).toMatch(/second player/);
    setLane(m, 'pad:1', -1);
    expect(readiness(m, ModeId.FRIEND_LOCAL)).toEqual({ ok: true, message: 'Player against player.' });
    expect(readiness(m, ModeId.SHOOT_OUT).ok).toBe(true);
  });
});

describe('UIX-04 per-pad step (padStep)', () => {
  const bit = (b: number): number => 1 << b;

  it('D-pad left / right press edges step once; holding does not repeat', () => {
    expect(padStep(bit(PadButton.DPAD_LEFT), 0, 0, 0, 0)).toEqual([-1, 0]);
    expect(padStep(bit(PadButton.DPAD_RIGHT), 0, 0, 0, 0)).toEqual([1, 0]);
    expect(padStep(bit(PadButton.DPAD_RIGHT), bit(PadButton.DPAD_RIGHT), 0, 0, 0)).toEqual([0, 0]);
    expect(padStep(bit(PadButton.SOUTH), 0, 0, 0, 0)).toEqual([0, 0]);
  });

  it('the left stick steps once past the threshold and re-arms only below the release level', () => {
    const over = MENU_STICK_THRESHOLD + 0.05;
    let [step, held] = padStep(0, 0, over, 0, 0);
    expect([step, held]).toEqual([1, 1]);
    // Still held between release and threshold: no step.
    [step, held] = padStep(0, 0, (MENU_STICK_THRESHOLD + MENU_STICK_RELEASE) / 2, 0, held);
    expect([step, held]).toEqual([0, 1]);
    // Released, then pushed again: one more step.
    [step, held] = padStep(0, 0, MENU_STICK_RELEASE - 0.05, 0, held);
    expect([step, held]).toEqual([0, 0]);
    [step, held] = padStep(0, 0, -over, 0, held);
    expect([step, held]).toEqual([-1, -1]);
    // Vertical-dominant deflection is not a side step.
    expect(padStep(0, 0, over, over + 0.1, 0)).toEqual([0, 0]);
  });
});
