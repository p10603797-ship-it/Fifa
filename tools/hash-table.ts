/**
 * [TUN-7S] Behaviour-identity hash table for sim/AI refactors (tuning moves, performance work). Runs a fixed set of
 * headless matches (every difficulty, cup rules, every practice kind, shoot-out, human-scripted and hostile-input
 * matches, rule toggles) plus the first soak and fuzz jobs, and prints for each the end-of-run hashState and a rolling
 * digest of hashState sampled every DIGEST_EVERY ticks (catches a divergence that later re-converges).
 *
 *   npx tsx tools/hash-table.ts --out before.json            # record
 *   npx tsx tools/hash-table.ts --compare before.json        # re-run and diff (exit 1 on any difference)
 *   npx tsx tools/hash-table.ts --part 0/2 --out a.json      # split the table across processes
 */
import './lib/env';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  AssistLevel, AutoSwitch, ControllerKind, Difficulty, FormationId, MatchPhase, ModeId, PracticeKind,
} from '../src/contracts/enums';
import { Btn, type InputFrame } from '../src/contracts/input';
import { createMatchConfig, type MatchConfig, type SimState } from '../src/contracts/state';
import { hashHex, hashState } from '../src/sim/core/hash';
import { parseArgs, str } from './lib/args';
import { noHuman, soakConfig } from './lib/configs';
import { createHostile } from './lib/hostile';
import { fuzzInputs } from './lib/jobs';
import { defaultMaxTicks, runMatch, type InputsFn } from './headless';
import { fuzzJobs } from './fuzz';
import { soakJobs, soakOptionsFromArgs } from './soak';

/** Ticks between digest samples. */
const DIGEST_EVERY = 500;

interface Entry {
  name: string;
  config: MatchConfig;
  inputs?: () => InputsFn | undefined;
  fastCutscenes: boolean;
  maxTicks?: number;
}

function human(side: number, assist = AssistLevel.ASSISTED): MatchConfig['humans'][number] {
  return { kind: ControllerKind.HUMAN, side, assist, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 };
}

function base(seed: number, home: number, away: number, d: Difficulty, halfMinutes = 2): MatchConfig {
  const c = createMatchConfig();
  c.seed = seed >>> 0;
  c.homeClub = home;
  c.awayClub = away;
  c.homeFormation = FormationId.F442;
  c.awayFormation = FormationId.F433;
  c.difficulty = d;
  c.halfMinutes = halfMinutes;
  c.humans = [noHuman(), noHuman()];
  c.startPhase = MatchPhase.KICK_OFF;
  c.mode = ModeId.KICK_OFF;
  return c;
}

/** A plain scripted human: runs toward the opponent goal, sprints, shoots / passes / tackles on a fixed rhythm. */
function scriptedHuman(): InputsFn {
  return (tick: number, s: SimState, out: InputFrame[]) => {
    const f = out[0];
    if (!f) return;
    const phase = Math.floor(tick / 90) % 8;
    f.mx = phase < 4 ? 100 : phase < 6 ? 60 : -40;
    f.mz = ((tick >> 6) & 1) === 0 ? 40 : -50;
    let b = 0;
    if (phase !== 7) b |= Btn.SPRINT;
    const m = tick % 240;
    if (m >= 200 && m < 220) b |= Btn.SHOOT;
    if (m >= 120 && m < 126) b |= Btn.PASS;
    if (m >= 60 && m < 64) b |= Btn.MOD_L;
    if (s.match.phase !== MatchPhase.IN_PLAY && (tick & 31) === 0) b |= Btn.SKIP;
    f.buttons = b;
  };
}

