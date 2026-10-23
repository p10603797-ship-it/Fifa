/**
 * [AUD-05] The event-to-sound map (BRIEF section 8 Sound; section 4 rule 4: audio consumes sim events and never
 * changes sim state).
 *
 * One table, EVENT_ROUTES, gives every EventType a route (or Route.IGNORE, explicitly); dispatchEvents() turns the
 * events of one tick into calls on the sound modules: sfx (AUD-03), whistles and stings (AUD-04), crowd (AUD-02).
 * This is the only module that reacts to sim events, so no event is ever voiced twice by two modules.
 *
 * Per tick:
 * - A pre-pass notes whether the tick already has a WHISTLE event and whether advantage started. FOUL, CARD and
 *   OFFSIDE blow a short whistle only when the sim did not whistle in the same tick (the rules emit WHISTLE with
 *   the restart) and, for fouls, when advantage is not being played.
 * - Duplicates within the tick are dropped by a dedupe key per cue (two kicks, a SAVE catch plus KEEPER_HANDS
 *   pick-up, a foul's fallback whistle plus the rules' whistle).
 * - Half-time and full-time whistles come from WHISTLE events only; PHASE_CHANGE drives the crowd (half-time
 *   applause and lull, full-time applause), never a second whistle. The full-time sting follows the final whistle.
 * Hot path: no allocation (preallocated typed arrays, a reused targets object, a switch per event).
 */
import { HALF_LENGTH } from '../contracts/constants';
import { CardKind, ChallengeOutcome, KickKind, MatchPhase, SaveKind } from '../contracts/enums';
import { EventType, WhistleKind, type EventBuffer, type SimEvent } from '../contracts/events';
import type { ReadonlySimState } from '../contracts/state';
import { CrowdCue, type CrowdModule } from './crowd';
import { getAudioServices } from './services';
import type { SfxModule } from './sfx';
import type { AudioCtx, AudioModule } from './types';
import { StingKind, type WhistleModule } from './whistles';

const LOCAL_TUNING = {
  /** Shot speed for a full-strength save reaction, m/s. */
  saveFullSpeed: 30,
  /** Near-miss distance at which the crowd stops reacting, m. */
  nearMissRange: 4,
  /** Power of an interception touch (soft first-touch sound), 0..1. */
  interceptPower: 0.4,
  /** Strength of a keeper pick-up glove sound, 0..1. */
  pickUpStrength: 0.5,
} as const; // LOCAL_TUNING (non-gameplay: audio event mapping)

export const EVENT_MAP_TUNING = LOCAL_TUNING;

export enum Route {
  IGNORE = 0,
  KICK = 1,
  BOUNCE = 2,
  POST = 3,
  NET = 4,
  WHISTLE = 5,
  FOUL = 6,
  CARD = 7,
  OFFSIDE = 8,
  SAVE = 9,
  GOAL = 10,
  SUBSTITUTION = 11,
  PHASE = 12,
  TACKLE = 13,
  INTERCEPT = 14,
  SHOT = 15,
  NEAR_MISS = 16,
  SHOOTOUT_KICK = 17,
  KEEPER_HANDS = 18,
  ATTACK_BUILD = 19,
  BODY_CONTACT = 20,
  /** Read by the pre-pass only (ADVANTAGE: no fallback whistle while advantage is played). */
  FLAG = 21,
}

