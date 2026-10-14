/**
 * [UIX-04] Side assignment model behind the side select screen (BRIEF §11 Side select, same-iPad 1v1, §10 two pads
 * bound by identity). Pure (no DOM); helper file of sideSelect.ts.
 *
 * Each connected input (Touch, Controller 1, Controller 2, ..., Keyboard: DeviceRegistry order) is one token in a
 * lane: -1 home (left), 0 centre (sits out), +1 away (right). Rules:
 *  - At most MAX_HUMANS (2) tokens sit on a side; a third is refused ('blocked-max').
 *  - Players are numbered by assignment order: the token that left the centre first is P1 (ember), the next P2
 *    (cyan). A token back in the centre gives up its number; the other player becomes P1. A drag straight from one
 *    side to the other keeps the number; stepping one lane at a time passes the centre and so gives it up.
 *  - Touch is one token, so touch is never on both sides; two people never share the touch screen (BRIEF §11).
 *  - Two humans on the SAME side are allowed (co-op against the CPU; the sim never lets two controllers of one side
 *    hold the same player). A side with no humans is played by the CPU.
 *  - A disconnected device goes back to the centre and cannot move until it reconnects (a match never starts bound
 *    to a missing pad). Devices that leave the registry list are dropped.
 *  - Ready: at least one human; Play a Friend (same iPad) needs two.
 * The result: HumanBinding[] (one device per human, by device id; pads by identity 'pad:<n>') and
 * MatchConfig.humans (side, assist and auto-switch from settings via modes/setup humanController).
 */
import type { DeviceInfo, HumanBinding, MatchSetup } from '../../contracts/app';
import { MAX_HUMANS } from '../../contracts/constants';
import { ControllerKind, ModeId } from '../../contracts/enums';
import type { Settings } from '../../contracts/settings';
import { humanController } from '../../modes/setup';

export type Lane = -1 | 0 | 1;

export interface Token {
  id: string;
  kind: DeviceInfo['kind'];
  label: string;
  connected: boolean;
  lane: Lane;
  /** Assignment order (0 while in the centre). */
  seq: number;
  /** Caller-supplied time the token was added (e.g. the pad poll stamp; join presses). */
  addedAt: number;
}

export interface SideModel {
  tokens: Token[];
  nextSeq: number;
}

export type MoveResult = 'moved' | 'edge' | 'blocked-max' | 'blocked-disconnected' | 'unknown';

export function createSideModel(): SideModel {
  return { tokens: [], nextSeq: 1 };
}

export function findToken(m: SideModel, id: string): Token | null {
  for (const t of m.tokens) if (t.id === id) return t;
  return null;
}

export function laneSide(lane: Lane): number {
  return lane < 0 ? 0 : lane > 0 ? 1 : -1;
}

export function sideLane(side: number): Lane {
  return side === 0 ? -1 : side === 1 ? 1 : 0;
}

