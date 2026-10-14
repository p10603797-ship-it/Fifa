/**
 * Glitch-list audit (BRIEF §14): every glitch-list item needs a named regression test. A test counts for an item when
 * its title contains "glitch" and every keyword of the item (case-insensitive). Prints a table and exits 1 when an
 * item has no test. Usage: npx tsx tools/glitch-audit.ts [--json]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface Item { group: string; text: string; keys: string[] }

const ITEMS: Item[] = [
  ['Ball stuck', 'between two players', ['stuck', 'between two']],
  ['Ball stuck', 'under a sliding player', ['stuck', 'slid']],
  ['Ball stuck', 'on the roof of the net', ['roof']],
  ['Ball stuck', 'behind the goal', ['behind the goal']],
  ['Ball stuck', 'wedged against a post or board', ['wedged']],
  ['Ball stuck', 'resting on the goal line', ['resting on the goal line']],
  ['Goals', 'not given when the ball crosses and bounces out', ['bounces out']],
  ['Goals', 'counted twice', ['counted twice']],
  ['Goals', 'given through the side netting', ['side netting']],
  ['Goals', 'scored direct from a throw-in', ['throw-in', 'direct']],
  ['Keeper', 'holds the ball forever', ['holds the ball forever']],
  ['Keeper', 'carries it over his own line', ['carries']],
  ['Keeper', 'handles outside the area', ['handles outside']],
  ['Keeper', 'dives after the ball has passed', ['dives after']],
  ['Keeper', 'fights a defender for the same ball', ['fights a defender']],
  ['Keeper', 'stays stuck in a dive', ['stuck in a dive']],
  ['Players', 'orbit or jitter around a target', ['orbit']],
  ['Players', 'two teammates chase or nobody does', ['chase']],
  ['Players', 'run in place against each other', ['run in place']],
  ['Players', 'walk through the goal frame or net', ['through the goal frame']],
  ['Players', 'stay off the pitch after a throw-in or celebration', ['off the pitch']],
  ['Switching', 'flip-flops between two players', ['flip-flop']],
  ['Switching', 'switches away from the player about to receive', ['about to receive']],
  ['Switching', 'lands on a sent-off or substituted player', ['sent-off', 'switch']],
  ['Restarts', 'taker missing or sent off', ['taker missing']],
  ['Restarts', 'opponents inside the required distance blocking forever', ['blocking forever']],
  ['Restarts', 'ball out of play during a restart', ['out of play during a restart']],
  ['Restarts', 'restart given to the wrong team', ['wrong team']],
  ['Restarts', 'two restarts queued', ['two restarts queued']],
  ['Restarts', 'kick-off with players in the wrong half', ['wrong half']],
  ['Offside', 'given from a throw-in, goal kick or corner', ['offside', 'throw-in']],
  ['Offside', 'against a player in his own half', ['offside', 'own half']],
  ['Discipline', 'advantage that never resolves', ['advantage']],
  ['Discipline', 'card shown to the wrong player', ['wrong player']],
  ['Discipline', '12 players after a substitution', ['12 players']],
  ['Discipline', 'a team below 7 players not ending the match', ['below 7']],
  ['Clock', 'half ends during a shot in flight', ['shot in flight']],
  ['Clock', 'timer drift', ['drift']],
  ['Clock', 'game runs fast after a pause, a tab switch or on a 120 Hz display', ['runs fast']],
  ['Camera', 'jitter', ['camera', 'jitter']],
  ['Camera', 'snapping at restarts', ['snap']],
  ['Camera', 'losing a high ball', ['high ball']],
  ['Camera', 'dipping below ground or into the stand', ['below ground']],
  ['Camera', 'ball hidden under touch controls', ['hidden under touch']],
  ['Input', 'stuck sprint or stick after pointercancel', ['pointercancel']],
  ['Input', 'button swipe read as a pitch gesture', ['button swipe']],
  ['Input', 'power bar stuck full', ['power bar stuck']],
  ['Input', 'both players pausing at once', ['pausing at once']],
  ['Input', 'controller disconnect during a penalty', ['disconnect during a penalty']],
  ['Audio', 'silent after returning from the background', ['silent after']],
  ['Audio', 'crowd loop clicking', ['click']],
  ['Audio', 'sounds stacking after a pause', ['stacking']],
  ['Online', 'desync', ['desync']],
  ['Online', 'both sides waiting forever', ['waiting forever']],
  ['Online', 'rematch starting with stale state', ['stale state']],
].map(([group, text, keys]) => ({ group: group as string, text: text as string, keys: keys as string[] }));

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(test|spec)\.ts$/.test(name)) out.push(p);
  }
}

const TITLE_RE = /\b(?:it|test)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

function main(): void {
  const files: string[] = [];
  walk('tests', files);
  const titles: { file: string; title: string }[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(TITLE_RE)) {
      const t = m[2]!;
      if (/glitch/i.test(t)) titles.push({ file: f, title: t });
    }
  }
  const rows = ITEMS.map((it) => {
    const hits = titles.filter((t) => it.keys.every((k) => t.title.toLowerCase().includes(k.toLowerCase())));
    return { ...it, tests: hits.map((h) => `${h.file}: ${h.title}`) };
  });
  const missing = rows.filter((r) => r.tests.length === 0);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ items: rows.length, missing: missing.length, rows }, null, 2));
  } else {
    for (const r of rows) console.log(`${r.tests.length > 0 ? 'ok  ' : 'MISS'} ${r.group}: ${r.text} (${r.tests.length})`);
    console.log(`\n${rows.length - missing.length}/${rows.length} glitch-list items have a named regression test.`);
  }
  process.exit(missing.length > 0 ? 1 : 0);
}

main();
