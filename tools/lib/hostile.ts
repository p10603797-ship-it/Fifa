/**
 * [FND-06] Hostile input generators for the fuzz runner (brief section 14 point 3): button mashing, direction
 * flips every tick, every button at once, SKIP / command spam (Command.SUBSTITUTE with random args at every
 * stoppage), random gestures with out-of-range values, extreme axes, idle bursts (pause / release-all), and a
 * mixed generator that switches between them.
 *
 * Values stay inside what a replay can carry (int16 fields, uint16 bitfields; see serialize.packFrames) so every
 * fuzz match replays exactly; "out of range" means out of the documented ranges (axes beyond +-127, unknown enum
 * values, slots beyond 21, gesture points far off the pitch), not beyond int16.
 */
import { MatchPhase } from '../../src/contracts/enums';
import type { InputFrame } from '../../src/contracts/input';
import type { RngState, SimState } from '../../src/contracts/state';
import { createRng, rngChance, rngInt, rngIntIn } from './rand';

export const HOSTILE_KINDS = [
  'mash', 'flip', 'allButtons', 'skipSpam', 'commands', 'gestures', 'extremes', 'idle', 'mixed',
] as const;
export type HostileKind = (typeof HOSTILE_KINDS)[number];

/** Kinds the mixed generator switches between. */
const MIX_KINDS: readonly HostileKind[] = ['mash', 'flip', 'allButtons', 'skipSpam', 'commands', 'gestures', 'extremes', 'idle'];

export interface HostileGen {
  readonly kind: HostileKind;
  /** Fill the frame of this generator's human for the coming tick (frame already cleared). */
  fill(tick: number, s: SimState, out: InputFrame): void;
}

const INT16_MIN = -32768;
const INT16_MAX = 32767;
/** Every button bit defined by Btn (bits 0..10). */
const ALL_BTN = 0x7ff;
/** Command enum values reach 16; generators also send unknown ones. */
const CMD_MAX_VALID = 16;
const CMD_SKIP = 15;
const CMD_SUBSTITUTE = 9;
const BTN_SKIP = 1 << 9;

function int16(r: RngState): number {
  return rngInt(r, 65536) + INT16_MIN;
}

function axis(r: RngState): number {
  const roll = rngInt(r, 10);
  if (roll < 6) return rngIntIn(r, -127, 127);
  if (roll < 8) return rngChance(r, 0.5) ? 127 : -127;
  return rngChance(r, 0.5) ? INT16_MAX : INT16_MIN;
}

function isStoppage(s: SimState): boolean {
  return s.match.phase !== MatchPhase.IN_PLAY;
}

/** Random substitution argument: plausible (own team slot, bench index) or garbage. */
function subArg(r: RngState, s: SimState, side: number): number {
  if (rngChance(r, 0.6)) {
    const out = (side === 1 ? 11 : 0) + rngInt(r, 11);
    const inIdx = rngInt(r, 18);
    return out | (inIdx << 8);
  }
  return int16(r);
}

/** Side of the human this generator drives (falls back to 0). */
function sideOf(s: SimState, human: number): number {
  const c = s.ctrl[human];
  return c && (c.side === 0 || c.side === 1) ? c.side : 0;
}

function fillMash(r: RngState, out: InputFrame): void {
  out.buttons = rngInt(r, ALL_BTN + 1);
  out.mx = rngIntIn(r, -127, 127);
  out.mz = rngIntIn(r, -127, 127);
  out.ax = rngIntIn(r, -127, 127);
  out.az = rngIntIn(r, -127, 127);
  if (rngChance(r, 0.1)) out.skill = rngIntIn(r, 0, 13);
  if (rngChance(r, 0.2)) out.power = rngIntIn(r, 0, 127);
  if (rngChance(r, 0.1)) out.curve = rngIntIn(r, -127, 127);
}

function fillFlip(r: RngState, tick: number, held: number, out: InputFrame): void {
  const sgn = tick % 2 === 0 ? 1 : -1;
  out.mx = 127 * sgn;
  out.mz = tick % 4 < 2 ? 127 : -127;
  out.ax = -127 * sgn;
  out.az = 127 * sgn;
  out.buttons = held;
  if (rngChance(r, 0.05)) out.skill = rngIntIn(r, 1, 11);
}

function fillAllButtons(tick: number, out: InputFrame): void {
  // Everything held, released for one tick every 45 ticks (edges on every button at once).
  out.buttons = tick % 45 === 0 ? 0 : tick % 90 < 45 ? ALL_BTN : 0xffff;
  out.mx = 127;
  out.mz = -127;
  out.ax = -127;
  out.az = 127;
  out.power = 127;
  out.curve = 127;
}

