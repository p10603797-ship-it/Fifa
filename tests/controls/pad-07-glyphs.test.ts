/**
 * PAD-07 controller family detection (gamepad.id strings in the forms browsers report, without any product logos) and
 * the glyph table (PlayStation shapes drawn as generated SVG, Xbox letters, Switch letters by position, generic).
 */
import { describe, expect, it } from 'vitest';
import { PadFamily } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { createDefaultSettings } from '../../src/contracts/settings';
import {
  btnToPadIndex, buttonLabel, detectPadFamily, effectiveFamily, facePositionSvg, familyForPad, familyName, glyph, glyphForBtn,
  GLYPH_LEFT_STICK, GLYPH_RIGHT_STICK, padLabel, padProductName, padVendorId, rawButtonLabel,
} from '../../src/input/pad/glyphs';

const { PLAYSTATION, XBOX, SWITCH, GENERIC, AUTO } = PadFamily;

/** Real-world-style gamepad.id strings (Chrome, Firefox, Safari forms) -> family. */
const IDS: [string, PadFamily][] = [
  // Chrome / Edge: "Name (STANDARD GAMEPAD Vendor: vvvv Product: pppp)"
  ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', PLAYSTATION],
  ['Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', PLAYSTATION],
  ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', XBOX],
  ['Xbox 360 Controller (XInput STANDARD GAMEPAD)', XBOX],
  ['Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', SWITCH],
  ['Joy-Con L+R (STANDARD GAMEPAD Vendor: 057e Product: 200e)', SWITCH],
  ['8BitDo Pro 2 Wireless Controller (STANDARD GAMEPAD Vendor: 2dc8 Product: 6006)', GENERIC],
  ['USB Gamepad (Vendor: 0079 Product: 0011)', GENERIC],
  // Firefox: "vvvv-pppp-Name", sometimes without leading zeros
  ['054c-0ce6-Sony Interactive Entertainment Wireless Controller', PLAYSTATION],
  ['54c-5c4-Wireless Controller', PLAYSTATION],
  ['45e-2ea-Microsoft X-Box One S pad', XBOX],
  ['057e-2009-Pro Controller', SWITCH],
  ['0079-0011-Generic   USB  Joystick  ', GENERIC],
  // Safari / iPadOS: product names only
  ['DualShock 4 Wireless Controller', PLAYSTATION],
  ['PS5 Controller', PLAYSTATION],
  ['Xbox Wireless Controller', XBOX],
  ['Nintendo Switch Pro Controller', SWITCH],
  ['Wireless Controller', PLAYSTATION],
  ['MFi Extended Gamepad', GENERIC],
  ['', GENERIC],
];

describe('PAD-07 family detection from gamepad.id', () => {
  for (const [id, fam] of IDS) {
    it(`${JSON.stringify(id)} -> ${familyName(fam)}`, () => {
      expect(detectPadFamily(id)).toBe(fam);
    });
  }

  it('a vendor id wins over misleading words; the bare Sony name only counts as the whole name', () => {
    expect(detectPadFamily('Wireless Controller (Vendor: 045e Product: 0b13)')).toBe(XBOX);
    expect(detectPadFamily('8BitDo Pro 2 Wireless Controller')).toBe(GENERIC);
    expect(padVendorId('054c-0ce6-x')).toBe('54c');
    expect(padVendorId('Name (Vendor: 045E Product: 0b13)')).toBe('45e');
    expect(padVendorId('no vendor here')).toBe('');
    expect(padProductName('054c-0ce6-Wireless Controller')).toBe('Wireless Controller');
    expect(padProductName('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)')).toBe('Xbox Wireless Controller');
  });

  it('non-string ids never throw', () => {
    expect(detectPadFamily(undefined as unknown as string)).toBe(GENERIC);
    expect(padVendorId(42 as unknown as string)).toBe('');
    expect(padProductName(null as unknown as string)).toBe('');
  });

  it('settings override: AUTO uses the detected family; any other value wins; a damaged value counts as AUTO', () => {
    expect(effectiveFamily(PLAYSTATION, AUTO)).toBe(PLAYSTATION);
    expect(effectiveFamily(PLAYSTATION, XBOX)).toBe(XBOX);
    expect(effectiveFamily(GENERIC, SWITCH)).toBe(SWITCH);
    expect(effectiveFamily(XBOX, 77 as PadFamily)).toBe(XBOX);
    expect(effectiveFamily(AUTO, AUTO)).toBe(GENERIC);
    const s = createDefaultSettings();
    expect(familyForPad(IDS[0]![0], s)).toBe(PLAYSTATION);
    s.controls.pad.familyOverride = SWITCH;
    expect(familyForPad(IDS[0]![0], s)).toBe(SWITCH);
    expect(familyForPad(IDS[0]![0], null)).toBe(PLAYSTATION);
  });

  it('friendly device labels name the family, never a logo', () => {
    expect(padLabel(IDS[0]![0])).toBe('PlayStation controller');
    expect(padLabel(IDS[2]![0])).toBe('Xbox controller');
    expect(padLabel(IDS[4]![0])).toBe('Switch controller');
    expect(padLabel('USB Gamepad (Vendor: 0079 Product: 0011)')).toBe('USB');
    expect(padLabel('')).toBe('Controller');
  });
});

