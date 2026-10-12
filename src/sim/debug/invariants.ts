/**
 * [FND-06] Sim invariant checker (brief section 14, point 1). Shared by tests, the headless runner (soak / fuzz)
 * and the debug build. Call check(s, events) after every step(); it compares with the previous tick, so call
 * reset() (or start from a state whose tick is not previous + 1) when a new match begins.
 *
 * Checks are grouped by name. Set 'core' = finite, bounds, phase, owner, players, controllers, score, clock.
 * Set 'all' = core + action, overlap, keeperArea, chaser, phaseMax, clockStop.
 * Practice mode (config.mode PRACTICE) may field reduced sides: 1..11 players and no roster bookkeeping.
 *
 * Allocation-light: check() returns a shared frozen empty array when everything passes, and every check except
 * 'finite' allocates nothing on the passing path. The 'finite' scan reads every state field by key, and V8 boxes
 * double fields read that way, so it leaves about 100-200 bytes of short-lived garbage per check (a few KB/s at
 * 60 Hz in the debug build; a generic scan cannot avoid it). Message strings are built only for failures, and only
 * while the optional message budget lasts (failures are still counted afterwards). Every index read from state is
 * range-checked first, so a corrupt state (including a corrupt previous tick) never throws here.
 *
 * Goals: the score may change only by the number of GOAL events in the tick, and each GOAL event must come with
 * its own scoring transition into the GOAL phase (IN_PLAY -> GOAL, as the rules machine does in the same tick), so
 * a goal re-counted during the cut-scene or a GOAL event in a dead phase fails.
 */
import {
  HALF_LENGTH, MAX_SUBS, MIN_PLAYERS, NUM_CONTROLLERS, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PLAYERS_PER_TEAM,
  WORLD_MAX_X, WORLD_MAX_Y, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z, teamFirstSlot,
} from '../../contracts/constants';
import { ActionKind, ControllerKind, MatchPhase, ModeId, Period } from '../../contracts/enums';
import { EventType, type EventBuffer } from '../../contracts/events';
import { IMMUTABLE_STATE_KEYS, RosterStatus, type SimState } from '../../contracts/state';
import { CLOCK_PHASES, isLegalTransition } from '../../contracts/transitions';
import { T_PLAYER, T_RULES } from '../../contracts/tuning';

/** Names of the individual invariants. */
export type InvariantName =
  | 'finite' | 'bounds' | 'phase' | 'owner' | 'players' | 'controllers' | 'score' | 'clock'
  | 'action' | 'overlap' | 'keeperArea' | 'chaser' | 'phaseMax' | 'clockStop';

export type InvariantSetName = 'core' | 'all';

/** Every invariant name, in check order. */
export const INVARIANT_NAMES: readonly InvariantName[] = [
  'finite', 'bounds', 'phase', 'owner', 'players', 'controllers', 'score', 'clock',
  'action', 'overlap', 'keeperArea', 'chaser', 'phaseMax', 'clockStop',
];

export const INVARIANT_SETS: Readonly<Record<InvariantSetName, readonly InvariantName[]>> = {
  core: ['finite', 'bounds', 'phase', 'owner', 'players', 'controllers', 'score', 'clock'],
  all: INVARIANT_NAMES,
};

/** Tunables of the checker itself (not gameplay). */
export const INVARIANT_LIMITS = {
  /** An action may run this many ticks past actDur before it counts as overrun. */
  actionSlackTicks: 2,
  /** Max consecutive ticks a player may charge an action (power bar held). */
  maxChargeTicks: 120,
  /** Max consecutive ticks two active players may overlap. */
  overlapTicks: 60,
  /** Slack around the penalty area for a keeper holding the ball, m. */
  keeperAreaSlack: 1,
  /** Ticks the ball may be loose in play before both chasers must be set (pipeline lag: AI runs before kicks). */
  chaserGraceTicks: 1,
  /** Ticks a human/CPU controller may have no player during play (re-pick after a send-off / substitution). */
  controllerGraceTicks: 30,
  /** Lowest allowed ball centre height, m (below the grass plane is a failure). */
  ballMinY: 0,
} as const;

