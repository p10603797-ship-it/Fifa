/**
 * [FIN-P] Per-tick stage breakdown of the benchmark match in Node (diagnostic, not a test). Steps the bench match
 * (benchSetup(seed), CPU v CPU, World Class) with a copy of step()'s pipeline in which every stage (and every team AI
 * sub-stage) is timed with performance.now(), checks the copy against the real step() (same hashState at the end), and
 * prints per stage: mean / p99 / max us, and the stage mix of the slowest 1 % of ticks. Optional --paced: a ~2 MB
 * cache-thrashing loop between ticks (the browser renders a frame between ticks; cold-cache cost).
 *
 *   node --import tsx tests/perf/fin-p-stage-probe.ts [--seed N] [--ticks 5400] [--warm 300] [--paced]
 */
import '../../tools/lib/env';
import { writeFileSync } from 'node:fs';
import { MatchPhase } from '../../src/contracts/enums';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { RESTART_PHASES } from '../../src/contracts/transitions';
import { T_DRIBBLE, T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { BENCH_DEFAULTS, benchSetup } from '../../src/platform/benchHook';
import { cpuSetPiece } from '../../src/ai/setpieces';
import { cpuCarrier } from '../../src/ai/cpu/carrier';
import { cpuDefend } from '../../src/ai/cpu/defending';
import { possessingTeam } from '../../src/sim/core/query';
import { resolveControllers } from '../../src/sim/control/resolve';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { bodyContactTick } from '../../src/sim/players/bodies';
import { ballTick } from '../../src/sim/ball/contact';
import { contactsTick } from '../../src/sim/contacts';
import { rulesTick } from '../../src/sim/rules/machine';
import { practiceRulesTick } from '../../src/sim/rules/practice';
import { watchdogTick } from '../../src/sim/rules/watchdog';
import { keeperTick } from '../../src/sim/keeper';
import { resetJobs } from '../../src/ai/jobs';
import { updateShape } from '../../src/ai/shape';
import { assignSupport } from '../../src/ai/support';
import { assignRuns } from '../../src/ai/runs';
import { assignDefensiveShape } from '../../src/ai/defshape';
import { assignPressing } from '../../src/ai/press';
import { assignTransition, updateTeamPhase } from '../../src/ai/transition';
import { assignChaser, executeJobs } from '../../src/ai/steer';
import { setPiecePositions } from '../../src/ai/setpieces';
import { receiverAssist, tacticsTick } from '../../src/ai/tactics';
import { clearInputFrame as clr } from '../../src/contracts/input';
import type { EventBuffer } from '../../src/contracts/events';

const argv = process.argv.slice(2);
const at = (k: string, d: string): string => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };
const SEED = Number(at('seed', String(BENCH_DEFAULTS.seed)));
const TICKS = Number(at('ticks', '5400'));
const WARM = Number(at('warm', '300'));
const JIT_WARM = Number(at('jitwarm', '3000'));
const PACED = argv.includes('--paced');

const STAGES = ['cpuSetPiece', 'cpuCarrier', 'cpuDefend', 'resolve', 'phase', 'tactics', 'shape', 'resetJobs', 'setPiecePos',
  'chaser', 'defShape', 'press', 'transition', 'support', 'runs', 'recvAssist', 'keeper', 'execJobs', 'actions', 'loco',
  'bodies', 'ball', 'contacts', 'rules', 'practice', 'watchdog', 'tail'] as const;
const NS = STAGES.length;
const S: Record<string, number> = {};
STAGES.forEach((n, i) => { S[n] = i; });
const now = (): number => performance.now();
const cur = new Float64Array(NS);
let last = 0;
function mark(i: number): void { const t = now(); cur[i]! += t - last; last = t; }

const LIE2 = T_RULES.ballLieSpeed * T_RULES.ballLieSpeed;
const DEAD_REACH2 = (T_DRIBBLE.controlRadius + T_RULES.passDeadReach) ** 2;

