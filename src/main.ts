/**
 * Entry point. [FND-04] Loads the global styles and boots the app. If boot itself fails, a plain message with the
 * error replaces the UI (the recovery screen needs a booted app).
 */
import './platform/viewport.css';
import './ui/tokens.css';
import './ui/components.css';
import { boot } from './app/boot';

function showBootFailure(err: unknown): void {
  const root = document.getElementById('ui') ?? document.body;
  const box = document.createElement('div');
  box.setAttribute('role', 'alert');
  box.style.cssText =
    'position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;' +
    'background:#07070D;color:#F4F1EC;font:16px system-ui,sans-serif;padding:24px;text-align:center;pointer-events:auto;';
  const title = document.createElement('strong');
  title.textContent = 'DotKick could not start.';
  const msg = document.createElement('code');
  msg.textContent = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.style.cssText = 'min-height:60px;padding:0 24px;border-radius:14px;border:0;background:#FF6B35;color:#12080a;font-weight:600;';
  btn.addEventListener('click', () => location.reload());
  box.append(title, msg, btn);
  root.append(box);
}

try {
  const app = boot();
  if (import.meta.hot) import.meta.hot.dispose(() => app.dispose());
} catch (err) {
  showBootFailure(err);
}
