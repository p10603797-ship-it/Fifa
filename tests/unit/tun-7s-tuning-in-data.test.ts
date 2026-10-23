/**
 * [TUN-7S] TUN-1 (BRIEF §4 rule 6: every gameplay constant sits in contracts/tuning.ts with its unit and a comment):
 * no sim / AI module keeps a LOCAL_TUNING / *_TUNING object block or a TUNING-CR marker; the old names other code still
 * imports are the very tuning.ts objects (aliases, not copies that could drift); docs/TUNING.md lists every moved block.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as T from '../../src/contracts/tuning';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function sources(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (f.endsWith('.ts')) out.push(p);
  }
  return out;
}
const FILES = [...sources(join(ROOT, 'src/sim')), ...sources(join(ROOT, 'src/ai'))];

/** Old exported names kept as aliases (imported by tests / src/input / src/modes), with their tuning.ts block. */
const ALIASES: [string, string, keyof typeof T][] = [
  ['ai/cpu/carrier', 'LOCAL_TUNING', 'T_CARRIER'], ['ai/cpu/defending', 'DEFEND_TUNING', 'T_DEFENDING'],
  ['ai/cpu/levels', 'LOCAL_TUNING', 'T_STYLE'], ['ai/cpu/passing', 'LOCAL_TUNING', 'T_PASSING'],
  ['ai/cpu/shooting', 'LOCAL_TUNING', 'T_SHOOTING'], ['ai/defshape', 'DEFSHAPE_TUNING', 'T_DEF_SHAPE'],
  ['ai/press', 'PRESS_TUNING', 'T_PRESS'], ['ai/runs', 'LOCAL_TUNING', 'T_RUNS'],
  ['ai/setpieces', 'LOCAL_TUNING', 'T_SETPIECE_AI'], ['ai/steer', 'STEER_TUNING', 'T_STEER'],
  ['ai/support', 'LOCAL_TUNING', 'T_SUPPORT'], ['ai/tactics', 'TACTICS_TUNING', 'T_TACTICS'],
  ['ai/transition', 'LOCAL_TUNING', 'T_TRANSITION'], ['sim/ball/contact', 'BALL_CONTACT_TUNING', 'T_BALL_CONTACT'],
  ['sim/control/resolveShared', 'LOCAL_TUNING', 'T_RESOLVE'], ['sim/control/switching', 'SWITCH_TUNING', 'T_SWITCH'],
  ['sim/defend/tackle', 'LOCAL_TUNING', 'T_TACKLE_PLAY'], ['sim/keeper/distribution', 'LOCAL_TUNING', 'T_GK_DISTRIBUTION'],
  ['sim/keeper/handling', 'LOCAL_TUNING', 'T_GK_HANDLING'], ['sim/keeper/saveKinematics', 'LOCAL_TUNING', 'T_GK_SAVE'],
  ['sim/keeper/setpieces', 'LOCAL_TUNING', 'T_GK_SETPIECE'], ['sim/keeper/sweeper', 'LOCAL_TUNING', 'T_GK_SWEEP'],
  ['sim/kicks/aerial', 'AERIAL_TUNING', 'T_AERIAL_PLAY'], ['sim/kicks/kickCommon', 'KICK_TUNING', 'T_KICK'],
  ['sim/kicks/lob', 'LOCAL_TUNING', 'T_LOB'], ['sim/kicks/pass', 'LOCAL_TUNING', 'T_PASS_KICK'],
  ['sim/kicks/shot', 'LOCAL_TUNING', 'T_SHOT_KICK'], ['sim/kicks/skills', 'LOCAL_TUNING', 'T_SKILL_MOVES'],
  ['sim/kicks/through', 'LOCAL_TUNING', 'T_THROUGH'], ['sim/players/bodies', 'LOCAL_TUNING', 'T_BODY'],
  ['sim/players/firstTouch', 'LOCAL_TUNING', 'T_FIRST_TOUCH'], ['sim/players/locomotion', 'LOCAL_TUNING', 'T_LOCOMOTION'],
  ['sim/players/possession', 'LOCAL_TUNING', 'T_POSSESSION'], ['sim/rules/corner', 'LOCAL_TUNING', 'T_CORNER'],
  ['sim/rules/fouls', 'LOCAL_TUNING', 'T_FOUL_CALL'], ['sim/rules/freekick', 'LOCAL_TUNING', 'T_FREE_KICK'],
  ['sim/rules/goalkick', 'LOCAL_TUNING', 'T_GOAL_KICK'], ['sim/rules/machine', 'LOCAL_TUNING', 'T_MATCH_FLOW'],
  ['sim/rules/offside', 'LOCAL_TUNING', 'T_OFFSIDE'], ['sim/rules/penalty', 'LOCAL_TUNING', 'T_PENALTY'],
  ['sim/rules/practice', 'LOCAL_TUNING', 'T_PRACTICE'], ['sim/rules/restart', 'LOCAL_TUNING', 'T_RESTART'],
  ['sim/rules/shootout', 'LOCAL_TUNING', 'T_SHOOTOUT'], ['sim/rules/subs', 'LOCAL_TUNING', 'T_SUBS'],
  ['sim/rules/throwin', 'LOCAL_TUNING', 'T_THROW_IN'], ['sim/rules/watchdog', 'LOCAL_TUNING', 'T_WATCHDOG'],
];

describe('TUN-1 tuning lives in data', () => {
  it('no sim / AI file keeps a TUNING-CR marker or a LOCAL_TUNING / *_TUNING object literal', () => {
    const bad: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8');
      const rel = relative(ROOT, f);
      if (src.includes('TUNING-CR')) bad.push(`${rel}: TUNING-CR`);
      for (const m of src.matchAll(/^(?:export )?const ([A-Z_]*TUNING[A-Z_]*)\s*(?::[^=]+)?=\s*\{/gm)) bad.push(`${rel}: ${m[1]} block`);
    }
    expect(bad).toEqual([]);
  });

  it('old exported names are the tuning.ts objects themselves (aliases cannot drift)', async () => {
    for (const [mod, name, block] of ALIASES) {
      const m = await import(/* @vite-ignore */ join(ROOT, 'src', `${mod}.ts`)) as Record<string, unknown>;
      expect(m[name], `${mod} ${name}`).toBe(T[block]);
    }
  });

  it('the former loose constants read their tuning.ts values', async () => {
    const hooks = await import('../../src/sim/players/firstTouchHooks');
    expect(hooks.CHEST_REACH_MUL).toBe(T.T_FIRST_TOUCH.chestReachMul);
    const kin = await import('../../src/sim/keeper/saveKinematics');
    expect(kin.STAND_AXIS_LOW).toBe(T.T_GK_SAVE.standAxisLow);
  });

  it('docs/TUNING.md maps every moved block (old location -> new name)', () => {
    const doc = readFileSync(join(ROOT, 'docs/TUNING.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## TUN-1'));
    const names = new Set(ALIASES.map((a) => a[2] as string));
    for (const n of ['T_FLIGHT', 'T_JOBS', 'T_SHAPE', 'T_RESTART_COMMON', 'T_IDLE_CHASE']) names.add(n);
    for (const n of names) {
      expect(section, n).toContain(`\`${n}\``);
      expect(T[n as keyof typeof T], n).toBeDefined();
    }
  });
});