function timedStep(s: SimState, frames: ReturnType<typeof createInputFrame>[], ev: EventBuffer): void {
  s.tick++;
  ev.begin(s.tick);
  const m = s.match;
  m.phaseT++;
  s.ball.cross = 0;
  cur.fill(0);
  last = now();
  const phase0 = m.phase;
  for (let team = 0; team < 2; team++) {
    const brain = s.teams[team]!.cpu;
    if (brain.active !== 1) continue;
    clr(brain.out);
    if (RESTART_PHASES.includes(phase0) || phase0 === MatchPhase.SHOOT_OUT) { cpuSetPiece(s, team, brain.out, ev); mark(S.cpuSetPiece!); }
    else if (phase0 === MatchPhase.IN_PLAY) {
      if (possessingTeam(s) === team) { cpuCarrier(s, team, brain.out, ev); mark(S.cpuCarrier!); }
      else { cpuDefend(s, team, brain.out, ev); mark(S.cpuDefend!); }
    }
  }
  resolveControllers(s, frames, ev); mark(S.resolve!);
  const phase = s.match.phase;
  const restart = RESTART_PHASES.includes(phase) || phase === MatchPhase.SHOOT_OUT;
  for (let team = 0; team < 2; team++) {
    updateTeamPhase(s, team, ev); mark(S.phase!);
    tacticsTick(s, team, ev); mark(S.tactics!);
    updateShape(s, team, ev); mark(S.shape!);
    resetJobs(s, team);
    if (phase !== MatchPhase.IN_PLAY) { const t = s.teams[team]!; t.pressSlot = -1; t.coverSlot = -1; }
    mark(S.resetJobs!);
    if (restart) { setPiecePositions(s, team, ev); mark(S.setPiecePos!); }
    else if (phase === MatchPhase.IN_PLAY) {
      assignChaser(s, team, ev); mark(S.chaser!);
      assignDefensiveShape(s, team, ev); mark(S.defShape!);
      assignPressing(s, team, ev); mark(S.press!);
      assignTransition(s, team, ev); mark(S.transition!);
      assignSupport(s, team, ev); mark(S.support!);
      assignRuns(s, team, ev); mark(S.runs!);
      receiverAssist(s, team, ev); mark(S.recvAssist!);
    }
    keeperTick(s, team, ev); mark(S.keeper!);
    executeJobs(s, team, ev); mark(S.execJobs!);
  }
  actionsTick(s, ev); mark(S.actions!);
  locomotionTick(s, ev); mark(S.loco!);
  bodyContactTick(s, ev); mark(S.bodies!);
  ballTick(s, ev); mark(S.ball!);
  contactsTick(s, ev); mark(S.contacts!);
  rulesTick(s, ev); mark(S.rules!);
  practiceRulesTick(s, ev); mark(S.practice!);
  watchdogTick(s, ev); mark(S.watchdog!);
  const b = s.ball;
  if (b.owner >= 0 && b.heldBy < 0) b.idleT = 0;
  else if (m.phase === MatchPhase.IN_PLAY && b.touchedTick !== s.tick && (b.heldBy >= 0 || b.vx * b.vx + b.vz * b.vz < LIE2)) b.idleT++;
  if (b.passTarget >= 0 && b.idleT >= T_RULES.passDeadTicks && b.owner < 0 && b.heldBy < 0) {
    const r = b.passTarget;
    let keep = false;
    if (r < 22 && (r | 0) === r) {
      const p = s.players[r]!;
      if (p.active === 1) {
        const dx = b.x - p.x, dz = b.z - p.z;
        const d2 = dx * dx + dz * dz;
        if (d2 <= DEAD_REACH2) keep = true;
        else { const toward = p.vx * dx + p.vz * dz; if (toward > 0 && toward * toward >= LIE2 * d2) keep = true; }
      }
    }
    if (!keep) b.passTarget = -1;
  }
  mark(S.tail!);
}

const thrash = new Float64Array(1 << 18); // 2 MB
function coldCache(): void {
  let acc = 0;
  for (let k = 0; k < thrash.length; k += 8) { thrash[k] = thrash[k]! + 1; acc += thrash[k]!; }
  if (acc < 0) console.log(acc);
}