/** Every EventType -> its route. IGNORE entries are deliberate (no sound, or voiced through another event). */
export const EVENT_ROUTES: Readonly<Record<EventType, Route>> = {
  [EventType.KICK]: Route.KICK,
  [EventType.BOUNCE]: Route.BOUNCE,
  [EventType.POST]: Route.POST,
  [EventType.NET]: Route.NET,
  [EventType.WHISTLE]: Route.WHISTLE,
  [EventType.FOUL]: Route.FOUL,
  [EventType.CARD]: Route.CARD,
  [EventType.OFFSIDE]: Route.OFFSIDE,
  [EventType.SAVE]: Route.SAVE,
  [EventType.GOAL]: Route.GOAL,
  [EventType.SUBSTITUTION]: Route.SUBSTITUTION,
  [EventType.PHASE_CHANGE]: Route.PHASE,
  [EventType.TACKLE]: Route.TACKLE,
  [EventType.INTERCEPT]: Route.INTERCEPT,
  [EventType.SHOT]: Route.SHOT,
  // The restart's whistle arrives as its own WHISTLE event.
  [EventType.RESTART_AWARDED]: Route.IGNORE,
  [EventType.ADVANTAGE]: Route.FLAG,
  [EventType.FORFEIT]: Route.IGNORE,
  // Crowd intensity follows possession through the state every frame.
  [EventType.POSSESSION]: Route.IGNORE,
  [EventType.WATCHDOG]: Route.IGNORE,
  // Period-end whistles are WHISTLE events; the crowd reacts to the PHASE_CHANGE.
  [EventType.PERIOD_END]: Route.IGNORE,
  [EventType.NEAR_MISS]: Route.NEAR_MISS,
  // The skill's touch is a KICK (SKILL_TOUCH) event.
  [EventType.SKILL]: Route.IGNORE,
  // The header or volley itself is a KICK event.
  [EventType.AERIAL]: Route.IGNORE,
  [EventType.PASS_COMPLETE]: Route.IGNORE,
  [EventType.SWITCH]: Route.IGNORE,
  [EventType.KEEPER_HANDS]: Route.KEEPER_HANDS,
  [EventType.ATTACK_BUILD]: Route.ATTACK_BUILD,
  [EventType.BODY_CONTACT]: Route.BODY_CONTACT,
  [EventType.TACTIC]: Route.IGNORE,
  [EventType.WALL]: Route.IGNORE,
  [EventType.SHOOTOUT_KICK]: Route.SHOOTOUT_KICK,
};

/** Dedupe keys (one cue per key per tick). */
const enum Key {
  TOUCH = 0,
  BOUNCE = 1,
  FRAME = 2,
  NET = 3,
  /** WHISTLE + kind (4..7). */
  WHISTLE = 4,
  CROWD_FOUL = 8,
  CROWD_CARD = 9,
  CROWD_OFFSIDE = 10,
  CROWD_SAVE = 11,
  GOAL = 12,
  CROWD_SUB = 13,
  CROWD_PHASE = 14,
  TACKLE = 15,
  CROWD_SHOT = 16,
  CROWD_NEAR_MISS = 17,
  CROWD_SHOOTOUT = 18,
  GLOVE = 19,
  BODY = 20,
  ATTACK_BUILD = 21,
  CROWD_WOODWORK = 22,
  COUNT = 23,
}

/** The sound modules the map drives (null = that module is missing; its cues are skipped). */
export interface EventTargets {
  crowd: CrowdModule | null;
  sfx: SfxModule | null;
  whistles: WhistleModule | null;
}

/** Per-map bookkeeping (preallocated). */
export interface EventMapScratch {
  /** Dispatch call counter (one call = one tick). */
  call: number;
  /** Call number at which each dedupe key last fired. */
  readonly fired: Float64Array;
  /** Cues dispatched per Route and cues dropped as same-tick duplicates. */
  readonly routed: Int32Array;
  deduped: number;
}

export function createEventMapScratch(): EventMapScratch {
  return { call: 0, fired: new Float64Array(Key.COUNT).fill(-1), routed: new Int32Array(Route.FLAG + 1), deduped: 0 };
}

/** First time `key` fires in this call: true (and marked); a duplicate: false. */
function once(s: EventMapScratch, key: number): boolean {
  if (s.fired[key] === s.call) {
    s.deduped++;
    return false;
  }
  s.fired[key] = s.call;
  return true;
}

function clamp01(x: number): number {
  return x !== x ? 0 : x < 0 ? 0 : x > 1 ? 1 : x;
}

function validSlot(state: ReadonlySimState, slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < state.players.length;
}

function teamOf(state: ReadonlySimState, slot: number): number {
  return validSlot(state, slot) ? state.players[slot]!.team : -1;
}

