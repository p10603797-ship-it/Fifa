/**
 * [UIX-05] Local match flow shared by the pre-match screens (BRIEF §12 Screens: Mode setup -> Team and kit select ->
 * Side select -> Match settings -> Loading). Helper file of UIX-03/04/05 (owned with modeSetup.ts).
 *
 * Params of every flow screen: FlowParams = { mode: ModeId, setup: MatchSetup }. `setup` is the partial MatchSetup the
 * steps fill in turn: team-select writes clubs, kits and formations; side-select writes config.humans and bindings;
 * match-settings writes the rules and starts the session. Each screen edits ITS OWN params.setup in place (the router
 * keeps that object, so Back to a screen shows the choices made there) and hands the next screen a copy (cloneSetup),
 * so a later step never changes an earlier one.
 *
 * A flow screen opened without flow params (full-time "Change teams", a deep link) starts a new flow from the saved
 * match defaults (settings.match) in the last flow mode used.
 *
 * Also the shared top bar (Back, mode eyebrow, title, step dots, primary action) and its CSS.
 */
import type { AppContext, MatchSetup, ScreenId, ScreenParams } from '../../contracts/app';
import { MatchPhase, ModeId } from '../../contracts/enums';
import type { MatchConfig } from '../../contracts/state';
import { configFromSettings } from '../../modes/setup';
import { createBackButton, h, injectStyle } from '../components';

/** Modes that run through the local pre-match flow. */
export type FlowMode = ModeId.KICK_OFF | ModeId.FRIEND_LOCAL | ModeId.SHOOT_OUT;

export interface FlowParams {
  mode: FlowMode;
  setup: MatchSetup;
}

/** Steps after mode setup, per flow mode (the session start follows the last one). */
export const FLOW_STEPS: Readonly<Record<FlowMode, readonly ScreenId[]>> = {
  [ModeId.KICK_OFF]: ['team-select', 'side-select', 'match-settings'],
  [ModeId.FRIEND_LOCAL]: ['team-select', 'side-select', 'match-settings'],
  [ModeId.SHOOT_OUT]: ['team-select', 'side-select', 'match-settings'],
};

export const STEP_LABELS: Readonly<Partial<Record<ScreenId, string>>> = {
  'team-select': 'Teams',
  'side-select': 'Sides',
  'match-settings': 'Settings',
};

export const MODE_LABELS: Readonly<Record<FlowMode, string>> = {
  [ModeId.KICK_OFF]: 'Kick-Off',
  [ModeId.FRIEND_LOCAL]: 'Play a Friend',
  [ModeId.SHOOT_OUT]: 'Shoot-out',
};

/** Seconds of goal celebration + replay when replays are on (MatchConfig default). */
export const DEFAULT_REPLAY_SECONDS = 8;

export function isFlowMode(m: unknown): m is FlowMode {
  return m === ModeId.KICK_OFF || m === ModeId.FRIEND_LOCAL || m === ModeId.SHOOT_OUT;
}

let lastFlowMode: FlowMode = ModeId.KICK_OFF;

/** Remember the mode of the match being started (a later flow without params resumes it). */
export function rememberFlowMode(mode: FlowMode): void {
  lastFlowMode = mode;
}

export function lastMode(): FlowMode {
  return lastFlowMode;
}

/** Mode-specific fields of a fresh config (pure). */
export function applyModeToConfig(config: MatchConfig, mode: FlowMode): void {
  config.mode = mode;
  if (mode === ModeId.SHOOT_OUT) {
    config.startPhase = MatchPhase.SHOOT_OUT;
    config.cupRules = 1;
  } else {
    config.startPhase = MatchPhase.KICK_OFF;
  }
}

/** A new flow from the saved match defaults: no humans yet (side select assigns them). */
export function newFlow(ctx: AppContext, mode: FlowMode): FlowParams {
  const config = configFromSettings(ctx.settings.get(), mode);
  applyModeToConfig(config, mode);
  const home = ctx.clubs[config.homeClub];
  const away = ctx.clubs[config.awayClub];
  if (home) config.homeFormation = home.formation;
  if (away) config.awayFormation = away.formation;
  return { mode, setup: { config, bindings: [] } };
}

function isSetup(v: unknown): v is MatchSetup {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<MatchSetup>;
  return !!s.config && typeof s.config === 'object' && Array.isArray(s.config.humans) && Array.isArray(s.bindings);
}

/**
 * The flow of a screen's params. Missing or malformed params start a new flow, which is stored back into params
 * (best effort) so Back to this screen finds the same working copy.
 */
export function readFlow(ctx: AppContext, params: ScreenParams | null | undefined): FlowParams {
  const p = params ?? {};
  let mode: FlowMode = isFlowMode(p.mode) ? p.mode : lastFlowMode;
  if (!isFlowMode(p.mode)) {
    try {
      const running = ctx.session.getSetup();
      if (running && isFlowMode(running.config.mode)) mode = running.config.mode;
    } catch {
      /* no session */
    }
  }
  if (isSetup(p.setup)) return { mode, setup: p.setup };
  const flow = newFlow(ctx, mode);
  try {
    p.mode = flow.mode;
    p.setup = flow.setup;
  } catch {
    /* frozen params: the flow lives for this mount only */
  }
  return flow;
}