function fillSkipSpam(r: RngState, s: SimState, side: number, out: InputFrame): void {
  out.buttons = BTN_SKIP | (rngChance(r, 0.3) ? rngInt(r, ALL_BTN + 1) : 0);
  if (isStoppage(s)) {
    out.cmd = rngChance(r, 0.7) ? CMD_SUBSTITUTE : CMD_SKIP;
    out.cmdArg = out.cmd === CMD_SUBSTITUTE ? subArg(r, s, side) : 0;
  } else if (rngChance(r, 0.3)) {
    out.cmd = rngIntIn(r, 0, CMD_MAX_VALID);
    out.cmdArg = int16(r);
  } else out.cmd = CMD_SKIP;
  out.mx = rngIntIn(r, -127, 127);
  out.mz = rngIntIn(r, -127, 127);
}

function fillCommands(r: RngState, s: SimState, side: number, out: InputFrame): void {
  if (isStoppage(s) && rngChance(r, 0.6)) {
    out.cmd = CMD_SUBSTITUTE;
    out.cmdArg = subArg(r, s, side);
  } else {
    out.cmd = rngIntIn(r, 0, CMD_MAX_VALID + 4); // includes unknown commands
    out.cmdArg = rngChance(r, 0.5) ? rngIntIn(r, -2, 20) : int16(r);
  }
  if (rngChance(r, 0.3)) out.buttons = rngInt(r, ALL_BTN + 1);
}

function fillGestures(r: RngState, out: InputFrame): void {
  out.gesture = rngIntIn(r, 0, 7); // 6, 7 are not GestureKinds
  const onPitch = rngChance(r, 0.5);
  out.gx = onPitch ? rngIntIn(r, -560, 560) : int16(r);
  out.gz = onPitch ? rngIntIn(r, -370, 370) : int16(r);
  out.gSlot = rngChance(r, 0.7) ? rngIntIn(r, -3, 30) : int16(r);
  out.gdx = axis(r);
  out.gdz = axis(r);
  out.gPower = rngChance(r, 0.7) ? rngIntIn(r, 0, 127) : int16(r);
  out.gCurve = rngChance(r, 0.7) ? rngIntIn(r, -127, 127) : int16(r);
  out.gFlags = rngInt(r, 65536);
  if (rngChance(r, 0.3)) out.buttons = rngInt(r, ALL_BTN + 1);
  out.mx = axis(r);
  out.mz = axis(r);
}

function fillExtremes(r: RngState, out: InputFrame): void {
  const ext = (): number => (rngChance(r, 0.5) ? INT16_MAX : INT16_MIN);
  out.mx = ext(); out.mz = ext(); out.ax = ext(); out.az = ext();
  out.buttons = rngChance(r, 0.5) ? 0xffff : rngInt(r, 65536);
  out.power = ext(); out.curve = ext(); out.skill = ext(); out.cmd = ext(); out.cmdArg = ext();
  out.gesture = ext(); out.gx = ext(); out.gz = ext(); out.gSlot = ext(); out.gdx = ext(); out.gdz = ext();
  out.gPower = ext(); out.gCurve = ext(); out.gFlags = 0xffff;
}

/**
 * Create a generator. `human` = controller index it drives (0 or 1; used to find its side for substitutions).
 */
export function createHostile(kind: HostileKind, seed: number, human: number): HostileGen {
  const r = createRng(seed);
  let held = 0;
  let holdLeft = 0;
  let cur: HostileKind = kind === 'mixed' ? MIX_KINDS[rngInt(r, MIX_KINDS.length)]! : kind;
  let switchLeft = rngIntIn(r, 30, 600);

  function fillKind(k: HostileKind, tick: number, s: SimState, out: InputFrame): void {
    const side = sideOf(s, human);
    switch (k) {
      case 'mash': fillMash(r, out); break;
      case 'flip':
        if (holdLeft-- <= 0) { held = rngInt(r, 256); holdLeft = rngIntIn(r, 1, 90); }
        fillFlip(r, tick, held, out);
        break;
      case 'allButtons': fillAllButtons(tick, out); break;
      case 'skipSpam': fillSkipSpam(r, s, side, out); break;
      case 'commands': fillCommands(r, s, side, out); break;
      case 'gestures': fillGestures(r, out); break;
      case 'extremes': fillExtremes(r, out); break;
      case 'idle': break;
      case 'mixed': break;
    }
  }

  return {
    kind,
    fill(tick, s, out) {
      if (kind === 'mixed' && switchLeft-- <= 0) {
        cur = MIX_KINDS[rngInt(r, MIX_KINDS.length)]!;
        switchLeft = rngIntIn(r, 30, 600);
      }
      fillKind(cur, tick, s, out);
    },
  };
}
