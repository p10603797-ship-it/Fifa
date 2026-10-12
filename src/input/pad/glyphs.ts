/**
 * [PAD-07] Controller family detection and button glyphs (section 10: "label by controller family: PlayStation
 * shapes, Xbox letters or Switch letters. Detect the family from gamepad.id, with a manual override in settings").
 * Glyphs are drawn in code (no assets); labels below are the plain-text fallback.
 *
 * WAVE 0 BASELINE (FND-05): id-based detection and text labels. PAD-07 adds drawn glyphs and the remap screen.
 */

import { PadFamily } from '../../contracts/enums';

/** Detect the family from a gamepad.id string (vendor ids: 054c Sony, 045e Microsoft, 057e Nintendo). */
export function detectPadFamily(id: string): PadFamily {
  const s = id.toLowerCase();
  // Xbox and Switch first: "Xbox Wireless Controller" must not match Sony's generic "Wireless Controller".
  if (/045e|xbox|xinput/.test(s)) return PadFamily.XBOX;
  if (/057e|pro controller|joy-con|nintendo|switch/.test(s)) return PadFamily.SWITCH;
  if (/054c|dualsense|dualshock|playstation|wireless controller/.test(s)) return PadFamily.PLAYSTATION;
  return PadFamily.GENERIC;
}

/** Resolve the family to show: the settings override unless AUTO. */
export function effectiveFamily(detected: PadFamily, override: PadFamily): PadFamily {
  return override === PadFamily.AUTO ? detected : override;
}

const PS = ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right'];
const XB = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right'];
// Switch Pro by position: south B, east A, west Y, north X.
const NS = ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '-', '+', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right'];

/** Plain-text label for a standard-mapping button index in a family. */
export function buttonLabel(family: PadFamily, index: number): string {
  const t = family === PadFamily.XBOX || family === PadFamily.GENERIC ? XB : family === PadFamily.SWITCH ? NS : family === PadFamily.PLAYSTATION ? PS : XB;
  return t[index] ?? `B${index}`;
}

/** Friendly device label from a gamepad.id. */
export function padLabel(id: string): string {
  const f = detectPadFamily(id);
  if (f === PadFamily.PLAYSTATION) return 'PlayStation controller';
  if (f === PadFamily.XBOX) return 'Xbox controller';
  if (f === PadFamily.SWITCH) return 'Switch controller';
  const clean = id.replace(/\(.*?\)/g, '').trim();
  return clean.length > 0 ? clean.slice(0, 32) : 'Controller';
}
