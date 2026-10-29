/** [FEEL-1] Before / after measurement runner: `npx tsx tests/scenario/feel-1-measure.ts [recv|drib|pass|shot]`. */
import { AssistLevel } from '../../src/contracts/enums';
import { crowdPassScenario, dribbleScenario, passScenario, receiveScenario, shotScenario, type ReceiveCase, type ShotStyle } from './feel-1-helpers';

const which = process.argv[2] ?? 'all';
const pct = (a: number, b: number): string => `${((100 * a) / Math.max(1, b)).toFixed(0)}%`;
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '-');

if (which === 'all' || which === 'recv') {
  const groups: [string, Partial<ReceiveCase>][] = [
    ['pass, sprint at ball (chase)', { kind: 'pass', mode: 'chase', sprint: true }],
    ['pass, jog at ball (chase)', { kind: 'pass', mode: 'chase', sprint: false }],
    ['pass, sprint fixed aim +-15deg', { kind: 'pass', mode: 'fixed', sprint: true }],
    ['pass, sprint, crossing path', { kind: 'pass', mode: 'cross', sprint: true }],
    ['loose, sprint at ball', { kind: 'loose', mode: 'chase', sprint: true }],
    ['loose, sprint fixed aim +-15deg', { kind: 'loose', mode: 'fixed', sprint: true }],
  ];
  for (const [name, g] of groups) {
    let n = 0, got = 0, kept = 0, clean = 0, heavy = 0, miss = 0, a30 = 0, na30 = 0, close = 0;
    for (const v of [9, 12, 15, 18]) for (const path of [-8, 0, 8]) for (const err of [-15, 0, 15]) for (const seed of [1, 2]) {
      const c = { ballSpeed: g.kind === 'loose' ? v * 0.5 : v, pathDeg: path, dist: 22, aimErrDeg: g.mode === 'chase' ? err / 3 : err, seed, ...g } as ReceiveCase;
      const r = receiveScenario(c);
      n++; if (r.got) got++; if (r.kept30) kept++;
      if (r.outcome === 'clean') clean++; else if (r.outcome === 'heavy') heavy++; else if (r.outcome === 'miss') miss++;
      if (Number.isFinite(r.after30)) { a30 += r.after30; na30++; }
      close += r.closest;
    }
    console.log(`RECV ${name.padEnd(34)} n=${n} got=${pct(got, n)} kept30=${pct(kept, n)} clean=${pct(clean, n)} heavy=${pct(heavy, n)} miss=${pct(miss, n)} closest=${f2(close / n)} after30=${f2(a30 / Math.max(1, na30))}`);
  }
}
if (which === 'all' || which === 'drib') {
  for (const style of ['walk', 'jog', 'sprint', 'r1'] as const) {
    for (const turn of [undefined, -90] as const) {
      const acc = { mean: 0, p90: 0, max: 0, lead: 0, speed: 0, kept: 0, touches: 0 };
      const N = 4;
      for (let seed = 1; seed <= N; seed++) {
        const r = dribbleScenario({ style, ticks: 240, seed, turnDeg: turn, turnAt: turn ? 150 : undefined });
        acc.mean += r.mean; acc.p90 += r.p90; acc.max = Math.max(acc.max, r.max); acc.lead += r.lead; acc.speed += r.speed; acc.kept += r.kept ? 1 : 0; acc.touches += r.touches;
      }
      console.log(`DRIB ${style.padEnd(6)} turn=${String(turn ?? 0).padEnd(3)} kept=${acc.kept}/${N} dist mean=${f2(acc.mean / N)} p90=${f2(acc.p90 / N)} max=${f2(acc.max)} lead=${f2(acc.lead / N)} speed=${f2(acc.speed / N)} touches/4s=${(acc.touches / N).toFixed(1)}`);
    }
  }
  for (const sk of [40, 90]) {
    const r = dribbleScenario({ style: 'sprint', ticks: 240, seed: 1, skill: sk });
    console.log(`DRIB sprint skill=${sk} mean=${f2(r.mean)} p90=${f2(r.p90)} max=${f2(r.max)} speed=${f2(r.speed)}`);
  }
}
if (which === 'all' || which === 'pass') {
  for (const assist of [AssistLevel.ASSISTED, AssistLevel.SEMI, AssistLevel.MANUAL]) {
    for (const off of [0, 15, 30, 45]) {
      let n = 0, reached = 0, tgt = 0, travel = 0, miss = 0, sp = 0;
      for (const dist of [12, 20, 28]) for (const hold of [3, 15, 30, 50]) for (const seed of [1, 2]) for (const sg of [1, -1]) {
        const r = passScenario({ offDeg: off * sg, dist, hold, assist, seed, decoyDeg: 75 * -sg, decoyDist: 25 });
        n++; if (r.reached) reached++; if (r.target === 7) tgt++;
        travel += r.travel / dist; miss += Number.isFinite(r.miss) ? r.miss : 30; sp += r.speed;
      }
      console.log(`PASS assist=${assist} off=${String(off).padEnd(2)} n=${n} reached=${pct(reached, n)} targeted=${pct(tgt, n)} travel/dist=${f2(travel / n)} miss=${f2(miss / n)} speed=${f2(sp / n)}`);
    }
  }
  for (const hold of [3, 15, 30, 50, 70]) {
    const r = passScenario({ offDeg: 0, dist: 15, hold, assist: AssistLevel.ASSISTED, seed: 1 });
    console.log(`PASS hold=${hold} 15m speed=${f2(r.speed)} reached=${r.reached} travel=${f2(r.travel)}`);
  }
}
if (which === 'all' || which === 'shot') {
  for (const style of ['normal', 'finesse', 'power', 'trivela', 'chip', 'low'] as ShotStyle[]) {
    for (const [x, z, aimZ] of [[30, -8, 2.5], [30, 8, -2.5], [34, 0, 2.5]] as const) {
      const r = shotScenario({ style, x, z, aimZ, hold: 20, seed: 3 });
      console.log(`SHOT ${style.padEnd(8)} from(${x},${z}) aim ${aimZ} kind=${r.kind} speed=${f2(r.speed)} curve=${f2(r.curve)} cross z=${f2(r.crossZ)} y=${f2(r.crossY)} t=${f2(r.time)}`);
    }
  }
}
if (which === 'all' || which === 'crowd') {
  for (const assist of [AssistLevel.ASSISTED, AssistLevel.SEMI]) for (const off of [0, 15, 30, 45]) {
    let n = 0, t = 0, r = 0;
    for (const hold of [3, 25, 50]) for (const seed of [1, 2, 3]) { const x = crowdPassScenario(off, hold, seed, assist); n += x.n; t += x.targeted; r += x.reached; }
    console.log(`CROWD assist=${assist} off=${String(off).padEnd(2)} n=${n} targeted=${pct(t, n)} reached=${pct(r, n)}`);
  }
}
