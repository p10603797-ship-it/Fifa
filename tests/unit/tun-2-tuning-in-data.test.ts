/**
 * [TUN-2] Tuning in data, last pass (BRIEF §4 rule 6): no TUNING-CR marker is left in src; the input, modes and
 * formation-remap blocks live in contracts/tuning.ts and the old names other code imports are those very objects
 * (aliases cannot drift); the non-gameplay local blocks carry the `LOCAL_TUNING (non-gameplay: ...)` marker; the
 * set-piece spot templates read T_SETPIECE_SPOTS (no inline coordinates come back); docs/TUNING.md maps the moves.
 * Behaviour identity itself is proven by tools/hash-table.ts (28 runs) and a deep Object.is value comparison against
 * the pristine tree (docs/TUNING.md "TUN-2").
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

/** Old exported names kept as aliases, with their tuning.ts block. */
const ALIASES: [string, string, keyof typeof T][] = [
  ['input/touch/stick', 'LOCAL_TUNING', 'T_TOUCH_STICK'], ['input/touch/button', 'LOCAL_TUNING', 'T_TOUCH_BUTTON'],
  ['input/touch/attack', 'LOCAL_TUNING', 'T_TOUCH_ATTACK'], ['input/touch/gestures', 'LOCAL_TUNING', 'T_TOUCH_GESTURES'],
  ['input/touch/mapper', 'LOCAL_TUNING', 'T_TOUCH_MAPPER'], ['input/touch/setpiece', 'LOCAL_TUNING', 'T_TOUCH_SETPIECE'],
  ['input/touch/overlay', 'OVERLAY_TUNING', 'T_TOUCH_OVERLAY'], ['input/touch/editor', 'EDITOR_TUNING', 'T_TOUCH_EDITOR'],
  ['input/pad/mapper', 'MAPPER_TUNING', 'T_PAD_MAPPER'], ['input/pad/rightStick', 'RIGHT_STICK_TUNING', 'T_PAD_RIGHT_STICK'],
  ['input/pad/sequences', 'PAD_SEQUENCE_TUNING', 'T_PAD_SEQUENCES'], ['input/pad/rumble', 'RUMBLE_TUNING', 'T_PAD_RUMBLE'],
  ['input/keyboard', 'KEYBOARD_TUNING', 'T_KEYBOARD'], ['input/menuInput', 'MENU_TUNING', 'T_MENU_INPUT'],
  ['modes/practice', 'LOCAL_TUNING', 'T_PRACTICE_MODE'], ['modes/cup', 'QUICK', 'T_CUP_QUICK'],
];

/** Modules whose values stay local on purpose (not gameplay), with the TUN-2 marker. */
const NON_GAMEPLAY = [
  'render/goals', 'render/kit/crest', 'render/players/model', 'render/players/fk', 'render/crowd', 'render/stadium',
  'render/warmScript', 'render/quality', 'render/markers', 'render/replay', 'render/ball', 'render/anim/locomotion',
  'render/anim/mapper', 'render/anim/reach', 'render/effects', 'render/pitch', 'render/camera/broadcast',
  'render/camera/cinematic', 'render/kits', 'audio/bank', 'audio/eventMap', 'audio/crowd', 'audio/ui', 'audio/whistles',
  'audio/sfx', 'audio/engine', 'audio/voices', 'ui/screens/remap', 'ui/screens/diagnostics', 'ui/screens/pause',
  'net/lobby', 'net/lockstep', 'net/session', 'net/adaptive', 'platform/replayRecorder', 'platform/storage',
  'platform/pwa', 'platform/recovery', 'platform/settingsStore', 'data/names', 'data/playerGen', 'data/tactics',
  'data/kits', 'app/session', 'modes/stats',
];

