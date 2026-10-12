/**
 * [DAT-04] Formation, role and tactic preset data. Normalised positions for a team attacking +x, neutral phase
 * (ball on the centre spot). nx: -1 own goal line .. +1 opposition goal line; nz: +1 = right flank (+z, near
 * touchline). Index 0 = GK, then defenders (right to left), midfielders, forwards.
 * WAVE 0 BASELINE values; DAT-04 refines and adds role/tactic presets.
 */
import { FormationId, Role } from '../contracts/enums';
import type { Formation, FormationSlot } from '../contracts/data';

const f = (role: Role, nx: number, nz: number): FormationSlot => ({ role, nx, nz });
const GK = f(Role.GK, -0.92, 0);
const BACK4 = [f(Role.RB, -0.6, 0.62), f(Role.CB, -0.66, 0.2), f(Role.CB, -0.66, -0.2), f(Role.LB, -0.6, -0.62)];
const TWO_ST = [f(Role.ST, 0.04, 0.16), f(Role.ST, 0.04, -0.16)];

export const FORMATIONS: readonly Formation[] = [
  { id: FormationId.F442, name: '4-4-2', slots: [GK, ...BACK4, f(Role.RM, -0.25, 0.66), f(Role.CM, -0.32, 0.18), f(Role.CM, -0.32, -0.18), f(Role.LM, -0.25, -0.66), ...TWO_ST] },
  { id: FormationId.F433, name: '4-3-3', slots: [GK, ...BACK4, f(Role.CM, -0.3, 0.32), f(Role.CDM, -0.42, 0), f(Role.CM, -0.3, -0.32), f(Role.RW, -0.02, 0.62), f(Role.ST, 0.06, 0), f(Role.LW, -0.02, -0.62)] },
  { id: FormationId.F4231, name: '4-2-3-1', slots: [GK, ...BACK4, f(Role.CDM, -0.42, 0.18), f(Role.CDM, -0.42, -0.18), f(Role.RM, -0.12, 0.6), f(Role.CAM, -0.14, 0), f(Role.LM, -0.12, -0.6), f(Role.ST, 0.06, 0)] },
  { id: FormationId.F352, name: '3-5-2', slots: [GK, f(Role.CB, -0.64, 0.34), f(Role.CB, -0.68, 0), f(Role.CB, -0.64, -0.34), f(Role.RWB, -0.3, 0.72), f(Role.CM, -0.34, 0.22), f(Role.CDM, -0.45, 0), f(Role.CM, -0.34, -0.22), f(Role.LWB, -0.3, -0.72), ...TWO_ST] },
  { id: FormationId.F532, name: '5-3-2', slots: [GK, f(Role.RWB, -0.5, 0.72), f(Role.CB, -0.64, 0.34), f(Role.CB, -0.68, 0), f(Role.CB, -0.64, -0.34), f(Role.LWB, -0.5, -0.72), f(Role.CM, -0.3, 0.32), f(Role.CM, -0.36, 0), f(Role.CM, -0.3, -0.32), ...TWO_ST] },
  { id: FormationId.F41212, name: '4-1-2-1-2', slots: [GK, ...BACK4, f(Role.CDM, -0.46, 0), f(Role.CM, -0.3, 0.36), f(Role.CM, -0.3, -0.36), f(Role.CAM, -0.14, 0), ...TWO_ST] },
];

export function getFormation(id: FormationId): Formation {
  return FORMATIONS[id] ?? FORMATIONS[0]!;
}
