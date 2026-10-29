/** [FEEL-2] Trace one vsDefender scene: `npx tsx tests/scenario/feel-2-trace.ts style level seed lat weave [skill]`. */
import { AssistLevel, AutoSwitch, MatchPhase, type Difficulty } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { makeScenario, runTicks } from '../harness/scenario';
import { CB, HS } from './feel-2-helpers';
import { DEFEND_DEBUG } from '../../src/ai/cpu/defending';

const [style, lv, seed, lat, weave] = [process.argv[2] ?? 'r1', Number(process.argv[3] ?? 5), Number(process.argv[4] ?? 1), Number(process.argv[5] ?? 0), Number(process.argv[6] ?? 0.4)];
const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, config: { difficulty: lv as Difficulty }, humans: [{ side: 0, slot: HS, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }] });
for (let i = 0; i < 22; i++) { if (i === HS || i === 0 || i === 11 || i === CB) continue; const p = s.players[i]!; if (i < 11) { p.x = -48; p.z = -30 + i * 6; } else { p.x = -40 + (i - 11) * 7; p.z = 32; } p.vx = 0; p.vz = 0; }
const p = s.players[HS]!; p.x = -20; p.z = 0; p.fx = 1; p.fz = 0;
if (process.argv[7]) { const a = s.attrs[HS]!; a.dribbling = a.ballControl = a.agility = Number(process.argv[7]); }
const d = s.players[CB]!; d.x = -6; d.z = lat; d.vx = 0; d.vz = 0; d.fx = -1; d.fz = 0;
Object.assign(s.ball, { x: -19.5, y: 0.11, z: 0, px: -19.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
runTicks(s, 360, (_t, st, out) => {
  const f = out[0]!; const q = st.players[HS]!, dd = st.players[CB]!;
  let dz = 0; if (dd.x - q.x < 6 && dd.x - q.x > -1) dz = q.z >= dd.z ? weave : -weave;
  const l = Math.hypot(1, dz); f.mx = Math.round(127 / l); f.mz = Math.round((dz / l) * 127);
  f.buttons |= style === 'sprint' ? Btn.SPRINT : Btn.MOD_R;
}, { until: (st, ev) => {
  const q = st.players[HS]!, dd = st.players[CB]!, b = st.ball;
  const c = dd.ctrl >= 0 ? st.ctrl[dd.ctrl]! : undefined;
  const evs = ev.filter((e) => e.type === EventType.TACKLE || e.type === EventType.FOUL || e.type === EventType.BODY_CONTACT || e.type === EventType.ADVANTAGE).map((e) => `${EventType[e.type]}(${e.a},${e.b},${e.c},${e.d})`).join(' ');
  if (st.tick % 4 === 0 || evs) console.log(`t=${st.tick} Q(${q.x.toFixed(2)},${q.z.toFixed(2)} v${Math.hypot(q.vx, q.vz).toFixed(1)}) B(${(b.x - q.x).toFixed(2)},${(b.z - q.z).toFixed(2)} own${b.owner}) D(${dd.x.toFixed(2)},${dd.z.toFixed(2)} v${dd.vx.toFixed(1)},${dd.vz.toFixed(1)} act${dd.act} ctrl${dd.ctrl} btn${c?.buttons ?? -1} st${c ? c.mx.toFixed(2) + ',' + c.mz.toFixed(2) : ''}) ${evs} why${DEFEND_DEBUG.why1}`);
  if (b.owner !== HS) return true; if (q.x > dd.x + 4) return true; return false; } });
