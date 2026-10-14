# QF-7 — Performance: QA-36, QA-37, QA-38, FIX-13 (runs after QF-1..QF-6 finish, alone)

Area: any file, for performance changes only (behaviour must stay hash-identical per seed unless you say why).
Charter (BRIEF §3 60 fps / 50 floor on A16, §13): QA-36 allocation and GC audit (no per-frame or per-tick allocation in
steady play: measure with --expose-gc / heap snapshots in Node for sim+AI and Chromium for the render loop); QA-37 sim
and AI tick-time worst cases (crowded box, set pieces, 22 players chasing) against 2.5 ms average; QA-38 benchmark under
CPU throttling (Chromium CDP 4x/6x) and dynamic resolution behaviour (steps down and back up without oscillation).
Update docs/PERF_REPORT.md sections you measured (lead merges).
