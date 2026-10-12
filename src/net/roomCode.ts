/**
 * [NET-03] Room codes and share links. WAVE 0 STUB (FND-04): factories throw until NET-03 lands.
 * Codes are 6 characters from an unambiguous alphabet; links carry the code in the URL hash.
 */

/** Unambiguous code alphabet (no 0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;

/** New random room code; `random` returns [0, 1). */
export function generateRoomCode(random: () => number): string {
  void random;
  throw new Error('not implemented (NET-03)');
}

/** Normalise user input to a valid code (upper case, ambiguous letters mapped) or null. */
export function normaliseRoomCode(input: string): string | null {
  void input;
  throw new Error('not implemented (NET-03)');
}

/** Share link for a code, relative to the current page URL. */
export function roomLink(code: string, pageUrl: string): string {
  void code;
  void pageUrl;
  throw new Error('not implemented (NET-03)');
}

/** Room code carried in a page URL (share link), or null. */
export function roomCodeFromUrl(pageUrl: string): string | null {
  void pageUrl;
  throw new Error('not implemented (NET-03)');
}