export interface InvariantChecker {
  /**
   * Check state after a tick. `events` = the events of that tick (null = none; events whose tick differs from
   * s.tick are ignored, so a stale buffer never counts twice). Returns failure messages
   * ("t=<tick> [<name>] ..."); the passing result is a shared frozen empty array, never mutate it.
   */
  check(s: SimState, events: EventBuffer | null): readonly string[];
  /** Forget the previous tick and clear all counters (new match). */
  reset(): void;
  /** The invariants this checker runs. */
  readonly names: readonly InvariantName[];
  /** Total failures since creation / reset (counted even after the message budget is used up). */
  readonly total: number;
  /** Failures per invariant since creation / reset (fresh object per read). */
  readonly counts: Record<InvariantName, number>;
}

export interface InvariantCheckerOptions {
  /** Max messages returned over the checker's lifetime (until reset); failures beyond are only counted. */
  messageLimit?: number;
}

const EMPTY: readonly string[] = Object.freeze([]);
const N_NAMES = INVARIANT_NAMES.length;
const IDX = {
  finite: 0, bounds: 1, phase: 2, owner: 3, players: 4, controllers: 5, score: 6, clock: 7,
  action: 8, overlap: 9, keeperArea: 10, chaser: 11, phaseMax: 12, clockStop: 13,
} as const satisfies Record<InvariantName, number>;

const MAX_PHASE = MatchPhase.POST_MATCH;
const MAX_ACTION = ActionKind.SHIELD;
/** Overlap distance threshold squared: 2 * bodyRadius - overlapTolerance. */
const OVERLAP_D = 2 * T_PLAYER.bodyRadius - T_PLAYER.overlapTolerance;
const OVERLAP_D2 = OVERLAP_D * OVERLAP_D;

function isInt(v: number, lo: number, hi: number): boolean {
  return v === (v | 0) && v >= lo && v <= hi;
}

function phaseName(p: number): string {
  const n = (MatchPhase as unknown as Record<number, string | undefined>)[p];
  return n ?? String(p);
}

function actName(a: number): string {
  const n = (ActionKind as unknown as Record<number, string | undefined>)[a];
  return n ?? String(a);
}

/** Phases a goal can be scored from (the rules machine moves IN_PLAY -> GOAL when the ball crosses). */
function isScoringPhase(p: number): boolean {
  return p === MatchPhase.IN_PLAY || p === MatchPhase.PENALTY;
}

function inClockPhase(p: number): boolean {
  for (let i = 0; i < CLOCK_PHASES.length; i++) if (CLOCK_PHASES[i] === p) return true;
  return false;
}

/** Phases in which every human / CPU controller must control a player. */
function isPlayPhase(p: number): boolean {
  return p >= MatchPhase.KICK_OFF && p <= MatchPhase.PENALTY;
}

function isImmutableKey(k: string): boolean {
  for (let i = 0; i < IMMUTABLE_STATE_KEYS.length; i++) if (IMMUTABLE_STATE_KEYS[i] === k) return true;
  return false;
}

// ---------------------------------------------------------------- finite scan

/** Count non-finite / non-numeric leaves under v (allocation-free). */
function countBad(v: unknown): number {
  if (typeof v === 'number') return v - v === 0 ? 0 : 1; // NaN and +-Infinity give NaN
  if (typeof v !== 'object' || v === null) return 1;
  let n = 0;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const e: unknown = v[i];
      if (typeof e === 'number') { if (e - e !== 0) n++; } else n += countBad(e);
    }
    return n;
  }
  if (ArrayBuffer.isView(v)) {
    if (v instanceof DataView) return 0;
    const a = v as unknown as ArrayLike<number>;
    for (let i = 0; i < a.length; i++) { const e = a[i]!; if (typeof e !== 'number' || e - e !== 0) n++; }
    return n;
  }
  const o = v as Record<string, unknown>;
  for (const k in o) {
    const e = o[k];
    if (typeof e === 'number') { if (e - e !== 0) n++; } else n += countBad(e);
  }
  return n;
}

function describeLeaf(v: unknown): string {
  if (typeof v === 'number') return String(v);
  if (v === null) return 'null';
  return typeof v;
}