function slotX(state: ReadonlySimState, slot: number): number {
  return validSlot(state, slot) ? state.players[slot]!.x : state.ball.x;
}

/** The event's x when it carries a position, else the ball's. */
function eventX(e: Readonly<SimEvent>, state: ReadonlySimState): number {
  if ((e.x !== 0 || e.y !== 0 || e.z !== 0) && Number.isFinite(e.x)) return e.x;
  return state.ball.x;
}

/** Severity of a foul for the crowd (ChallengeOutcome). */
function foulStrength(outcome: number): number {
  switch (outcome) {
    case ChallengeOutcome.FOUL_RED: return 1;
    case ChallengeOutcome.FOUL_YELLOW: return 0.75;
    case ChallengeOutcome.FOUL: return 0.5;
    default: return 0.3;
  }
}

/** Short whistle for FOUL / CARD / OFFSIDE when the rules did not whistle in this tick. */
function fallbackWhistle(t: EventTargets, s: EventMapScratch, anyWhistle: boolean): void {
  if (anyWhistle || !t.whistles) return;
  if (once(s, Key.WHISTLE + WhistleKind.SHORT)) t.whistles.whistle(WhistleKind.SHORT);
}

/**
 * Voice the events of one tick (pure apart from the module calls). Allocation-free.
 */
