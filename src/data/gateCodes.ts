/**
 * [GATE] The passwords that unlock DotKick (src/app/gate.ts), as hashes only: lowercase hex SHA-256 of the UTF-8
 * string "dotkick-gate-v1:" + the normalised code (upper case, everything but A-Z and 0-9 removed). The plain codes
 * are never in the repository (it is public).
 *
 * Add codes with `npm run gate:codes -- 10 --append` (tools/gate-codes.mjs prints the new codes once, to the
 * terminal only, and adds their hashes between the markers below). Remove a line to retire a code that has not been
 * used yet; a device already unlocked stays unlocked.
 */
export const GATE_CODE_HASHES: readonly string[] = [
  // gate-codes:begin
  'cf0650f69ebb4b7e917a70d42facdc94350429f7a0ac238861040daa0fa60d55',
  'da391cf47c34ce203cf435fce70433fe20ae3f429caac3599ab18d651970f98c',
  'f2ef4cd5094f478882db579f1af412ad8e50bee99b8d8838bd72a0b856af5176',
  '303f8dc0a45aada20b56dae59c6660cf4c774bbe4037c83d77854737be4c3e8b',
  '881cbd2d42fb3a96c95581af2447e950b50e0845b92f03873efe7360dd25b31b',
  '8cb9dbb9b269492c268128cfe4c559a000abda1cdf74d2987ceabdadd889422b',
  'fe04704cc8f454db599f65dbbbc6516ea80fb321c83717ff1c6b24bb41b2e95f',
  'ce6d75caaf49af02d6b93c9fd1f009c41ea1541bfedd55edee387f1093911b81',
  '9a729c200de021f05ab9de8f22a1c3343f240b771bea15cc3c2b57f518a037cd',
  '0d96f8016b05a9fa33d3251817013ecd5b7d1a620867d9373b263baaf5d52331',
  // gate-codes:end
];