function run(): void {
  const frames = [createInputFrame(), createInputFrame()];
  const ev = createEventBuffer();
  // JIT warm-up: one other match (the browser measures after 300+ ticks of the first match; the code is warm-ish).
  const w = initMatch(benchSetup(SEED + 1).config);
  for (let t = 0; t < JIT_WARM; t++) { clearInputFrame(frames[0]!); clearInputFrame(frames[1]!); timedStep(w, frames, ev); }
  const s = initMatch(benchSetup(SEED).config);
  const ref = initMatch(benchSetup(SEED).config);
  const per = new Float64Array(TICKS * NS);
  const tot = new Float64Array(TICKS);
  const ph = new Uint8Array(TICKS);
  for (let t = 0; t < WARM + TICKS; t++) {
    clearInputFrame(frames[0]!); clearInputFrame(frames[1]!);
    if (PACED) coldCache();
    const t0 = now();
    timedStep(s, frames, ev);
    const dt = now() - t0;
    if (t >= WARM) {
      const i = t - WARM;
      tot[i] = dt * 1000;
      ph[i] = s.match.phase;
      for (let k = 0; k < NS; k++) per[i * NS + k] = cur[k]! * 1000;
    }
  }
  for (let t = 0; t < WARM + TICKS; t++) { clearInputFrame(frames[0]!); clearInputFrame(frames[1]!); step(ref, frames, ev); }
  const same = hashState(s) === hashState(ref);
  const order = Array.from(tot.keys()).sort((a, b) => tot[b]! - tot[a]!);
  const sorted = Array.from(tot).sort((a, b) => a - b);
  const pct = (q: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  console.log(`seed ${SEED} ticks ${TICKS} (after ${WARM}) paced ${PACED} pipeline copy matches step(): ${same}`);
  console.log(`tick us: mean ${(sorted.reduce((a, b) => a + b, 0) / TICKS).toFixed(1)} p50 ${pct(0.5).toFixed(1)} p90 ${pct(0.9).toFixed(1)} p99 ${pct(0.99).toFixed(1)} p99.7 ${pct(0.997).toFixed(1)} max ${pct(1).toFixed(1)}`);
  const top = order.slice(0, Math.max(1, Math.round(TICKS * 0.01)));
  const rows: string[] = [];
  for (let k = 0; k < NS; k++) {
    const v: number[] = [];
    for (let i = 0; i < TICKS; i++) v.push(per[i * NS + k]!);
    const mean = v.reduce((a, b) => a + b, 0) / TICKS;
    const vs = v.slice().sort((a, b) => a - b);
    let topMean = 0;
    for (const i of top) topMean += per[i * NS + k]!;
    topMean /= top.length;
    rows.push(`${STAGES[k]!.padEnd(12)} mean ${mean.toFixed(1).padStart(6)} p99 ${vs[Math.ceil(0.99 * TICKS) - 1]!.toFixed(1).padStart(7)} max ${vs[TICKS - 1]!.toFixed(1).padStart(7)} | in top 1% ticks: ${topMean.toFixed(1).padStart(7)}`);
  }
  console.log(rows.join('\n'));
  const dump = at('dump', '');
  if (dump) {
    const rows: [number, number][] = [];
    for (let i = 0; i < TICKS; i++) rows.push([i + WARM + 1, Math.round(tot[i]!)]);
    writeFileSync(dump, JSON.stringify(rows));
  }
  const show = at('show', '');
  if (show) {
    console.log('requested ticks:');
    for (const tk of show.split(',').map(Number)) {
      const i = tk - WARM - 1;
      if (i < 0 || i >= TICKS) continue;
      const st: [string, number][] = [];
      for (let k = 0; k < NS; k++) st.push([STAGES[k]!, per[i * NS + k]!]);
      st.sort((a, b) => b[1] - a[1]);
      console.log(`  ${tk} ${tot[i]!.toFixed(0)} ph${ph[i]} ${st.slice(0, 5).map(([n, v]) => `${n} ${v.toFixed(0)}`).join(', ')}`);
    }
  }
  console.log('slowest ticks (tick, us, phase, top stages):');
  for (const i of order.slice(0, 25)) {
    const st: [string, number][] = [];
    for (let k = 0; k < NS; k++) st.push([STAGES[k]!, per[i * NS + k]!]);
    st.sort((a, b) => b[1] - a[1]);
    console.log(`  ${i + WARM + 1} ${tot[i]!.toFixed(0)} ph${ph[i]} ${st.slice(0, 4).map(([n, v]) => `${n} ${v.toFixed(0)}`).join(', ')}`);
  }
}
run();
