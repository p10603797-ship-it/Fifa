/**
 * [UIX-01] Base DOM components for screens. WAVE 0 version by FND-04; UIX-01 refines the look but keeps these
 * exports and their behaviour (every Wave 1 screen builds on them).
 *
 * Rules (brief section 12): every control is a <button data-focus> at least 60 pt tall (FocusNavigator discovers
 * [data-focus]); every screen works by touch alone and by controller alone; Back always works.
 */
import type { AppContext, Screen, ScreenId, ScreenParams } from '../contracts/app';
import { UiSound } from '../contracts/app';

export interface ElementProps {
  class?: string;
  text?: string;
  testId?: string;
  attrs?: Record<string, string>;
}

/** Create an element with optional class, text, data-testid and attributes, appending children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElementProps = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.testId) el.dataset.testid = props.testId;
  if (props.attrs) for (const k of Object.keys(props.attrs)) el.setAttribute(k, props.attrs[k]!);
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(c);
  }
  return el;
}

export interface ButtonOptions {
  testId?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'icon';
  /** Mark as the preferred initial focus of its screen. */
  autofocus?: boolean;
  /** Plays a UI sound on select when given. */
  ctx?: AppContext;
  sound?: UiSound;
  extraClass?: string;
  ariaLabel?: string;
}

/** A focusable button (>= 60 pt) that calls onSelect on click/tap/controller confirm. */
export function createButton(label: string, onSelect: () => void, opts: ButtonOptions = {}): HTMLButtonElement {
  const variant = opts.variant ?? 'secondary';
  const cls = ['btn', `btn--${variant}`];
  if (opts.extraClass) cls.push(opts.extraClass);
  const b = h('button', { class: cls.join(' '), text: label, testId: opts.testId });
  b.type = 'button';
  b.dataset.focus = '';
  if (opts.autofocus) b.dataset.focusDefault = '';
  if (opts.ariaLabel) b.setAttribute('aria-label', opts.ariaLabel);
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (opts.ctx) opts.ctx.audio.playUi(opts.sound ?? UiSound.CONFIRM);
    onSelect();
  });
  return b;
}

/** Inject a stylesheet once (each UI file keeps its own CSS next to its code). */
export function injectStyle(id: string, css: string): void {
  if (typeof document === 'undefined') return;
  const domId = `style-${id}`;
  if (document.getElementById(domId)) return;
  const s = document.createElement('style');
  s.id = domId;
  s.textContent = css;
  document.head.appendChild(s);
}

/** Standard Back button (top-left). */
export function createBackButton(ctx: AppContext, onBack?: () => void): HTMLButtonElement {
  return createButton('Back', onBack ?? (() => ctx.router.back()), {
    testId: 'back', variant: 'ghost', ctx, sound: UiSound.BACK, extraClass: 'ui-back', ariaLabel: 'Back',
  });
}

export interface PlaceholderAction {
  label: string;
  testId?: string;
  primary?: boolean;
  onSelect(ctx: AppContext): void;
}

export interface PlaceholderOptions {
  subtitle?: string;
  note?: string;
  actions?: PlaceholderAction[];
  /** Screen-specific Back behaviour; return true when handled. */
  onBack?(ctx: AppContext): boolean;
  /** Hide the Back button (root screens). */
  noBack?: boolean;
}

/** A titled placeholder screen with optional actions and a Back button (Wave 0 stubs for Wave 1 screens). */
export function createPlaceholderScreen(id: ScreenId, title: string, opts: PlaceholderOptions = {}): Screen {
  let ctxRef: AppContext | null = null;
  return {
    id,
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      void params;
      ctxRef = ctx;
      root.append(h('h1', { class: 'ui-title', text: title, testId: `${id}-title` }));
      if (opts.subtitle) root.append(h('p', { class: 'ui-subtitle', text: opts.subtitle }));
      if (opts.actions && opts.actions.length > 0) {
        const col = h('div', { class: 'ui-col' });
        opts.actions.forEach((a, i) => {
          col.append(
            createButton(a.label, () => a.onSelect(ctx), {
              testId: a.testId, variant: a.primary ? 'primary' : 'secondary', autofocus: i === 0, ctx,
            }),
          );
        });
        root.append(col);
      }
      if (opts.note) root.append(h('p', { class: 'ui-note', text: opts.note }));
      if (!opts.noBack) root.append(createBackButton(ctx));
    },
    unmount() {
      ctxRef = null;
    },
    onBack() {
      return ctxRef && opts.onBack ? opts.onBack(ctxRef) : false;
    },
  };
}

/** Copy text to the clipboard (Clipboard API with a textarea fallback). Resolves true on success. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
