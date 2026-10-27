import { resolveLocale, setLocale, t } from '../i18n';
import { checkBetaCode, hasBetaAccess, rememberBetaAccess } from '../platform/betaAccess';
import type { Platform } from '../platform/platform';
import { loadSettings } from '../save/settingsStore';
import { BODY_FONT, HEADING_FONT, loadFonts } from './fonts';

// Closed-beta access window for the public test build (GitHub Pages only; main.ts loads this module only when the
// build has an access hash, so local dev and the CrazyGames release never contain it). Plain DOM over the preloader:
// it runs before Phaser starts. A lock against casual visitors, not security (see platform/betaAccess.ts).
// The correct code is remembered on the device; a wrong one shows a short error, no lockout.
// Web Crypto needs a secure context: https (GitHub Pages) or localhost. A gated build opened over plain http on a LAN
// address cannot check the code (shown as a wrong code).

const GATE_ID = 'beta-gate';

const STYLE = `
#${GATE_ID} {
  position: absolute; inset: 0; z-index: 950; display: flex; align-items: center; justify-content: center;
  overflow-y: auto; box-sizing: border-box;
  padding: max(12px, env(safe-area-inset-top, 0px)) max(12px, env(safe-area-inset-right, 0px))
    max(12px, env(safe-area-inset-bottom, 0px)) max(12px, env(safe-area-inset-left, 0px));
  background: radial-gradient(ellipse at 50% 60%, #1c1418 0%, #0a090c 65%);
  color: #efe6d2; font: 16px/1.4 ${BODY_FONT};
}
#${GATE_ID} form {
  width: min(460px, 100%); margin: auto; box-sizing: border-box; padding: 24px 26px 22px; text-align: center;
  background: linear-gradient(180deg, #1c1720, #0e0b10); border: 1px solid #d9a94a;
  box-shadow: 0 0 0 2px #000, 0 0 0 3px #2b2420, 0 10px 40px #000, inset 0 0 30px rgba(0, 0, 0, 0.6);
}
#${GATE_ID} h2 {
  margin: 0 0 6px; font: 700 28px/1.1 ${HEADING_FONT}; color: #f3d58a; letter-spacing: 0.03em;
  text-shadow: 0 0 14px rgba(255, 122, 42, 0.3), 0 2px 3px #000;
}
#${GATE_ID} .rule { height: 1px; margin: 0 auto 14px; width: 70%; background: linear-gradient(90deg, transparent, #d9a94a, transparent); }
#${GATE_ID} p { margin: 0 0 8px; }
#${GATE_ID} p.muted { color: #9b917f; font-size: 14px; margin-bottom: 16px; }
#${GATE_ID} .row { display: flex; gap: 8px; }
#${GATE_ID} input {
  flex: 1; min-width: 0; height: 44px; box-sizing: border-box; padding: 0 12px;
  font: 16px ${BODY_FONT}; color: #efe6d2; background: #0a090c; border: 1px solid #5c4a2c; border-radius: 0; outline: none;
  user-select: text; -webkit-user-select: text;
}
#${GATE_ID} input:focus { border-color: #d9a94a; box-shadow: 0 0 6px rgba(217, 169, 74, 0.5); }
#${GATE_ID} button {
  height: 44px; padding: 0 18px; font: 700 16px ${BODY_FONT}; color: #f3d58a; cursor: pointer;
  background: linear-gradient(180deg, #6b4a22, #3a2614); border: 1px solid #d9a94a; border-radius: 0;
  transition: filter 0.15s ease-out, transform 0.12s ease-out;
}
#${GATE_ID} button:hover { filter: brightness(1.2); }
#${GATE_ID} button:active { transform: scale(0.96); }
#${GATE_ID} button:disabled { filter: grayscale(0.6) brightness(0.8); cursor: default; }
#${GATE_ID} .error { min-height: 1.4em; margin: 8px 0 0; color: #e0705f; font-size: 14px; font-weight: 700; }
#${GATE_ID}.shake form { animation: ${GATE_ID}-shake 0.3s ease-out; }
@keyframes ${GATE_ID}-shake { 25% { transform: translateX(-6px); } 50% { transform: translateX(5px); } 75% { transform: translateX(-3px); } }
@media (max-height: 480px) {
  #${GATE_ID} form { padding: 14px 18px 12px; }
  #${GATE_ID} h2 { font-size: 22px; }
  #${GATE_ID} .rule { margin-bottom: 8px; }
  #${GATE_ID} p { font-size: 14px; margin-bottom: 4px; }
  #${GATE_ID} p.muted { margin-bottom: 10px; }
  #${GATE_ID} input, #${GATE_ID} button { height: 40px; }
  #${GATE_ID} .error { margin-top: 4px; }
}
@media (prefers-reduced-motion: reduce) { #${GATE_ID}.shake form { animation: none; } }
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * Resolves once this device has access to the build behind `expectedHash`: at once when it was unlocked before,
 * otherwise after the player enters the right code in the window shown over the preloader.
 */
export function runBetaGate(platform: Platform, expectedHash: string): Promise<void> {
  if (expectedHash === '' || hasBetaAccess(platform.storage, expectedHash)) return Promise.resolve();

  // Same language choice as the app (render/app.ts), before it boots: the saved choice, else the browser's.
  const locale = resolveLocale(loadSettings(platform.storage).language, platform.getLanguages());
  setLocale(locale);
  document.documentElement.lang = locale;
  // DOM text swaps fonts when they arrive: no need to wait.
  void loadFonts(locale);

  const style = element('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  const gate = element('div');
  gate.id = GATE_ID;
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  const form = element('form');
  form.noValidate = true;
  const title = element('h2', undefined, t('beta.title'));
  gate.setAttribute('aria-label', title.textContent ?? '');
  const input = element('input');
  input.type = 'text';
  input.name = 'access-code';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('autocorrect', 'off');
  input.placeholder = t('beta.codePlaceholder');
  input.setAttribute('aria-label', t('beta.codePlaceholder'));
  const button = element('button', undefined, t('beta.enter'));
  button.type = 'submit';
  const error = element('p', 'error');
  error.setAttribute('aria-live', 'polite');
  const row = element('div', 'row');
  row.append(input, button);
  form.append(title, element('div', 'rule'), element('p', undefined, t('beta.notice')), element('p', 'muted', t('beta.reset')), row, error);
  gate.appendChild(form);
  (document.getElementById('shell') ?? document.body).appendChild(gate);

  // Touch devices: no auto focus, the keyboard would cover the notice before it is read.
  if (!matchMedia('(pointer: coarse)').matches) input.focus();
  // Phones: keep the field in view above the on-screen keyboard.
  input.addEventListener('focus', () => window.setTimeout(() => input.scrollIntoView({ block: 'center' }), 300));
  input.addEventListener('input', () => {
    error.textContent = '';
  });

  return new Promise<void>((resolve) => {
    let busy = false;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (busy) return;
      busy = true;
      button.disabled = true;
      void checkBetaCode(input.value, expectedHash)
        .catch(() => false)
        .then((ok) => {
          busy = false;
          button.disabled = false;
          if (ok) {
            rememberBetaAccess(platform.storage, expectedHash);
            input.blur();
            gate.remove();
            style.remove();
            resolve();
            return;
          }
          error.textContent = t('beta.wrong');
          gate.classList.remove('shake');
          void gate.offsetWidth; // restart the shake animation
          gate.classList.add('shake');
          input.select();
        });
    });
  });
}