function clampLane(v: number): Lane {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

export function assignedCount(m: SideModel): number {
  let n = 0;
  for (const t of m.tokens) if (t.lane !== 0) n++;
  return n;
}

/**
 * Follow the registry list: add new devices (centre), update labels / connection, drop devices no longer listed.
 * A device that disconnected goes back to the centre. Token order = registry order. Returns true when anything changed.
 */
export function syncDevices(m: SideModel, devices: readonly DeviceInfo[], now = 0): boolean {
  let changed = false;
  const next: Token[] = [];
  for (const d of devices) {
    let t = findToken(m, d.id);
    if (!t) {
      t = { id: d.id, kind: d.kind, label: d.label, connected: d.connected, lane: 0, seq: 0, addedAt: now };
      changed = true;
    } else if (t.label !== d.label || t.connected !== d.connected || t.kind !== d.kind) {
      t.label = d.label;
      t.kind = d.kind;
      t.connected = d.connected;
      changed = true;
    }
    if (!t.connected && t.lane !== 0) {
      t.lane = 0;
      t.seq = 0;
      changed = true;
    }
    if (next.indexOf(t) < 0) next.push(t);
  }
  if (next.length !== m.tokens.length) changed = true;
  else for (let i = 0; i < next.length; i++) if (next[i] !== m.tokens[i]) changed = true;
  m.tokens = next;
  return changed;
}

/** Put a token in a lane (a drag drop). The order number is kept for a side-to-side move. */
export function setLane(m: SideModel, id: string, lane: number): MoveResult {
  const t = findToken(m, id);
  if (!t) return 'unknown';
  const to = clampLane(lane);
  if (to === t.lane) return 'edge';
  if (!t.connected) return 'blocked-disconnected';
  if (to === 0) {
    t.lane = 0;
    t.seq = 0;
    return 'moved';
  }
  if (t.lane === 0) {
    if (assignedCount(m) >= MAX_HUMANS) return 'blocked-max';
    t.seq = m.nextSeq++;
  }
  t.lane = to;
  return 'moved';
}

/** Step a token one lane left (-1) or right (+1): a device's own D-pad / stick / arrow keys, or the touch arrows. */
export function moveToken(m: SideModel, id: string, dir: number): MoveResult {
  const t = findToken(m, id);
  if (!t) return 'unknown';
  const to = t.lane + (dir < 0 ? -1 : dir > 0 ? 1 : 0);
  if (to < -1 || to > 1 || dir === 0) return 'edge';
  return setLane(m, id, to);
}

/** Tokens on a side, in player order (index = human index). */
export function players(m: SideModel): Token[] {
  return m.tokens.filter((t) => t.lane !== 0).sort((a, b) => a.seq - b.seq);
}

/** Human index of a token (0 = P1, 1 = P2), -1 in the centre. */
export function humanIndexOf(m: SideModel, id: string): number {
  const p = players(m);
  for (let i = 0; i < p.length; i++) if (p[i]!.id === id) return i;
  return -1;
}

export function sideHasHuman(m: SideModel, side: number): boolean {
  for (const t of m.tokens) if (t.lane !== 0 && laneSide(t.lane) === side) return true;
  return false;
}

export interface Assignment {
  human: number;
  side: number;
  deviceIds: string[];
}

/** The assignment as KickOffChoices.humans: human index, side and devices. */
export function assignment(m: SideModel): Assignment[] {
  return players(m).map((t, i) => ({ human: i, side: laneSide(t.lane), deviceIds: [t.id] }));
}

/** Bindings for the session: one entry per human. */
export function buildBindings(m: SideModel): HumanBinding[] {
  return assignment(m).map((a) => ({ human: a.human, deviceIds: a.deviceIds.slice() }));
}

/** Write config.humans and bindings of a setup from the model (humans past the assigned ones are NONE). */
export function applyAssignment(setup: MatchSetup, m: SideModel, settings: Readonly<Settings>): void {
  const a = assignment(m);
  const humans = setup.config.humans;
  for (let i = 0; i < MAX_HUMANS; i++) {
    const as = a[i];
    if (as) {
      humans[i] = humanController(settings, as.side);
    } else {
      const prev = humans[i];
      humans[i] = {
        kind: ControllerKind.NONE, side: -1,
        assist: prev ? prev.assist : settings.controls.assist,
        autoSwitch: prev ? prev.autoSwitch : settings.controls.autoSwitch,
        fastPower: 0,
      };
    }
  }
  setup.bindings = buildBindings(m);
}

/** Restore lanes from a setup's bindings (Back to this screen). Returns true when at least one token was placed. */
export function restoreFromSetup(m: SideModel, setup: MatchSetup): boolean {
  const order = setup.bindings.slice().sort((a, b) => a.human - b.human);
  let placed = 0;
  for (const b of order) {
    const cfg = setup.config.humans[b.human];
    if (!cfg || cfg.kind !== ControllerKind.HUMAN || (cfg.side !== 0 && cfg.side !== 1)) continue;
    for (const id of b.deviceIds) {
      const t = findToken(m, id);
      if (!t || !t.connected || t.lane !== 0) continue;
      if (setLane(m, id, sideLane(cfg.side)) === 'moved') placed++;
      break;
    }
  }
  return placed > 0;
}

/** The device a single player most likely uses: the last active one, else touch, keyboard, then the first pad. */
export function primaryDevice(m: SideModel, lastActive: string | null): Token | null {
  const live = m.tokens.filter((t) => t.connected);
  const last = lastActive ? live.find((t) => t.id === lastActive) : undefined;
  if (last) return last;
  return live.find((t) => t.kind === 'touch') ?? live.find((t) => t.kind === 'keyboard') ?? live.find((t) => t.kind === 'pad') ?? null;
}

/**
 * Default lanes for a fresh visit: the primary device at home; for Play a Friend also a second device away
 * (a controller first; touch and keyboard otherwise).
 */
export function defaultLanes(m: SideModel, mode: ModeId, lastActive: string | null): void {
  const p = primaryDevice(m, lastActive);
  if (!p) return;
  setLane(m, p.id, -1);
  if (mode !== ModeId.FRIEND_LOCAL) return;
  const rest = m.tokens.filter((t) => t.connected && t !== p);
  const second = rest.find((t) => t.kind === 'pad') ?? rest[0];
  if (second) setLane(m, second.id, 1);
}

/** Humans needed to continue in a mode. */
export function humansNeeded(mode: ModeId): number {
  return mode === ModeId.FRIEND_LOCAL ? 2 : 1;
}

export interface Readiness {
  ok: boolean;
  /** Why not (or a one-line summary when ready). */
  message: string;
}

export function readiness(m: SideModel, mode: ModeId): Readiness {
  const n = assignedCount(m);
  const need = humansNeeded(mode);
  if (n < need) {
    if (need === 2) {
      return {
        ok: false,
        message: n === 0 ? 'Slide two inputs to the sides to play a friend.' : 'Play a Friend needs a second player: press a button on a controller, then slide it to a side.',
      };
    }
    return { ok: false, message: 'Slide at least one input to a side.' };
  }
  const home = sideHasHuman(m, 0), away = sideHasHuman(m, 1);
  const msg = home && away ? 'Player against player.' : home ? 'You at home, CPU away.' : 'CPU at home, you away.';
  return { ok: true, message: n === 2 && (home !== away) ? `Two players together: ${home ? 'home' : 'away'} side, CPU opposite.` : msg };
}
