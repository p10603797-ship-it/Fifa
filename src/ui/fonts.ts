/**
 * [UIX-01 / PLT-04] UI fonts: Space Grotesk (UI) and JetBrains Mono (numbers, tabular figures), both OFL, subset to
 * Latin and inlined into the single-file build. WAVE 0 STUB (FND-04): the tokens fall back to system fonts.
 */

/** Install the inlined @font-face rules. Safe to call more than once. */
export function installFonts(): void {
  /* PLT-04 adds the subsetted, inlined faces (src/ui/fonts/**). */
}

/** Resolves when the UI fonts are ready (or immediately when the Font Loading API is missing). */
export function fontsReady(): Promise<void> {
  const fonts = typeof document !== 'undefined' ? (document as Document & { fonts?: FontFaceSet }).fonts : undefined;
  if (!fonts) return Promise.resolve();
  return fonts.ready.then(() => undefined, () => undefined);
}
