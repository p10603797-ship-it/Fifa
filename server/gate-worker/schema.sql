-- [GATE] DotKick password checker (server/gate-worker/worker.js, D-048). One row per password, keyed by its hash
-- (lowercase hex SHA-256 of "dotkick-gate-v1:" + the normalised code; the plain code is never stored).
-- used_at: epoch ms when it unlocked a device (NULL = unused). device: the random id of that device.
CREATE TABLE IF NOT EXISTS codes (
  hash TEXT PRIMARY KEY NOT NULL CHECK (length(hash) = 64),
  used_at INTEGER,
  device TEXT
);
