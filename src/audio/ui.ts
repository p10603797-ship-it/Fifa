/**
 * [AUD-05] Menu sounds. WAVE 0 version (FND-04): short synthesised blips on the menus bus.
 * AUD-05 refines the palette (move, confirm, back, error, toggle, start, countdown).
 */
import { UiSound } from '../contracts/app';
import type { AudioCtx, UiAudioModule } from './types';

/** Base frequency (Hz) and length (s) per UiSound. */
const TONES: Readonly<Record<UiSound, readonly [number, number]>> = {
  [UiSound.MOVE]: [660, 0.04],
  [UiSound.CONFIRM]: [880, 0.08],
  [UiSound.BACK]: [440, 0.08],
  [UiSound.ERROR]: [180, 0.16],
  [UiSound.TOGGLE]: [740, 0.05],
  [UiSound.START]: [990, 0.18],
  [UiSound.COUNTDOWN]: [520, 0.1],
};

export function createUi(ctx: AudioCtx): UiAudioModule {
  return {
    play(kind) {
      const tone = TONES[kind];
      if (!tone) return;
      const ac = ctx.ctx;
      if (ac.state !== 'running') return;
      const [freq, len] = tone;
      const t = ac.currentTime;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + len);
      osc.connect(gain);
      gain.connect(ctx.menus);
      osc.start(t);
      osc.stop(t + len + 0.02);
      osc.onended = () => {
        osc.disconnect();
        gain.disconnect();
      };
    },
    dispose() {
      /* sounds clean themselves up */
    },
  };
}
