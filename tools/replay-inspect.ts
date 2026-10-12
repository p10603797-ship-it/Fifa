/**
 * [FND-06] Replay inspector.
 *
 *   npx tsx tools/replay-inspect.ts <replay.json> [--every 600] [--events] [--types GOAL,PHASE_CHANGE]
 *                                   [--from T] [--to T] [--invariants core|all] [--inputs]
 *   npx tsx tools/replay-inspect.ts <a.replay.json> --compare <b.replay.json>
 *
 * Single replay: plays it, prints the state hash every N ticks (with the recorded hash where one exists), an
 * event log (optionally filtered by type and tick range), the human inputs, invariant failures, and the final
 * verdict (identical / diverged at tick T). Exit code 1 if playback diverges.
 * Compare: plays both replays in lockstep and prints the first tick whose inputs differ, the first tick whose
 * state hash differs, and the first differing state path there (diffState). Exit code 1 if they differ.
 */
import './lib/env';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { EventType, type EventBuffer } from '../src/contracts/events';
import { createInputFrame, INPUT_FIELDS, type InputFrame } from '../src/contracts/input';
import type { SimState } from '../src/contracts/state';
import { diffState } from '../src/sim/core/clone';
import { createEventBuffer } from '../src/sim/core/events';
import { hashHex, hashState } from '../src/sim/core/hash';
import { PACKED_FRAME_INTS } from '../src/sim/core/serialize';
import { createInvariantChecker } from '../src/sim/debug/invariants';
import { initMatch } from '../src/sim/init';
import { parseReplay, playReplay, replayFramesAt, type Replay } from '../src/sim/replay';
import { step } from '../src/sim/step';
import { bool, num, parseArgs, str } from './lib/args';
import { EVENT_NAMES } from './headless';

const SPEC = {
  every: 'number', events: 'boolean', types: 'string', from: 'number', to: 'number', invariants: 'string',
  inputs: 'boolean', compare: 'string', help: 'boolean',
} as const;

export function loadReplay(path: string): Replay {
  return parseReplay(readFileSync(path, 'utf8'));
}

function fmtEvent(e: { type: number; tick: number; a: number; b: number; c: number; d: number; x: number; y: number; z: number }): string {
  const name = EVENT_NAMES[e.type] ?? `#${e.type}`;
  const pos = e.x !== 0 || e.y !== 0 || e.z !== 0 ? ` @(${e.x.toFixed(2)}, ${e.y.toFixed(2)}, ${e.z.toFixed(2)})` : '';
  return `t=${e.tick} ${name} a=${e.a} b=${e.b} c=${+e.c.toFixed(4)} d=${e.d}${pos}`;
}

function fmtFrame(f: InputFrame): string {
  const parts: string[] = [];
  const r = f as unknown as Record<string, number>;
  for (const k of INPUT_FIELDS) {
    const v = r[k]!;
    if (v !== 0 && !(k === 'gSlot' && v === -1)) parts.push(`${k}=${k === 'buttons' || k === 'gFlags' ? `0x${v.toString(16)}` : v}`);
  }
  return parts.length > 0 ? parts.join(' ') : 'neutral';
}

function sameFrames(a: Replay, b: Replay, tick: number): boolean {
  const base = (tick - 1) * PACKED_FRAME_INTS;
  for (let i = 0; i < PACKED_FRAME_INTS; i++) if (a.frames[base + i] !== b.frames[base + i]) return false;
  return true;
}

export interface CompareResult {
  /** First tick whose recorded inputs differ, -1 none. */
  inputTick: number;
  /** First tick whose state hash differs, -1 none. */
  stateTick: number;
  /** diffState path at stateTick (or a config difference). */
  diff: string | null;
}

/** Play two replays in lockstep and find the first divergence. */
export function compareReplays(a: Replay, b: Replay): CompareResult {
  const res: CompareResult = { inputTick: -1, stateTick: -1, diff: null };
  const cfgA = JSON.stringify(a.config);
  const cfgB = JSON.stringify(b.config);
  if (cfgA !== cfgB) res.diff = `config differs: ${cfgA} vs ${cfgB}`;
  const sa = initMatch(JSON.parse(cfgA) as Replay['config']);
  const sb = initMatch(JSON.parse(cfgB) as Replay['config']);
  if (hashState(sa) !== hashState(sb)) {
    res.stateTick = 0;
    res.diff = (res.diff ? `${res.diff}; ` : '') + (diffState(sa, sb) ?? 'initial states differ');
    return res;
  }
  const ea = createEventBuffer();
  const eb = createEventBuffer();
  const fa: InputFrame[] = [createInputFrame(), createInputFrame()];
  const fb: InputFrame[] = [createInputFrame(), createInputFrame()];
  const scratch = new Int16Array(PACKED_FRAME_INTS);
  const n = Math.min(a.ticks, b.ticks);
  for (let t = 1; t <= n; t++) {
    if (res.inputTick < 0 && !sameFrames(a, b, t)) res.inputTick = t;
    replayFramesAt(a, t, fa, scratch);
    replayFramesAt(b, t, fb, scratch);
    step(sa, fa, ea);
    step(sb, fb, eb);
    if (hashState(sa) !== hashState(sb)) {
      res.stateTick = t;
      res.diff = diffState(sa, sb);
      return res;
    }
  }
  if (a.ticks !== b.ticks) res.diff = (res.diff ? `${res.diff}; ` : '') + `lengths differ: ${a.ticks} vs ${b.ticks} ticks`;
  return res;
}