describe('PAD-07 glyph table', () => {
  const FACE: [PadFamily, string[], string[]][] = [
    [PLAYSTATION, ['Cross', 'Circle', 'Square', 'Triangle'], ['cross', 'circle', 'square', 'triangle']],
    [XBOX, ['A', 'B', 'X', 'Y'], ['letter', 'letter', 'letter', 'letter']],
    // Switch letters by position: south B, east A, west Y, north X.
    [SWITCH, ['B', 'A', 'Y', 'X'], ['letter', 'letter', 'letter', 'letter']],
    [GENERIC, ['A', 'B', 'X', 'Y'], ['letter', 'letter', 'letter', 'letter']],
  ];
  for (const [fam, labels, shapes] of FACE) {
    it(`${familyName(fam)} face buttons`, () => {
      for (let i = 0; i < 4; i++) {
        const g = glyph(fam, i);
        expect(g.label).toBe(labels[i]);
        expect(g.shape).toBe(shapes[i]);
        expect(g.index).toBe(i);
        expect(g.svg.startsWith('<svg')).toBe(true);
        expect(g.svg).toContain('currentColor');
        expect(g.svg).not.toMatch(/#[0-9a-f]{3,6}/i); // no brand colours: drawn in the text colour
      }
    });
  }

  it('PlayStation shapes are drawn as SVG paths, letters as text', () => {
    expect(glyph(PLAYSTATION, 0).svg).toContain('<path d="M11 11L21 21M21 11L11 21"');
    expect(glyph(PLAYSTATION, 1).svg).toContain('<circle cx="16" cy="16" r="6"');
    expect(glyph(PLAYSTATION, 2).svg).toContain('<rect');
    expect(glyph(PLAYSTATION, 3).svg).toContain('<path d="M16 9.5L22.5 20.5H9.5Z"');
    expect(glyph(XBOX, 1).svg).toContain('>B</text>');
    expect(glyph(SWITCH, 1).svg).toContain('>A</text>');
  });

  it('shoulders, triggers, menu buttons, stick clicks, D-pad and sticks per family', () => {
    expect([4, 5, 6, 7, 8, 9, 10, 11].map((i) => buttonLabel(PLAYSTATION, i))).toEqual(['L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3']);
    expect([4, 5, 6, 7, 8, 9, 10, 11].map((i) => buttonLabel(XBOX, i))).toEqual(['LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS']);
    expect([4, 5, 6, 7, 8, 9].map((i) => buttonLabel(SWITCH, i))).toEqual(['L', 'R', 'ZL', 'ZR', 'Minus', 'Plus']);
    expect([12, 13, 14, 15].map((i) => glyph(XBOX, i).name)).toEqual(['D-pad up', 'D-pad down', 'D-pad left', 'D-pad right']);
    expect(glyph(XBOX, 4).shape).toBe('shoulder');
    expect(glyph(XBOX, 7).shape).toBe('trigger');
    expect(glyph(SWITCH, 9).name).toBe('Plus button');
    expect(glyph(PLAYSTATION, GLYPH_LEFT_STICK).label).toBe('Left stick');
    expect(glyph(PLAYSTATION, GLYPH_RIGHT_STICK).shape).toBe('stick');
    expect(glyph(XBOX, 20).index).toBe(20);
    expect(glyph(XBOX, -3).index).toBe(-1);
  });

  it('Btn bits map to their positions (right-stick bits to the right stick; SKIP has no pad glyph)', () => {
    expect([Btn.PASS, Btn.SHOOT, Btn.LOB, Btn.THROUGH, Btn.MOD_L, Btn.MOD_R, Btn.SHIELD, Btn.SPRINT].map(btnToPadIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(btnToPadIndex(Btn.RS_FLICK)).toBe(GLYPH_RIGHT_STICK);
    expect(glyphForBtn(PLAYSTATION, Btn.SHOOT)!.label).toBe('Circle');
    expect(glyphForBtn(SWITCH, Btn.PASS)!.label).toBe('B');
    expect(glyphForBtn(XBOX, Btn.SKIP)).toBeNull();
    expect(glyph(AUTO, 0).label).toBe('A'); // AUTO draws as generic
  });

  it('glyphs are cached (same object per family and button)', () => {
    expect(glyph(XBOX, 3)).toBe(glyph(XBOX, 3));
    expect(glyph(PLAYSTATION, GLYPH_LEFT_STICK)).toBe(glyph(PLAYSTATION, GLYPH_LEFT_STICK));
    expect(glyph(XBOX, 3)).not.toBe(glyph(SWITCH, 3));
  });

  it('raw button labels and the family-neutral face diamond for pads without the standard mapping', () => {
    expect(rawButtonLabel(0)).toBe('Button 1');
    expect(rawButtonLabel(-1)).toBe('Not set');
    expect(facePositionSvg(1)).toContain('aria-label="The right face button"');
    expect((facePositionSvg(1).match(/fill="currentColor"/g) ?? []).length).toBe(1);
    expect(facePositionSvg(9)).toContain('Face buttons');
  });
});
