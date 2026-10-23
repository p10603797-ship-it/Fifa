/**
 * [PAD-07] Rumble on goal, post and hard tackle where `vibrationActuator` exists (section 10), behind the
 * settings.controls.pad.rumble toggle. Driven by sim events (ARCHITECTURE rule 4), never feeds back.
 *
 *   event                                  kind          pads
 *   GOAL; SHOOTOUT_KICK with c = 1         GOAL          every pad bound to a human in this match
 *   POST (post or crossbar)                POST          every bound pad
 *   TACKLE with d = ChallengeKind.HARD     HARD_TACKLE   pads of the humans controlling the tackler (a) or victim (b)
 *
 * rumbleKindForEvent / rumbleHumans are the pure mapping (tests). Profiles (strength 0..1, duration ms) and the
 * priority rule live in LOCAL_TUNING: on one pad a rumble does not interrupt a stronger-or-equal one still playing
 * (sim ticks, so a ball rattling between post and bar rumbles once, and a post right after a goal never cuts the
 * goal's rumble short); a stronger kind replaces a weaker one at once.
 *
 * Playing: playRumble(pad, strong, weak, ms) is guarded for every browser shape: vibrationActuator.playEffect(
 * 'dual-rumble') (skipped when its `effects` list says it cannot), else hapticActuators[0].pulse(); missing APIs,
 * throws and rejected promises are swallowed. stopRumble(pad) calls vibrationActuator.reset() where it exists.
 *
 * createRumbleListener(registry, settings) is what the app wires up: onEvents(events, state) after every sim tick;
 * the pads come from the registry's bound pads (DotkickDeviceRegistry.boundPads(); a registry without it rumbles
 * every connected pad) and its pad manager (else the shared one). The toggle is read on every rumble; switching it
 * off stops a rumble in progress. Device code (not sim): it allocates only when an event actually rumbles.
 */

import type { DeviceRegistry, SettingsStore } from '../../contracts/app';
import { MAX_HUMANS, NUM_SLOTS, TICK_HZ } from '../../contracts/constants';
import { ChallengeKind } from '../../contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../contracts/events';
import type { Settings } from '../../contracts/settings';
import type { ReadonlySimState } from '../../contracts/state';
import { T_PAD_RUMBLE } from '../../contracts/tuning';
import { getPadManager, type PadManager } from './manager';

const LOCAL_TUNING = T_PAD_RUMBLE; // [TUN-2] device feel: contracts/tuning.ts T_PAD_RUMBLE

/** The LOCAL_TUNING block (read-only; tests). */
export const RUMBLE_TUNING = LOCAL_TUNING;

/** What made a pad rumble. Higher value = higher priority. */
export enum RumbleKind {
  NONE = 0,
  POST = 1,
  HARD_TACKLE = 2,
  GOAL = 3,
}

export interface RumbleProfile {
  readonly strong: number;
  readonly weak: number;
  readonly ms: number;
}

/** Profile per RumbleKind (NONE plays nothing). */
export const RUMBLE_PROFILES: Readonly<Record<RumbleKind, RumbleProfile>> = {
  [RumbleKind.NONE]: { strong: 0, weak: 0, ms: 0 },
  [RumbleKind.POST]: LOCAL_TUNING.post,
  [RumbleKind.HARD_TACKLE]: LOCAL_TUNING.hardTackle,
  [RumbleKind.GOAL]: LOCAL_TUNING.goal,
};

/** The rumble a sim event asks for (pure). */
export function rumbleKindForEvent(ev: Readonly<SimEvent>): RumbleKind {
  switch (ev.type) {
    case EventType.GOAL: return RumbleKind.GOAL;
    case EventType.SHOOTOUT_KICK: return ev.c === 1 ? RumbleKind.GOAL : RumbleKind.NONE;
    case EventType.POST: return RumbleKind.POST;
    case EventType.TACKLE: return ev.d === ChallengeKind.HARD ? RumbleKind.HARD_TACKLE : RumbleKind.NONE;
    default: return RumbleKind.NONE;
  }
}

/** Every human (bits 0..MAX_HUMANS-1). */
export const ALL_HUMANS = (1 << MAX_HUMANS) - 1;

/** Human controller index driving player `slot` (-1 none): players[slot].ctrl, else ctrl[h].slot. */
function humanOf(state: ReadonlySimState, slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= NUM_SLOTS) return -1;
  const p = state.players[slot];
  if (p && p.ctrl >= 0 && p.ctrl < MAX_HUMANS) return p.ctrl;
  for (let h = 0; h < MAX_HUMANS; h++) {
    const c = state.ctrl[h];
    if (c && c.slot === slot) return h;
  }
  return -1;
}

/**
 * Humans (bitmask, bit h = human h) whose pads feel a rumble of `kind` for `ev` (pure): goals and posts reach every
 * human; a hard tackle reaches the humans controlling the tackler (a) or the victim (b), else nobody.
 */
