/**
 * UIX-09 unit tests: the settings tabs and option lists cover every value of their enums (so every stored value can be
 * shown and chosen), the resolution-scale and club helpers. Every control writing the store, persistence across a
 * reload, reset, and touch-only / controller-only navigation are covered by tests/e2e/uix-09-settings.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AssistLevel, AutoSwitch, CameraType, Difficulty, PadFamily, QualityTier, SkillMove,
} from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { T_PERF } from '../../src/contracts/tuning';
import {
  ASSIST_OPTIONS, AUTO_SWITCH_OPTIONS, CAMERA_TYPE_OPTIONS, DIFFICULTY_LABELS, PAD_FAMILY_OPTIONS, QUALITY_OPTIONS,
  RES_SCALE_MAX, RES_SCALE_MIN, SETTINGS_TABS, SKILL_OPTIONS, distinctOther, fixedScaleFor, isSettingsTab, pct,
} from '../../src/ui/screens/settings';

/** Numeric members of a TS enum. */
function enumValues(e: Record<string, string | number>): number[] {
  return Object.values(e).filter((v): v is number => typeof v === 'number');
}

describe('UIX-09 settings tabs', () => {
  it('has the brief sections in order: Controls, Camera, Match, Audio, Graphics, Accessibility, Data, Diagnostics', () => {
    expect(SETTINGS_TABS.map((t) => t.id)).toEqual(['controls', 'camera', 'match', 'audio', 'graphics', 'access', 'data', 'diagnostics']);
    expect(SETTINGS_TABS.map((t) => t.label)).toContain('Accessibility');
    for (const t of SETTINGS_TABS) expect(isSettingsTab(t.id)).toBe(true);
    expect(isSettingsTab('nope')).toBe(false);
    expect(isSettingsTab(3)).toBe(false);
  });
});

describe('UIX-09 option lists cover their enums', () => {
  const cases: [string, readonly { value: number }[], Record<string, string | number>][] = [
    ['assist', ASSIST_OPTIONS, AssistLevel as unknown as Record<string, string | number>],
    ['auto-switch', AUTO_SWITCH_OPTIONS, AutoSwitch as unknown as Record<string, string | number>],
    ['camera', CAMERA_TYPE_OPTIONS, CameraType as unknown as Record<string, string | number>],
    ['difficulty', DIFFICULTY_LABELS, Difficulty as unknown as Record<string, string | number>],
    ['pad family', PAD_FAMILY_OPTIONS, PadFamily as unknown as Record<string, string | number>],
    ['quality', QUALITY_OPTIONS, QualityTier as unknown as Record<string, string | number>],
  ];
  for (const [name, opts, e] of cases) {
    it(`${name}: one option per enum value, no duplicates`, () => {
      const vals = opts.map((o) => o.value);
      expect(new Set(vals).size).toBe(vals.length);
      expect([...vals].sort()).toEqual(enumValues(e).sort());
    });
  }

  it('quality options are labelled Auto, Performance, Balanced, Quality (brief section 12)', () => {
    expect(QUALITY_OPTIONS.map((o) => o.label)).toEqual(['Auto', 'Performance', 'Balanced', 'Quality']);
  });

  it('skill slots offer every assignable skill and the defaults are among them', () => {
    const vals = SKILL_OPTIONS.map((o) => o.value as number);
    const d = createDefaultSettings().controls.touch;
    for (const v of [d.skillTap, d.skillUp, d.skillRight]) expect(vals).toContain(v);
    expect(vals).toContain(SkillMove.NONE);
    // Stops are fixed inputs (release stick + sprint / L1, swipe on SPRINT & SKILL), not slot choices.
    expect(vals).not.toContain(SkillMove.STOP_BALL);
    expect(vals).not.toContain(SkillMove.HARD_STOP);
  });

  it('the defaults are selectable values', () => {
    const d = createDefaultSettings();
    expect(ASSIST_OPTIONS.map((o) => o.value as number)).toContain(d.controls.assist);
    expect(AUTO_SWITCH_OPTIONS.map((o) => o.value as number)).toContain(d.controls.autoSwitch);
    expect(CAMERA_TYPE_OPTIONS.map((o) => o.value as number)).toContain(d.camera.type);
    expect(QUALITY_OPTIONS.map((o) => o.value as number)).toContain(d.graphics.tier);
  });
});

describe('UIX-09 helpers', () => {
  it('resolution scale range is the tuning range', () => {
    expect(RES_SCALE_MIN).toBe(T_PERF.resScaleMin);
    expect(RES_SCALE_MAX).toBe(T_PERF.resScaleMax);
  });

  it('switching automatic resolution off picks the last fixed scale, else full resolution, clamped', () => {
    expect(fixedScaleFor(0, 0)).toBe(RES_SCALE_MAX);
    expect(fixedScaleFor(0, 0.75)).toBe(0.75);
    expect(fixedScaleFor(0.8, 0.75)).toBe(0.8);
    expect(fixedScaleFor(0, 0.1)).toBe(RES_SCALE_MIN);
    expect(fixedScaleFor(5, 0)).toBe(RES_SCALE_MAX);
  });

  it('home and away default clubs never match', () => {
    expect(distinctOther(3, 5, 10)).toBe(5);
    expect(distinctOther(3, 3, 10)).toBe(4);
    expect(distinctOther(9, 9, 10)).toBe(0);
    expect(distinctOther(0, 0, 1)).toBe(0);
  });

  it('percent labels', () => {
    expect(pct(0.85)).toBe('85%');
    expect(pct(0)).toBe('0%');
    expect(pct(1)).toBe('100%');
  });
});