describe('TUN-2 tuning lives in data (last pass)', () => {
  it('no src file keeps a TUNING-CR marker', () => {
    const bad = sources(join(ROOT, 'src')).filter((f) => readFileSync(f, 'utf8').includes('TUNING-CR'));
    expect(bad.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('input / modes / formation-remap modules keep no object-literal tuning block', () => {
    const files = [...sources(join(ROOT, 'src/input')), ...['modes/practice', 'modes/cup', 'data/formations'].map((m) => join(ROOT, 'src', `${m}.ts`))];
    const bad: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/^(?:export )?const ([A-Z_]*TUNING[A-Z_]*|QUICK)\s*(?::[^=]+)?=\s*\{/gm)) bad.push(`${relative(ROOT, f)}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });

  it('old exported names are the tuning.ts objects themselves', async () => {
    for (const [mod, name, block] of ALIASES) {
      const m = await import(/* @vite-ignore */ join(ROOT, 'src', `${mod}.ts`)) as Record<string, unknown>;
      expect(m[name], `${mod} ${name}`).toBe(T[block]);
    }
    const mgr = await import('../../src/input/pad/manager');
    expect(mgr.PAD_TRIGGER_RELEASE).toBe(T.T_PAD_TRIGGER.triggerRelease);
    const stick = await import('../../src/input/touch/stick');
    expect(stick.STICK_DEAD_ZONE).toBe(T.T_TOUCH_STICK.deadZone);
    expect(T.T_TOUCH_SETPIECE.ballPt).toBe(T.T_TOUCH_GESTURES.fromBallPt);
    expect(T.T_PRACTICE_MODE.attemptTicks).toBe(T.T_PRACTICE.attemptTicks);
  });

  it('non-gameplay local blocks carry the LOCAL_TUNING (non-gameplay: ...) marker', () => {
    const bad: string[] = [];
    for (const m of NON_GAMEPLAY) {
      const src = readFileSync(join(ROOT, 'src', `${m}.ts`), 'utf8');
      if (!/LOCAL_TUNING \(non-gameplay: [^)]+\)/.test(src)) bad.push(m);
    }
    expect(bad).toEqual([]);
  });

  it('set-piece spot templates read T_SETPIECE_SPOTS (no inline coordinates or weights)', () => {
    const src = readFileSync(join(ROOT, 'src/ai/setpieces.ts'), 'utf8');
    const calls = [...src.matchAll(/\btpl\(R\.\w+, S_\w+, ([^,]+), ([^,]+), ([^)]+)\)/g)];
    expect(calls.length).toBeGreaterThan(50);
    const bad = calls.filter((c) => [c[1], c[2], c[3]].some((a) => !/^(0|SP\.\S+|CRW|T_SETPIECE_AI\.cornerRunWd)$/.test(a!.trim())));
    expect(bad.map((c) => c[0])).toEqual([]);
    expect(T.T_SETPIECE_SPOTS.cornerX1).toHaveLength(5);
    expect(T.T_SETPIECE_SPOTS.cornerX2).toHaveLength(5);
    expect(T.T_SETPIECE_SPOTS.penAttack).toHaveLength(6);
    expect(T.T_SETPIECE_SPOTS.penDefend).toHaveLength(5);
  });

  it('docs/TUNING.md maps the TUN-2 moves (old location -> new name)', () => {
    const doc = readFileSync(join(ROOT, 'docs/TUNING.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## TUN-2'));
    expect(doc.indexOf('## TUN-2')).toBeGreaterThan(0);
    const names = new Set<string>(ALIASES.map((a) => a[2] as string));
    for (const n of ['T_PAD_TRIGGER', 'T_FORMATION_REMAP', 'T_SETPIECE_SPOTS', 'T_QUERY']) names.add(n);
    for (const n of names) {
      expect(section, n).toContain(`\`${n}\``);
      expect(T[n as keyof typeof T], n).toBeDefined();
    }
    for (const m of NON_GAMEPLAY) expect(section, m).toContain(`src/${m}.ts`);
  });
});