export function rumbleHumans(kind: RumbleKind, ev: Readonly<SimEvent>, state: ReadonlySimState): number {
  if (kind === RumbleKind.NONE) return 0;
  if (kind !== RumbleKind.HARD_TACKLE) return ALL_HUMANS;
  let mask = 0;
  const a = humanOf(state, ev.a);
  const b = humanOf(state, ev.b);
  if (a >= 0) mask |= 1 << a;
  if (b >= 0) mask |= 1 << b;
  return mask;
}

/** Duration of a profile in sim ticks (for the per-pad priority window). */
export function rumbleTicks(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.ceil((ms * TICK_HZ) / 1000) : 0;
}

// ============================================================ playing

interface ActuatorLike {
  effects?: unknown;
  playEffect?: (type: string, params: Record<string, number>) => unknown;
  reset?: () => unknown;
}
interface HapticLike {
  pulse?: (value: number, ms: number) => unknown;
}
interface PadWithActuators {
  vibrationActuator?: ActuatorLike | null;
  hapticActuators?: readonly (HapticLike | null | undefined)[] | null;
}

const noop = (): void => { /* unsupported effect or interrupted: nothing to do */ };

function unit(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

/** Swallow a rejected promise (Chrome rejects unsupported effects; a newer effect "preempts" the older one). */
function settle(r: unknown): void {
  if (r !== null && typeof r === 'object' && typeof (r as { then?: unknown }).then === 'function') {
    try {
      (r as Promise<unknown>).then(noop, noop);
    } catch {
      /* exotic thenable */
    }
  }
}

/** True when a vibrationActuator states that it cannot play 'dual-rumble'. */
function cannotDualRumble(act: ActuatorLike): boolean {
  const fx = act.effects;
  if (Array.isArray(fx)) return !fx.includes('dual-rumble');
  const type = (act as { type?: unknown }).type;
  return typeof type === 'string' && type !== 'dual-rumble';
}

/**
 * Play a rumble on a Gamepad object: strong / weak 0..1, duration ms. Returns true when an actuator was asked to
 * play. Never throws (no actuator, unsupported effect, throwing or rejecting implementations).
 */
export function playRumble(pad: Gamepad | null | undefined, strong: number, weak: number, ms: number): boolean {
  if (!pad) return false;
  const s = unit(strong), w = unit(weak);
  const d = Number.isFinite(ms) ? Math.max(0, Math.min(LOCAL_TUNING.maxMs, Math.round(ms))) : 0;
  if (d === 0 || (s === 0 && w === 0)) return false;
  const p = pad as unknown as PadWithActuators;
  try {
    const act = p.vibrationActuator;
    if (act && typeof act.playEffect === 'function' && !cannotDualRumble(act)) {
      settle(act.playEffect('dual-rumble', { startDelay: 0, duration: d, strongMagnitude: s, weakMagnitude: w }));
      return true;
    }
    const hap = p.hapticActuators;
    const h0 = hap && hap.length > 0 ? hap[0] : null;
    if (h0 && typeof h0.pulse === 'function') {
      settle(h0.pulse(Math.max(s, w), d));
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Stop a rumble in progress (vibrationActuator.reset where it exists). Never throws. */
export function stopRumble(pad: Gamepad | null | undefined): void {
  if (!pad) return;
  try {
    const act = (pad as unknown as PadWithActuators).vibrationActuator;
    if (act && typeof act.reset === 'function') settle(act.reset());
  } catch {
    /* nothing to stop */
  }
}

// ============================================================ per-pad rumble

/** A pad bound to a human for the current match (DotkickDeviceRegistry.boundPads() rows fit). */
export interface RumbleBinding {
  readonly deviceId: string;
  /** Human index, or -1 for "any human" (a registry that does not know the bindings). */
  readonly human: number;
  readonly connected: boolean;
}

export interface Rumble {
  /** Consume the events of the latest tick (goal, post, hard tackle) for pads bound to `human`. */
  onEvents(events: EventBuffer, state: ReadonlySimState): void;
  /** Play a rumble on one pad: strong/weak 0..1, duration ms. No-op when unsupported or disabled. */
  pulse(key: string, strong: number, weak: number, ms: number): void;
  setEnabled(on: boolean): void;
  /** Play the profile of `kind` on one pad (no priority window; same guards as pulse). Returns true if it played. */
  play(key: string, kind: RumbleKind): boolean;
  /** Stop every pad's rumble (pause menu, match end, toggle off). */
  stopAll(): void;
  readonly enabled: boolean;
}

export interface RumbleOptions {
  /** Pads bound to humans (default: every connected, active pad, for any human). Called only when an event rumbles. */
  bindings?: () => readonly RumbleBinding[];
}

/** Per pad: the priority window of the rumble playing (sim ticks). */
interface PadWindow {
  untilTick: number;
  kind: RumbleKind;
  lastTick: number;
}

export function createRumble(manager: PadManager, enabled = true, opts: RumbleOptions = {}): Rumble {
  let on = enabled;
  const windows: Record<string, PadWindow> = Object.create(null) as Record<string, PadWindow>;

  function bindings(): readonly RumbleBinding[] {
    if (opts.bindings) {
      try {
        return opts.bindings();
      } catch {
        return [];
      }
    }
    const out: RumbleBinding[] = [];
    const slots = manager.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      if (s.active) out.push({ deviceId: s.key, human: -1, connected: s.connected });
    }
    return out;
  }

  function padOf(key: string): Gamepad | null {
    const s = manager.find(key);
    return s && s.connected ? s.pad : null;
  }

  /** Play `kind` on a pad unless a stronger-or-equal rumble is still in its window. */
  function playAt(key: string, kind: RumbleKind, tick: number): void {
    let w = windows[key];
    if (!w) {
      w = { untilTick: -1, kind: RumbleKind.NONE, lastTick: -1 };
      windows[key] = w;
    }
    if (tick < w.lastTick) w.untilTick = -1; // a new match or a restart: the sim clock went back
    w.lastTick = tick;
    if (tick < w.untilTick && kind <= w.kind) return;
    const p = RUMBLE_PROFILES[kind];
    if (playRumble(padOf(key), p.strong, p.weak, p.ms)) {
      w.untilTick = tick + rumbleTicks(p.ms);
      w.kind = kind;
    }
  }

  const api: Rumble = {
    get enabled() { return on; },
    onEvents(events, state) {
      if (!on || !events || !state) return;
      const n = events.count;
      for (let i = 0; i < n; i++) {
        const ev = events.get(i);
        const kind = rumbleKindForEvent(ev);
        if (kind === RumbleKind.NONE) continue;
        const humans = rumbleHumans(kind, ev, state);
        if (humans === 0) continue;
        const list = bindings();
        for (let j = 0; j < list.length; j++) {
          const b = list[j]!;
          if (!b.connected || typeof b.deviceId !== 'string') continue;
          if (b.human >= 0 && (humans & (1 << b.human)) === 0) continue;
          playAt(b.deviceId, kind, ev.tick);
        }
      }
    },
    pulse(key, strong, weak, ms) {
      if (!on) return;
      playRumble(padOf(key), strong, weak, ms);
    },
    play(key, kind) {
      if (!on || kind === RumbleKind.NONE) return false;
      const p = RUMBLE_PROFILES[kind];
      return p !== undefined && playRumble(padOf(key), p.strong, p.weak, p.ms);
    },
    stopAll() {
      const slots = manager.slots;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!;
        if (s.connected) stopRumble(s.pad);
        const w = windows[s.key];
        if (w) w.untilTick = -1;
      }
    },
    setEnabled(v) {
      const was = on;
      on = v === true;
      if (was && !on) api.stopAll();
    },
  };
  return api;
}

// ============================================================ app wiring

/** Registry extras of PAD-01's DotkickDeviceRegistry (optional: a plain DeviceRegistry works too). */
interface RegistryExtras {
  readonly pads?: PadManager;
  boundPads?(): readonly RumbleBinding[];
}

type SettingsSource = Pick<SettingsStore, 'get'> & Partial<Pick<SettingsStore, 'subscribe'>>;

export interface RumbleListener {
  /** After every sim tick: rumble the bound pads for goals, posts and hard tackles (when the setting is on). */
  onEvents(events: EventBuffer, state: ReadonlySimState): void;
  /** Play a rumble kind on one pad now (respects the setting). */
  play(padKey: string, kind: RumbleKind): boolean;
  /** Stop every rumble (pause menu, match end). */
  stopAll(): void;
  /** settings.controls.pad.rumble. */
  readonly enabled: boolean;
  dispose(): void;
}

function rumbleSetting(s: Readonly<Settings> | null | undefined): boolean {
  return s?.controls?.pad?.rumble !== false;
}

/**
 * The app's rumble consumer: pads from the registry (bound pads; their Gamepad objects through the registry's pad
 * manager, else the shared one), the toggle from settings.controls.pad.rumble.
 */
export function createRumbleListener(
  registry: DeviceRegistry | (DeviceRegistry & RegistryExtras) | null,
  settings: SettingsSource | null,
  opts: { pads?: PadManager } = {},
): RumbleListener {
  const extras = (registry ?? {}) as RegistryExtras;
  const manager = opts.pads ?? extras.pads ?? getPadManager();
  const read = (): boolean => {
    try {
      return rumbleSetting(settings ? settings.get() : null);
    } catch {
      return true;
    }
  };
  const boundPads = typeof extras.boundPads === 'function' ? extras.boundPads.bind(registry) : null;
  const rumble = createRumble(manager, read(), boundPads ? { bindings: boundPads } : {});
  let unsub: (() => void) | null = null;
  if (settings && typeof settings.subscribe === 'function') {
    unsub = settings.subscribe((s) => rumble.setEnabled(rumbleSetting(s)));
  }
  let disposed = false;
  return {
    get enabled() { return rumble.enabled; },
    onEvents(events, state) {
      if (disposed) return;
      if (!unsub) rumble.setEnabled(read());
      rumble.onEvents(events, state);
    },
    play(padKey, kind) {
      if (disposed) return false;
      if (!unsub) rumble.setEnabled(read());
      return rumble.play(padKey, kind);
    },
    stopAll() {
      rumble.stopAll();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      rumble.stopAll();
      unsub?.();
      unsub = null;
    },
  };
}