function entries(): Entry[] {
  const e: Entry[] = [];
  const diffs = [Difficulty.BEGINNER, Difficulty.AMATEUR, Difficulty.SEMI_PRO, Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND];
  for (let i = 0; i < diffs.length; i++) {
    e.push({ name: `bot d${diffs[i]}`, config: base(1000 + i * 7919, i % 8, (i * 3 + 1) % 8, diffs[i]!), fastCutscenes: true });
  }
  { // Full-length default halves (4 min), Professional.
    const c = base(424242, 2, 5, Difficulty.PROFESSIONAL, 4);
    e.push({ name: 'bot d3 full 4-min halves', config: c, fastCutscenes: true });
  }
  { // Cup rules (extra time + shoot-out when level), two seeds.
    for (const seed of [77, 4040]) {
      const c = base(seed, 1, 6, Difficulty.WORLD_CLASS);
      c.cupRules = 1;
      c.mode = ModeId.CUP;
      e.push({ name: `cup seed ${seed}`, config: c, fastCutscenes: true });
    }
  }
  { // Rule toggles off.
    const c = base(9090, 3, 4, Difficulty.SEMI_PRO);
    c.offside = 0;
    c.fouls = 0;
    e.push({ name: 'no offside / no fouls', config: c, fastCutscenes: true });
  }
  { // Shoot-out mode.
    const c = base(31337, 0, 7, Difficulty.PROFESSIONAL);
    c.mode = ModeId.SHOOT_OUT;
    c.startPhase = MatchPhase.SHOOT_OUT;
    e.push({ name: 'shoot-out bot', config: c, fastCutscenes: true });
    const h = base(31338, 0, 7, Difficulty.PROFESSIONAL);
    h.mode = ModeId.SHOOT_OUT;
    h.startPhase = MatchPhase.SHOOT_OUT;
    h.humans = [human(0), noHuman()];
    e.push({ name: 'shoot-out human scripted', config: h, inputs: scriptedHuman, fastCutscenes: false });
  }
  { // Practice kinds with a scripted human.
    const kinds = [PracticeKind.FREE_PLAY, PracticeKind.FREE_KICKS, PracticeKind.CORNERS, PracticeKind.PENALTIES, PracticeKind.TUTORIAL];
    for (const k of kinds) {
      const c = base(5000 + k, 4, 2, Difficulty.AMATEUR);
      c.mode = ModeId.PRACTICE;
      c.practice = k;
      c.humans = [human(0), noHuman()];
      e.push({ name: `practice ${PracticeKind[k]}`, config: c, inputs: scriptedHuman, fastCutscenes: false, maxTicks: 2 * 60 * 60 });
    }
  }
  { // Human-scripted kick-off match (manual assist) and a hostile mixed-input human pair.
    const c = base(2024, 5, 1, Difficulty.LEGEND);
    c.humans = [human(0, AssistLevel.MANUAL), noHuman()];
    e.push({ name: 'human scripted v Legend', config: c, inputs: scriptedHuman, fastCutscenes: false });
    const h = base(8080, 6, 3, Difficulty.BEGINNER);
    h.humans = [human(0), human(1, AssistLevel.SEMI)];
    h.mode = ModeId.FRIEND_LOCAL;
    e.push({
      name: 'hostile mixed p1 v p2', config: h, fastCutscenes: false,
      inputs: () => {
        const g0 = createHostile('mixed', 0xabc, 0);
        const g1 = createHostile('mash', 0xdef, 1);
        return (tick, s, out) => { g0.fill(tick, s, out[0]!); g1.fill(tick, s, out[1]!); };
      },
    });
  }
  // First soak and fuzz jobs (the determinism checks of tools/soak.ts and tools/fuzz.ts use job 0).
  const so = soakOptionsFromArgs(['--matches', '3', '--seed', '1', '--halfMinutes', '2']);
  for (const j of soakJobs(so)) e.push({ name: `soak #${j.index}`, config: j.config, fastCutscenes: true });
  const fo = { matches: 6, workers: 1, seed: 1, enforce: 'all' as const, halfMinutes: 2, json: null, maxReplays: 0, only: null, quiet: true, jobTimeoutSeconds: null };
  for (const j of fuzzJobs(fo)) {
    const plan = j.fuzz!;
    const quit = plan.quitAt > 0 ? plan.quitAt : undefined;
    e.push({ name: `fuzz #${j.index}${quit ? ` quit@${quit}` : ''}`, config: j.config, fastCutscenes: false, inputs: () => fuzzInputs(plan, 0), ...(quit ? { maxTicks: quit } : {}) });
  }
  void soakConfig;
  return e;
}

interface Row { name: string; ticks: number; phase: number; hash: string; digest: string; ms: number }

function run(en: Entry): Row {
  let digest = 0x811c9dc5;
  const t0 = performance.now();
  const r = runMatch({
    config: en.config, inputs: en.inputs ? en.inputs() : undefined, checker: 'none', fastCutscenes: en.fastCutscenes,
    maxTicks: en.maxTicks ?? defaultMaxTicks(en.config),
    onTick: (s) => {
      if (s.tick % DIGEST_EVERY === 0) digest = Math.imul(digest ^ hashState(s), 0x01000193) >>> 0;
    },
  });
  if (r.exception) throw new Error(`${en.name}: exception ${r.exception.message} at ${r.exception.tick}\n${r.exception.stack}`);
  return { name: en.name, ticks: r.ticks, phase: r.endPhase, hash: hashHex(r.hash), digest: hashHex(digest), ms: Math.round(performance.now() - t0) };
}

function main(): void {
  const { flags } = parseArgs(process.argv.slice(2), { out: 'string', compare: 'string', part: 'string', only: 'string' } as const);
  const out = str(flags, 'out', '');
  const compare = str(flags, 'compare', '');
  const part = str(flags, 'part', '0/1').split('/').map(Number);
  const only = str(flags, 'only', '');
  const all = entries();
  const rows: Row[] = [];
  for (let i = 0; i < all.length; i++) {
    if (i % part[1]! !== part[0]) continue;
    if (only && !all[i]!.name.includes(only)) continue;
    const row = run(all[i]!);
    rows.push(row);
    console.log(`${row.name.padEnd(30)} ticks ${String(row.ticks).padStart(6)} phase ${String(row.phase).padStart(2)} hash ${row.hash} digest ${row.digest} (${row.ms} ms)`);
  }
  if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  if (compare) {
    const ref = JSON.parse(readFileSync(compare, 'utf8')) as Row[];
    let bad = 0;
    for (const row of rows) {
      const r = ref.find((x) => x.name === row.name);
      // [TUN-7S skeptic] A run the reference lacks (renamed / new entry) is a difference, not a silent skip: a compare
      // that silently ran fewer comparable rows still printed "IDENTICAL".
      if (!r) { bad++; console.log(`MISSING in reference: ${row.name}`); continue; }
      if (r.hash !== row.hash || r.digest !== row.digest || r.ticks !== row.ticks) {
        bad++;
        console.log(`DIFF ${row.name}: ref ${r.hash}/${r.digest}/${r.ticks} now ${row.hash}/${row.digest}/${row.ticks}`);
      }
    }
    console.log(bad === 0 ? `hash table IDENTICAL (${rows.length} runs)` : `hash table DIFFERS in ${bad}/${rows.length} runs`);
    process.exit(bad === 0 ? 0 : 1);
  }
}

main();