function main(argv: readonly string[]): number {
  const { flags, positionals } = parseArgs(argv, SPEC);
  if (bool(flags, 'help') || positionals.length === 0) {
    console.log('usage: tsx tools/replay-inspect.ts <replay.json> [--every N] [--events] [--types A,B] [--from T] [--to T] [--invariants core|all] [--inputs] [--compare other.json]');
    return positionals.length === 0 && !bool(flags, 'help') ? 2 : 0;
  }
  const a = loadReplay(positionals[0]!);
  console.log(`replay ${positionals[0]}: sim v${a.simVersion}, seed ${a.seed}, ${a.ticks} ticks, final ${hashHex(a.finalHash)}, ${a.hashes.length} checkpoints / ${a.hashInterval} ticks`);
  console.log(`config ${JSON.stringify(a.config)}`);

  const other = str(flags, 'compare', '');
  if (other !== '') {
    const b = loadReplay(other);
    const c = compareReplays(a, b);
    console.log(`compare with ${other} (${b.ticks} ticks, final ${hashHex(b.finalHash)}):`);
    console.log(`  first differing input tick: ${c.inputTick < 0 ? 'none' : c.inputTick}`);
    console.log(`  first differing state tick: ${c.stateTick < 0 ? 'none' : c.stateTick}`);
    if (c.diff) console.log(`  difference: ${c.diff}`);
    return c.stateTick >= 0 || c.diff !== null ? 1 : 0;
  }

  const every = Math.max(0, Math.floor(num(flags, 'every', 600)));
  const from = num(flags, 'from', 0);
  const to = num(flags, 'to', Infinity);
  const showEvents = bool(flags, 'events') || typeof flags.types === 'string';
  const typeFilter = str(flags, 'types', '').split(',').map((x) => x.trim()).filter((x) => x !== '');
  const types = new Set<number>();
  for (const name of typeFilter) {
    const v = (EventType as unknown as Record<string, number | undefined>)[name];
    if (typeof v !== 'number') throw new Error(`unknown event type ${name}`);
    types.add(v);
  }
  const inv = str(flags, 'invariants', '');
  const checker = inv === 'core' || inv === 'all' ? createInvariantChecker(inv, { messageLimit: 50 }) : null;
  const showInputs = bool(flags, 'inputs');
  const frames: InputFrame[] = [createInputFrame(), createInputFrame()];

  const onTick = (s: SimState, ev: EventBuffer, tick: number): void => {
    const inRange = tick >= from && tick <= to;
    if (every > 0 && tick % every === 0) {
      const k = tick / a.hashInterval - 1;
      const rec = Number.isInteger(k) && k >= 0 && k < a.hashes.length ? ` recorded ${hashHex(a.hashes[k]!)}` : '';
      console.log(`t=${tick} hash ${hashHex(hashState(s))}${rec} phase ${s.match.phase} period ${s.match.period} clock ${s.match.periodT} score ${s.teams[0]!.goals}-${s.teams[1]!.goals}`);
    }
    if (inRange && showInputs) {
      replayFramesAt(a, tick, frames);
      const f0 = fmtFrame(frames[0]!);
      const f1 = fmtFrame(frames[1]!);
      if (f0 !== 'neutral' || f1 !== 'neutral') console.log(`t=${tick} input P1 ${f0} | P2 ${f1}`);
    }
    if (inRange && showEvents) {
      for (let i = 0; i < ev.count; i++) {
        const e = ev.get(i);
        if (types.size === 0 || types.has(e.type)) console.log(`  ${fmtEvent(e)}`);
      }
    }
    if (checker) for (const m of checker.check(s, ev)) console.log(`  INVARIANT ${m}`);
  };
  const res = playReplay(a, onTick);
  if (checker) console.log(`invariants (${inv}): ${checker.total} failure(s) ${JSON.stringify(checker.counts)}`);
  if (!res.squadsMatch) console.log('WARNING: squads differ from the recording (club data changed since); divergence is expected');
  console.log(`final hash ${hashHex(res.hash)} (recorded ${hashHex(a.finalHash)}): ${res.divergedAt < 0 ? 'IDENTICAL' : `DIVERGED at t=${res.divergedAt}`}`);
  return res.divergedAt < 0 ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  }
}