/** Deep copy of a setup (config, humans, bindings); callbacks and the mode payload are shared. */
export function cloneSetup(s: MatchSetup): MatchSetup {
  return {
    ...s,
    config: { ...s.config, humans: s.config.humans.map((c) => ({ ...c })) },
    bindings: s.bindings.map((b) => ({ human: b.human, deviceIds: b.deviceIds.slice() })),
  };
}

/** The screen after `from` in the mode's flow, or null after the last step (start the match). */
export function nextFlowScreen(mode: FlowMode, from: ScreenId): ScreenId | null {
  const steps = FLOW_STEPS[mode];
  if (from === 'mode-setup') return steps[0] ?? null;
  const i = steps.indexOf(from);
  return i >= 0 && i + 1 < steps.length ? steps[i + 1]! : null;
}

/** Params for the next step: same mode, a copy of the setup. */
export function nextParams(flow: FlowParams): FlowParams {
  return { mode: flow.mode, setup: cloneSetup(flow.setup) };
}

/** Go to the step after `from` with a copy of the flow. Returns the screen opened, or null at the end of the flow. */
export function goNext(ctx: AppContext, from: ScreenId, flow: FlowParams): ScreenId | null {
  const next = nextFlowScreen(flow.mode, from);
  if (next) ctx.router.go(next, { ...nextParams(flow) });
  return next;
}

// ============================================================ shared top bar

const CSS = `
.screen.flow { justify-content: flex-start; align-items: stretch; gap: var(--space-4);
  padding-top: calc(var(--safe-top, 0px) + var(--space-5)); padding-bottom: calc(var(--safe-bottom, 0px) + var(--space-5)); }
.flow-top { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: var(--space-4);
  flex: 0 0 auto; min-height: var(--target); }
.flow-top .ui-back { position: static; justify-self: start; }
.flow-head { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; text-align: center; }
.flow-head .ui-title { font-size: var(--fs-lg); white-space: nowrap; }
.flow-eyebrow { margin: 0; font: 600 var(--fs-xs) / 1 var(--font-ui); letter-spacing: var(--tracking-caps); text-transform: uppercase;
  color: var(--text-3); }
.flow-steps { display: flex; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
.flow-step { display: flex; align-items: center; gap: 6px; font: 500 var(--fs-xs) / 1 var(--font-ui); color: var(--text-3); }
.flow-step::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--hairline-strong); }
.flow-step.is-done { color: var(--text-2); }
.flow-step.is-done::before { background: var(--text-2); }
.flow-step.is-current { color: var(--text-1); }
.flow-step.is-current::before { background: var(--ember); }
.flow-action { justify-self: end; display: flex; gap: var(--space-3); align-items: center; }
.flow-action .btn { min-width: calc(var(--target) * 2.4); }
.btn.is-blocked { opacity: 0.55; }
@media (max-height: 560px) {
  .screen.flow { gap: var(--space-3); padding-top: calc(var(--safe-top, 0px) + var(--space-5)); padding-bottom: calc(var(--safe-bottom, 0px) + var(--space-5)); }
  .flow-steps { display: none; }
}
`;

export function injectFlowStyle(): void {
  injectStyle('match-flow', CSS);
}

/** Step dots for the current screen of the mode's flow. */
export function createStepDots(mode: FlowMode, current: ScreenId): HTMLElement {
  const steps = FLOW_STEPS[mode];
  const cur = steps.indexOf(current);
  const ol = h('ol', { class: 'flow-steps', attrs: { 'aria-label': 'Steps' } });
  steps.forEach((id, i) => {
    const li = h('li', { class: 'flow-step', text: STEP_LABELS[id] ?? id });
    if (i < cur) li.classList.add('is-done');
    if (i === cur) {
      li.classList.add('is-current');
      li.setAttribute('aria-current', 'step');
    }
    ol.append(li);
  });
  return ol;
}

export interface FlowTopOptions {
  ctx: AppContext;
  title: string;
  /** Eyebrow line (mode name). */
  eyebrow: string;
  testId: string;
  steps?: HTMLElement | null;
  /** Right side: the primary action(s). */
  actions?: readonly HTMLElement[];
  onBack?: () => void;
}

/** Top bar: Back on the left, eyebrow + title + steps in the centre, actions on the right. */
export function createFlowTop(o: FlowTopOptions): HTMLElement {
  return h(
    'header',
    { class: 'flow-top' },
    createBackButton(o.ctx, o.onBack),
    h(
      'div',
      { class: 'flow-head' },
      h('p', { class: 'flow-eyebrow', text: o.eyebrow }),
      h('h1', { class: 'ui-title', text: o.title, testId: o.testId }),
      o.steps ?? null,
    ),
    h('div', { class: 'flow-action' }, ...(o.actions ?? [])),
  );
}