export function dispatchEvents(events: EventBuffer, state: ReadonlySimState, t: EventTargets, s: EventMapScratch): void {
  const n = events.count;
  if (n <= 0) return;
  s.call++;
  // Pre-pass: does the rules engine whistle in this tick, and does advantage start?
  let anyWhistle = false;
  let advantage = false;
  for (let i = 0; i < n; i++) {
    const e = events.get(i);
    if (e.type === EventType.WHISTLE) anyWhistle = true;
    else if (e.type === EventType.ADVANTAGE && e.a === 1) advantage = true;
  }
  const crowd = t.crowd;
  const sfx = t.sfx;
  const wh = t.whistles;
  for (let i = 0; i < n; i++) {
    const e = events.get(i);
    const route = EVENT_ROUTES[e.type as EventType];
    if (route === undefined || route === Route.IGNORE || route === Route.FLAG) continue;
    s.routed[route]!++;
    switch (route) {
      case Route.KICK:
        if (sfx && once(s, Key.TOUCH)) sfx.kick(e.b as KickKind, e.c, eventX(e, state));
        break;
      case Route.INTERCEPT:
        if (sfx && once(s, Key.TOUCH)) sfx.kick(KickKind.FIRST_TOUCH, LOCAL_TUNING.interceptPower, slotX(state, e.a));
        break;
      case Route.BOUNCE:
        if (sfx && once(s, Key.BOUNCE)) sfx.bounce(e.c, eventX(e, state));
        break;
      case Route.POST:
        if (sfx && once(s, Key.FRAME)) sfx.frame(e.b === 1, e.c, eventX(e, state));
        if (crowd && once(s, Key.CROWD_WOODWORK)) crowd.cue(CrowdCue.WOODWORK, state.ball.lastTouchTeam, 1);
        break;
      case Route.NET: {
        const x = e.x !== 0 && Number.isFinite(e.x) ? e.x : (e.a < 0 ? -1 : 1) * HALF_LENGTH;
        if (sfx && once(s, Key.NET)) sfx.net(e.c, x);
        break;
      }
      case Route.WHISTLE: {
        const k = e.a;
        if (wh && k >= WhistleKind.SHORT && k <= WhistleKind.FINAL && once(s, Key.WHISTLE + k)) wh.whistle(k as WhistleKind);
        break;
      }
      case Route.FOUL:
        if (crowd && once(s, Key.CROWD_FOUL)) crowd.cue(CrowdCue.FOUL, teamOf(state, e.a), foulStrength(e.c));
        if (!advantage) fallbackWhistle(t, s, anyWhistle);
        break;
      case Route.CARD:
        if (crowd && once(s, Key.CROWD_CARD)) crowd.cue(CrowdCue.CARD, teamOf(state, e.a), e.b === CardKind.YELLOW ? 0.5 : 1);
        fallbackWhistle(t, s, anyWhistle);
        break;
      case Route.OFFSIDE:
        if (crowd && once(s, Key.CROWD_OFFSIDE)) crowd.cue(CrowdCue.OFFSIDE, teamOf(state, e.a), 0.5);
        fallbackWhistle(t, s, anyWhistle);
        break;
      case Route.SAVE: {
        const strength = clamp01(e.c / LOCAL_TUNING.saveFullSpeed);
        if (sfx && once(s, Key.GLOVE)) {
          if (e.b === SaveKind.BLOCK) sfx.body(eventX(e, state));
          else sfx.glove(strength, eventX(e, state));
        }
        if (crowd && once(s, Key.CROWD_SAVE)) crowd.cue(CrowdCue.SAVE, teamOf(state, e.a), strength);
        break;
      }
      case Route.KEEPER_HANDS:
        if (e.b === 1 && sfx && once(s, Key.GLOVE)) sfx.glove(LOCAL_TUNING.pickUpStrength, slotX(state, e.a));
        break;
      case Route.GOAL:
        if (once(s, Key.GOAL)) {
          if (wh) wh.sting(StingKind.GOAL);
          if (crowd) crowd.cue(CrowdCue.GOAL, e.a, 1);
        }
        break;
      case Route.SUBSTITUTION:
        if (crowd && once(s, Key.CROWD_SUB)) crowd.cue(CrowdCue.SUBSTITUTION, e.a, 1);
        break;
      case Route.PHASE:
        if (!crowd) break;
        if (e.b === MatchPhase.HALF_TIME && once(s, Key.CROWD_PHASE)) crowd.cue(CrowdCue.HALF_TIME, -1, 1);
        else if (e.b === MatchPhase.FULL_TIME && once(s, Key.CROWD_PHASE)) crowd.cue(CrowdCue.FULL_TIME, -1, 1);
        break;
      case Route.TACKLE:
        if (sfx && once(s, Key.TACKLE)) sfx.tackle(e.d, e.c === 1, slotX(state, e.a));
        break;
      case Route.SHOT:
        if (crowd && once(s, Key.CROWD_SHOT)) crowd.cue(CrowdCue.SHOT, teamOf(state, e.a), clamp01(0.3 + 0.3 * (e.b === 1 ? 1 : 0) + 1.2 * clamp01(e.c)));
        break;
      case Route.NEAR_MISS:
        if (crowd && once(s, Key.CROWD_NEAR_MISS)) crowd.cue(CrowdCue.NEAR_MISS, teamOf(state, e.a), clamp01(1 - e.c / LOCAL_TUNING.nearMissRange));
        break;
      case Route.SHOOTOUT_KICK:
        if (crowd && once(s, Key.CROWD_SHOOTOUT)) crowd.cue(e.c === 1 ? CrowdCue.GOAL : CrowdCue.SHOOTOUT_MISS, e.a, 1);
        break;
      case Route.ATTACK_BUILD:
        if (crowd && once(s, Key.ATTACK_BUILD)) crowd.attackBuild(e.a, e.c);
        break;
      case Route.BODY_CONTACT:
        if (sfx && once(s, Key.BODY)) sfx.body(slotX(state, e.a));
        break;
      default:
        break;
    }
  }
}

export interface EventMapModule extends AudioModule {
  readonly scratch: EventMapScratch;
}

export function createEventMap(ctx: AudioCtx): EventMapModule {
  const svc = getAudioServices(ctx);
  const scratch = createEventMapScratch();
  const targets: EventTargets = { crowd: null, sfx: null, whistles: null };
  return {
    scratch,
    onEvents(events, state) {
      if (!svc) return;
      const m = svc.modules;
      targets.crowd = m.crowd as CrowdModule | null;
      targets.sfx = m.sfx as SfxModule | null;
      targets.whistles = m.whistles as WhistleModule | null;
      dispatchEvents(events, state, targets, scratch);
    },
    dispose() {
      targets.crowd = null;
      targets.sfx = null;
      targets.whistles = null;
    },
  };
}