/** Collect "path=value" for bad leaves (failure path only; allocates). */
function collectBad(v: unknown, path: string, out: string[], max: number): void {
  if (out.length >= max) return;
  if (typeof v === 'number') { if (v - v !== 0) out.push(`${path}=${describeLeaf(v)}`); return; }
  if (typeof v !== 'object' || v === null) { out.push(`${path}=${describeLeaf(v)} (not a number)`); return; }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) collectBad(v[i], `${path}[${i}]`, out, max);
    return;
  }
  if (ArrayBuffer.isView(v)) {
    if (v instanceof DataView) return;
    const a = v as unknown as ArrayLike<number>;
    for (let i = 0; i < a.length; i++) collectBad(a[i], `${path}[${i}]`, out, max);
    return;
  }
  const o = v as Record<string, unknown>;
  for (const k in o) collectBad(o[k], path === '' ? k : `${path}.${k}`, out, max);
}

// ---------------------------------------------------------------- checker

/**
 * Create a checker for a named set ('core' | 'all', default 'all') or an explicit list of invariant names.
 */
export function createInvariantChecker(
  set: InvariantSetName | readonly InvariantName[] = 'all',
  opts: InvariantCheckerOptions = {},
): InvariantChecker {
  const names: readonly InvariantName[] = typeof set === 'string' ? INVARIANT_SETS[set] : set.slice();
  const on = new Uint8Array(N_NAMES);
  for (const n of names) on[IDX[n]] = 1;
  const messageLimit = opts.messageLimit ?? Infinity;

  const counts = new Float64Array(N_NAMES);
  let total = 0;
  let messagesLeft = messageLimit;
  let out: string[] | null = null;
  let tick = 0;

  // Previous-tick baseline.
  let hasPrev = false;
  let prevTick = 0;
  let prevPhase = 0;
  let prevPeriod = 0;
  let prevPeriodT = 0;
  const prevGoals = [0, 0];
  // Temporal counters.
  const overlapT = new Int32Array(NUM_SLOTS * NUM_SLOTS);
  const chargeT = new Int32Array(NUM_SLOTS);
  const noSlotT = new Int32Array(NUM_CONTROLLERS);
  let looseT = 0;

  /** Count a failure; returns true when the caller should build and push a message. */
  function want(idx: number): boolean {
    counts[idx]!++;
    total++;
    if (messagesLeft <= 0) return false;
    messagesLeft--;
    return true;
  }

  function push(idx: number, msg: string): void {
    if (out === null) out = [];
    out.push(`t=${tick} [${INVARIANT_NAMES[idx]}] ${msg}`);
  }

  function clearTemporal(): void {
    overlapT.fill(0);
    chargeT.fill(0);
    noSlotT.fill(0);
    looseT = 0;
  }

  function reset(): void {
    hasPrev = false;
    clearTemporal();
    counts.fill(0);
    total = 0;
    messagesLeft = messageLimit;
  }

  // ------------------------------------------------------------ individual checks

  function checkFinite(s: SimState): void {
    const root = s as unknown as Record<string, unknown>;
    let bad = 0;
    for (const k in root) {
      if (isImmutableKey(k)) continue;
      bad += countBad(root[k]);
    }
    if (bad === 0) return;
    counts[IDX.finite]! += bad;
    total += bad;
    if (messagesLeft <= 0) return;
    const found: string[] = [];
    for (const k in root) {
      if (isImmutableKey(k)) continue;
      collectBad(root[k], k, found, 8);
    }
    for (let i = 0; i < found.length && messagesLeft > 0; i++) {
      messagesLeft--;
      push(IDX.finite, found[i]!);
    }
    if (bad > found.length && messagesLeft > 0) {
      messagesLeft--;
      push(IDX.finite, `... and ${bad - found.length} more non-finite values`);
    }
  }

  function checkBounds(s: SimState): void {
    const b = s.ball;
    if (b.x < WORLD_MIN_X || b.x > WORLD_MAX_X || b.z < WORLD_MIN_Z || b.z > WORLD_MAX_Z ||
      b.y < INVARIANT_LIMITS.ballMinY || b.y > WORLD_MAX_Y) {
      if (want(IDX.bounds)) push(IDX.bounds, `ball out of world bounds at (${b.x}, ${b.y}, ${b.z})`);
    }
    const ps = s.players;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      if (p.active !== 1) continue;
      if (p.x < WORLD_MIN_X || p.x > WORLD_MAX_X || p.z < WORLD_MIN_Z || p.z > WORLD_MAX_Z) {
        if (want(IDX.bounds)) push(IDX.bounds, `player ${i} out of world bounds at (${p.x}, ${p.z})`);
      }
    }
  }

  function checkPhase(s: SimState, ev: EventBuffer | null, temporal: boolean): void {
    const m = s.match;
    if (!isInt(m.phase, 0, MAX_PHASE)) {
      if (want(IDX.phase)) push(IDX.phase, `invalid phase ${m.phase}`);
      return;
    }
    if (!isInt(m.prevPhase, 0, MAX_PHASE)) {
      if (want(IDX.phase)) push(IDX.phase, `invalid prevPhase ${m.prevPhase}`);
    }
    // A corrupt previous phase was reported on its own tick; it is no baseline for transitions (and indexing the
    // transition table with it would throw).
    const prevValid = temporal && isInt(prevPhase, 0, MAX_PHASE);
    let cursor = prevValid ? prevPhase : -1;
    let changes = 0;
    const n = ev === null ? 0 : ev.count;
    for (let i = 0; i < n; i++) {
      const e = ev!.get(i);
      if (e.type !== EventType.PHASE_CHANGE || e.tick !== tick) continue;
      changes++;
      const from = e.a;
      const to = e.b;
      if (!isInt(from, 0, MAX_PHASE) || !isInt(to, 0, MAX_PHASE)) {
        if (want(IDX.phase)) push(IDX.phase, `PHASE_CHANGE with invalid phases ${from} -> ${to}`);
        cursor = to;
        continue;
      }
      if (cursor >= 0 && from !== cursor) {
        if (want(IDX.phase)) push(IDX.phase, `PHASE_CHANGE from ${phaseName(from)} but phase was ${phaseName(cursor)}`);
      }
      if (!isLegalTransition(from as MatchPhase, to as MatchPhase)) {
        if (want(IDX.phase)) push(IDX.phase, `illegal transition ${phaseName(from)} -> ${phaseName(to)}`);
      }
      cursor = to;
    }
    if (changes === 0) {
      if (temporal && m.phase !== prevPhase) {
        if (want(IDX.phase)) {
          push(IDX.phase, `phase changed ${phaseName(prevPhase)} -> ${phaseName(m.phase)} without a PHASE_CHANGE event`);
        }
        if (prevValid && !isLegalTransition(prevPhase as MatchPhase, m.phase) && want(IDX.phase)) {
          push(IDX.phase, `illegal transition ${phaseName(prevPhase)} -> ${phaseName(m.phase)}`);
        }
      }
    } else if (cursor !== m.phase) {
      if (want(IDX.phase)) push(IDX.phase, `phase is ${phaseName(m.phase)} but the last PHASE_CHANGE went to ${phaseName(cursor)}`);
    }
  }

  function checkPhaseMax(s: SimState): void {
    const m = s.match;
    if (!isInt(m.phase, 0, MAX_PHASE)) return;
    const max = T_RULES.phaseMaxTicks[m.phase] ?? 0;
    if (max > 0 && m.phaseT > max) {
      if (want(IDX.phaseMax)) push(IDX.phaseMax, `${phaseName(m.phase)} lasted ${m.phaseT} ticks (max ${max})`);
    }
  }

  function checkOwner(s: SimState): void {
    const b = s.ball;
    if (!isInt(b.owner, -1, NUM_SLOTS - 1)) {
      if (want(IDX.owner)) push(IDX.owner, `invalid ball.owner ${b.owner}`);
      return;
    }
    if (!isInt(b.heldBy, -1, NUM_SLOTS - 1)) {
      if (want(IDX.owner)) push(IDX.owner, `invalid ball.heldBy ${b.heldBy}`);
      return;
    }
    if (b.owner >= 0 && s.players[b.owner]!.active !== 1) {
      if (want(IDX.owner)) push(IDX.owner, `ball owner ${b.owner} is not on the pitch`);
    }
    if (b.heldBy >= 0) {
      if (b.heldBy !== b.owner) {
        if (want(IDX.owner)) push(IDX.owner, `two owners: ball.owner=${b.owner} but ball.heldBy=${b.heldBy}`);
      }
      const k = s.players[b.heldBy]!;
      if (k.isKeeper !== 1) {
        if (want(IDX.owner)) push(IDX.owner, `ball held in hands by non-keeper ${b.heldBy}`);
      }
      if (k.active !== 1) {
        if (want(IDX.owner)) push(IDX.owner, `ball held by keeper ${b.heldBy} who is not on the pitch`);
      }
    }
  }

  function checkPlayers(s: SimState): void {
    const m = s.match;
    // Practice modes may field a reduced side (e.g. free play against a keeper): 1..11 players, roster not tracked.
    const practice = s.config.mode === ModeId.PRACTICE;
    const minPlayers = practice ? 1 : MIN_PLAYERS;
    for (let t = 0; t < 2; t++) {
      const team = s.teams[t]!;
      const first = teamFirstSlot(t);
      let active = 0;
      let keepers = 0;
      let rosterSeen = 0;
      for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
        const slot = first + i;
        const p = s.players[slot]!;
        if (p.slot !== slot || p.team !== t) {
          if (want(IDX.players)) push(IDX.players, `slot ${slot} has slot=${p.slot} team=${p.team} (expected ${slot}/${t})`);
        }
        if (p.active !== 1) {
          if (p.active !== 0 && want(IDX.players)) push(IDX.players, `player ${slot} active=${p.active} (not 0/1)`);
          if (p.act !== ActionKind.NONE && want(IDX.players)) {
            push(IDX.players, `player ${slot} is off the pitch but acts (${actName(p.act)})`);
          }
          if (p.ctrl !== -1 && want(IDX.players)) push(IDX.players, `player ${slot} is off the pitch but controlled by ${p.ctrl}`);
          if (team.chaser === slot && want(IDX.players)) push(IDX.players, `player ${slot} is off the pitch but is team ${t}'s chaser`);
          continue;
        }
        active++;
        if (p.isKeeper === 1) keepers++;
        const r = p.rosterIdx;
        if (!isInt(r, 0, team.roster.length - 1)) {
          if (want(IDX.players)) push(IDX.players, `player ${slot} has invalid rosterIdx ${r}`);
          continue;
        }
        if (team.roster[r] !== RosterStatus.PLAYING) {
          if (want(IDX.players)) push(IDX.players, `player ${slot} (team ${t} roster ${r}) is on the pitch with roster status ${team.roster[r]}`);
        }
        if (r < 31) {
          if (((rosterSeen >>> r) & 1) === 1) {
            if (want(IDX.players)) push(IDX.players, `team ${t} roster ${r} is on the pitch twice (slot ${slot})`);
          } else rosterSeen |= 1 << r;
        }
      }
      let playing = 0;
      for (let r = 0; r < team.roster.length; r++) if (team.roster[r] === RosterStatus.PLAYING) playing++;
      if (playing !== active && !practice) {
        if (want(IDX.players)) push(IDX.players, `team ${t} has ${playing} PLAYING roster entries but ${active} active players`);
      }
      if (active > PLAYERS_PER_TEAM || (active < minPlayers && m.forfeitTeam !== t)) {
        if (want(IDX.players)) push(IDX.players, `team ${t} has ${active} players on the pitch (allowed ${minPlayers}..${PLAYERS_PER_TEAM})`);
      }
      if (team.onPitch !== active) {
        if (want(IDX.players)) push(IDX.players, `team ${t} onPitch=${team.onPitch} but ${active} players are active`);
      }
      if (keepers !== 1) {
        if (want(IDX.players)) push(IDX.players, `team ${t} has ${keepers} active keepers (expected 1)`);
      }
      const ks = team.keeperSlot;
      if (!isInt(ks, first, first + PLAYERS_PER_TEAM - 1)) {
        if (want(IDX.players)) push(IDX.players, `team ${t} keeperSlot ${ks} is not one of its slots`);
      } else {
        const k = s.players[ks]!;
        if (k.active !== 1 || k.isKeeper !== 1) {
          if (want(IDX.players)) push(IDX.players, `team ${t} keeperSlot ${ks} is not an active keeper (active=${k.active} isKeeper=${k.isKeeper})`);
        }
      }
      if (!isInt(team.subsUsed, 0, MAX_SUBS)) {
        if (want(IDX.players)) push(IDX.players, `team ${t} subsUsed=${team.subsUsed} (max ${MAX_SUBS})`);
      }
    }
  }

  function checkControllers(s: SimState, temporal: boolean): void {
    const phase = s.match.phase;
    const play = isPlayPhase(phase);
    for (let ci = 0; ci < s.ctrl.length; ci++) {
      const c = s.ctrl[ci]!;
      if (c.kind === ControllerKind.NONE) {
        noSlotT[ci] = 0;
        if (c.slot !== -1 && want(IDX.controllers)) push(IDX.controllers, `controller ${ci} has no kind but controls slot ${c.slot}`);
        continue;
      }
      if (c.kind !== ControllerKind.HUMAN && c.kind !== ControllerKind.CPU) {
        if (want(IDX.controllers)) push(IDX.controllers, `controller ${ci} has invalid kind ${c.kind}`);
        continue;
      }
      if (c.side !== 0 && c.side !== 1) {
        if (want(IDX.controllers)) push(IDX.controllers, `controller ${ci} has invalid side ${c.side}`);
        continue;
      }
      if (c.slot === -1) {
        noSlotT[ci] = play && temporal ? noSlotT[ci]! + 1 : play ? 1 : 0;
        if (noSlotT[ci]! > INVARIANT_LIMITS.controllerGraceTicks && want(IDX.controllers)) {
          push(IDX.controllers, `controller ${ci} (side ${c.side}) has controlled no player for ${noSlotT[ci]} ticks in ${phaseName(phase)}`);
        }
        continue;
      }
      noSlotT[ci] = 0;
      if (!isInt(c.slot, 0, NUM_SLOTS - 1)) {
        if (want(IDX.controllers)) push(IDX.controllers, `controller ${ci} controls invalid slot ${c.slot}`);
        continue;
      }
      const p = s.players[c.slot]!;
      if (p.active !== 1) {
        if (want(IDX.controllers)) push(IDX.controllers, `controller ${ci} controls player ${c.slot} who is not on the pitch`);
      }
      if (p.team !== c.side) {
        if (want(IDX.controllers)) push(IDX.controllers, `controller ${ci} (side ${c.side}) controls player ${c.slot} of team ${p.team}`);
      }
      if (p.ctrl !== ci) {
        if (want(IDX.controllers)) push(IDX.controllers, `controller ${ci} controls player ${c.slot} but player.ctrl=${p.ctrl}`);
      }
    }
    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i]!;
      if (p.ctrl === -1 || p.active !== 1) continue;
      if (!isInt(p.ctrl, 0, s.ctrl.length - 1) || s.ctrl[p.ctrl]!.slot !== i) {
        if (want(IDX.controllers)) push(IDX.controllers, `player ${i} has ctrl=${p.ctrl} but that controller does not control him`);
      }
    }
  }

  function checkScore(s: SimState, ev: EventBuffer | null, temporal: boolean): void {
    let g0 = 0;
    let g1 = 0;
    let phaseEvents = 0;
    let entries = 0;
    const n = ev === null ? 0 : ev.count;
    for (let i = 0; i < n; i++) {
      const e = ev!.get(i);
      if (e.tick !== tick) continue;
      if (e.type === EventType.PHASE_CHANGE) {
        phaseEvents++;
        if (e.b === MatchPhase.GOAL && isScoringPhase(e.a)) entries++;
        continue;
      }
      if (e.type !== EventType.GOAL) continue;
      if (e.a === 0) g0++;
      else if (e.a === 1) g1++;
      else if (want(IDX.score)) push(IDX.score, `GOAL event with invalid team ${e.a}`);
    }
    // Without PHASE_CHANGE events (a missing event is the phase check's failure) compare with the previous tick.
    if (phaseEvents === 0 && temporal && s.match.phase === MatchPhase.GOAL && isScoringPhase(prevPhase)) entries = 1;
    const goalEvents = g0 + g1;
    if (goalEvents > entries) {
      if (want(IDX.score)) {
        push(IDX.score, `${goalEvents} GOAL event(s) but ${entries} scoring transition(s) into GOAL (phase ${phaseName(temporal ? prevPhase : s.match.prevPhase)} -> ${phaseName(s.match.phase)}): each goal counts once, when play enters the GOAL phase`);
      }
    } else if (entries > goalEvents && want(IDX.score)) {
      push(IDX.score, `play entered the GOAL phase without a GOAL event (${entries} transition(s), ${goalEvents} event(s))`);
    }
    for (let t = 0; t < 2; t++) {
      const goals = s.teams[t]!.goals;
      if (!isInt(goals, 0, 1e6)) {
        if (want(IDX.score)) push(IDX.score, `team ${t} goals=${goals}`);
        continue;
      }
      if (!temporal || s.match.forfeitTeam >= 0) continue;
      const delta = goals - prevGoals[t]!;
      const evGoals = t === 0 ? g0 : g1;
      if (delta !== evGoals && want(IDX.score)) {
        push(IDX.score, `team ${t} score changed by ${delta} with ${evGoals} GOAL event(s)`);
      }
    }
  }

  function checkClock(s: SimState, temporal: boolean): void {
    const m = s.match;
    if (!isInt(m.period, Period.FIRST_HALF, Period.SHOOT_OUT)) {
      if (want(IDX.clock)) push(IDX.clock, `invalid period ${m.period}`);
      return;
    }
    if (!(m.periodT >= 0)) {
      if (want(IDX.clock)) push(IDX.clock, `negative periodT ${m.periodT}`);
    }
    if (!temporal) return;
    if (m.period < prevPeriod) {
      if (want(IDX.clock)) push(IDX.clock, `period went backwards ${prevPeriod} -> ${m.period}`);
    } else if (m.period === prevPeriod && m.periodT < prevPeriodT) {
      if (want(IDX.clock)) push(IDX.clock, `clock ran backwards in period ${m.period}: ${prevPeriodT} -> ${m.periodT}`);
    }
  }

  function checkClockStop(s: SimState, ev: EventBuffer | null): void {
    const m = s.match;
    if (m.period !== prevPeriod || m.phase !== prevPhase || inClockPhase(m.phase)) return;
    const n = ev === null ? 0 : ev.count;
    for (let i = 0; i < n; i++) {
      const e = ev!.get(i);
      if (e.type === EventType.PHASE_CHANGE && e.tick === tick) return;
    }
    if (m.periodT > prevPeriodT && want(IDX.clockStop)) {
      push(IDX.clockStop, `clock ran during ${phaseName(m.phase)}: ${prevPeriodT} -> ${m.periodT}`);
    }
  }

  function checkAction(s: SimState, temporal: boolean): void {
    for (let i = 0; i < s.players.length; i++) {
      const p = s.players[i]!;
      if (p.active !== 1 || p.act === ActionKind.NONE) { chargeT[i] = 0; continue; }
      if (!isInt(p.act, 0, MAX_ACTION)) {
        chargeT[i] = 0;
        if (want(IDX.action)) push(IDX.action, `player ${i} has invalid action ${p.act}`);
        continue;
      }
      if (p.actCharging === 1) {
        chargeT[i] = temporal ? chargeT[i]! + 1 : 1;
        if (chargeT[i]! > INVARIANT_LIMITS.maxChargeTicks && want(IDX.action)) {
          push(IDX.action, `player ${i} has charged ${actName(p.act)} for ${chargeT[i]} ticks (max ${INVARIANT_LIMITS.maxChargeTicks})`);
        }
        continue;
      }
      chargeT[i] = 0;
      if (p.actT > p.actDur + INVARIANT_LIMITS.actionSlackTicks && want(IDX.action)) {
        push(IDX.action, `player ${i} in ${actName(p.act)} past its budget: actT=${p.actT} actDur=${p.actDur}`);
      }
    }
  }

  function checkOverlap(s: SimState, temporal: boolean): void {
    const ps = s.players;
    const n = ps.length < NUM_SLOTS ? ps.length : NUM_SLOTS;
    for (let i = 0; i < n; i++) {
      const a = ps[i]!;
      for (let j = i + 1; j < n; j++) {
        const k = i * NUM_SLOTS + j;
        const b = ps[j]!;
        if (a.active !== 1 || b.active !== 1) { overlapT[k] = 0; continue; }
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        if (dx * dx + dz * dz < OVERLAP_D2) {
          overlapT[k] = temporal ? overlapT[k]! + 1 : 1;
          if (overlapT[k]! > INVARIANT_LIMITS.overlapTicks && want(IDX.overlap)) {
            push(IDX.overlap, `players ${i} (${actName(a.act)}) and ${j} (${actName(b.act)}) overlap for ${overlapT[k]} ticks at (${a.x.toFixed(2)}, ${a.z.toFixed(2)})`);
          }
        } else overlapT[k] = 0;
      }
    }
  }

  function outsideOwnArea(dir: number, x: number, z: number): boolean {
    const slack = INVARIANT_LIMITS.keeperAreaSlack;
    // Depth from the own goal line (x = -dir * 52.5) toward the pitch.
    const depth = dir * x + HALF_LENGTH;
    return depth < -slack || depth > PENALTY_AREA_DEPTH + slack || z < -PENALTY_AREA_HALF_WIDTH - slack ||
      z > PENALTY_AREA_HALF_WIDTH + slack;
  }

  function checkKeeperArea(s: SimState): void {
    const b = s.ball;
    if (s.match.phase !== MatchPhase.IN_PLAY || !isInt(b.heldBy, 0, NUM_SLOTS - 1)) return;
    const k = s.players[b.heldBy]!;
    if (!isInt(k.team, 0, 1)) return;
    const dir = s.teams[k.team]!.dir;
    if (outsideOwnArea(dir, k.x, k.z) || outsideOwnArea(dir, b.x, b.z)) {
      if (want(IDX.keeperArea)) {
        push(IDX.keeperArea, `keeper ${b.heldBy} holds the ball outside his own area: keeper (${k.x.toFixed(2)}, ${k.z.toFixed(2)}) ball (${b.x.toFixed(2)}, ${b.z.toFixed(2)})`);
      }
    }
  }

  function checkChaser(s: SimState, temporal: boolean): void {
    if (s.match.phase !== MatchPhase.IN_PLAY || s.ball.owner !== -1) { looseT = 0; return; }
    looseT = temporal ? looseT + 1 : 1;
    if (looseT <= INVARIANT_LIMITS.chaserGraceTicks) return;
    for (let t = 0; t < 2; t++) {
      const c = s.teams[t]!.chaser;
      const first = teamFirstSlot(t);
      if (!isInt(c, first, first + PLAYERS_PER_TEAM - 1) || s.players[c]!.active !== 1) {
        if (want(IDX.chaser)) push(IDX.chaser, `ball loose for ${looseT} ticks but team ${t} chaser is ${c} (needs one active teammate)`);
      }
    }
  }

  // ------------------------------------------------------------ entry

  function check(s: SimState, events: EventBuffer | null): readonly string[] {
    out = null;
    tick = s.tick;
    const temporal = hasPrev && s.tick === prevTick + 1;
    if (!temporal) clearTemporal();
    if (on[IDX.finite]) checkFinite(s);
    if (on[IDX.bounds]) checkBounds(s);
    if (on[IDX.phase]) checkPhase(s, events, temporal);
    if (on[IDX.owner]) checkOwner(s);
    if (on[IDX.players]) checkPlayers(s);
    if (on[IDX.controllers]) checkControllers(s, temporal);
    if (on[IDX.score]) checkScore(s, events, temporal);
    if (on[IDX.clock]) checkClock(s, temporal);
    if (on[IDX.action]) checkAction(s, temporal);
    if (on[IDX.overlap]) checkOverlap(s, temporal);
    if (on[IDX.keeperArea]) checkKeeperArea(s);
    if (on[IDX.chaser]) checkChaser(s, temporal);
    if (on[IDX.phaseMax]) checkPhaseMax(s);
    if (on[IDX.clockStop] && temporal) checkClockStop(s, events);

    hasPrev = true;
    prevTick = s.tick;
    prevPhase = s.match.phase;
    prevPeriod = s.match.period;
    prevPeriodT = s.match.periodT;
    prevGoals[0] = s.teams[0]!.goals;
    prevGoals[1] = s.teams[1]!.goals;
    return out ?? EMPTY;
  }

  return {
    check,
    reset,
    names,
    get total() { return total; },
    get counts() {
      const r = {} as Record<InvariantName, number>;
      for (let i = 0; i < N_NAMES; i++) r[INVARIANT_NAMES[i]!] = counts[i]!;
      return r;
    },
  };
}
