# QF-6 — Online 1v1: QA-42, FIX-12

Area (exclusive for this wave): `src/net/**`, `src/ui/screens/online.ts`, `tools/netsim.ts`, `tests/net/**`.
Charter (BRIEF §11 1v1 online, §14 determinism and glitch list online): desync (hash check every N ticks with
resync or clean end), latency 80 ms each way + 20 ms jitter + 5% loss with no desync and playable input delay, both
sides waiting forever (timeouts and a clear message), disconnects and reconnect window, rematch with fresh state, room
codes (collisions, expiry, wrong code), pause rules online. Use the two-instance harness (DoD 5).
