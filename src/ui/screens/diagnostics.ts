/**
 * [PLT-05] Diagnostics: report (version, device, settings, recent log), copy, debug overlay toggle.
 * WAVE 0 version by FND-04. PLT-05 adds the benchmark, input tester and replay save/load.
 */
import type { AppContext, Screen } from '../../contracts/app';
import { createButton, copyText, createBackButton, h } from '../components';

export function createDiagnosticsScreen(): Screen {
  return {
    id: 'diagnostics',
    mount(root: HTMLElement, ctx: AppContext) {
      const pre = h('pre', { class: 'ui-pre', text: ctx.diagnostics.report(), testId: 'diagnostics-report', attrs: { 'data-scroll': '' } });
      const copyBtn = createButton('Copy report', () => {
        void copyText(ctx.diagnostics.report()).then((ok) => {
          copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        });
      }, { testId: 'diagnostics-copy', variant: 'primary', autofocus: true, ctx });
      const debugLabel = (): string => `Debug overlay: ${ctx.diagnostics.debug ? 'on' : 'off'}`;
      const debugBtn = createButton(debugLabel(), () => {
        ctx.diagnostics.setDebug(!ctx.diagnostics.debug);
        debugBtn.textContent = debugLabel();
      }, { testId: 'diagnostics-debug', ctx });
      root.append(
        h('h1', { class: 'ui-title', text: 'Diagnostics', testId: 'diagnostics-title' }),
        pre,
        h('div', { class: 'ui-row' }, copyBtn, debugBtn),
        createBackButton(ctx),
      );
    },
    unmount() {
      /* DOM removed by the router */
    },
  };
}
