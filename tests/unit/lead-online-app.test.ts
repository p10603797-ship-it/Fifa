/**
 * Online app-side wiring (NET-B CRs applied by the lead): the crowd backs the local online player's side, and local
 * modes keep the default perspective.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { MatchSetup } from '../../src/contracts/app';
import { ControllerKind } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { perspectiveTeam, setLocalPerspective } from '../../src/audio/crowd';
import { onlineLocalSide } from '../../src/app/session';
import { initMatch } from '../../src/sim/init';

function onlineSetup(localHuman: number): MatchSetup {
  const config = createMatchConfig();
  config.humans[1] = { ...config.humans[0]!, kind: ControllerKind.HUMAN, side: 1 };
  return { config, bindings: [], modeData: { kind: 'online', session: { localHuman } } };
}

afterEach(() => setLocalPerspective(-1));

describe('online crowd perspective', () => {
  it('maps the local online human to their side', () => {
    expect(onlineLocalSide(onlineSetup(0))).toBe(0);
    expect(onlineLocalSide(onlineSetup(1))).toBe(1);
  });

  it('is -1 for local modes', () => {
    expect(onlineLocalSide({ config: createMatchConfig(), bindings: [] })).toBe(-1);
  });

  it('overrides the crowd side while set and clears back to the default', () => {
    const setup = onlineSetup(1);
    const s = initMatch(setup.config);
    expect(perspectiveTeam(s)).toBe(0);
    setLocalPerspective(onlineLocalSide(setup));
    expect(perspectiveTeam(s)).toBe(1);
    setLocalPerspective(-1);
    expect(perspectiveTeam(s)).toBe(0);
  });
});
