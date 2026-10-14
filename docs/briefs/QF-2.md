# QF-2 — AI, keepers, difficulty and game feel: QA-12..QA-22, FIX-03, FIX-04, FIX-05, FIX-14

Area (exclusive for this wave): `src/ai/**`, `src/sim/keeper/**`, `src/sim/kicks/**` (pass/shot/aerial feel), `src/contracts/tuning.ts` (all blocks except
T_BALL, T_PHYS, T_RULES, T_DRIBBLE which QF-1 holds), docs/TUNING.md, `tools/balance.ts`, `tools/ladder.ts`.
Charter (BRIEF §6 Passing/Shooting/Defending/Goalkeepers, §7 all, §14 glitch list keeper/players/switching):
- QA-12 passing accuracy bands and receiver lock; QA-13 shooting bands and keeper save rate 65-78% on target;
  QA-14 stamina and attribute effects (a high-pace player is measurably faster, etc.); QA-15 loose-ball chasing (one
  chaser per team, no orbiting); QA-16 switching (no flip-flop, never away from the receiver, never onto an inactive
  player); QA-17 defensive line and marking; QA-18 attacking movement and onside timing; QA-19 difficulty ladder (each
  level beats the one below over many seeds, monotone); QA-20 statistics bands across clubs and styles (§7 targets over
  >= 200 matches: goals 2.0-3.6, shots 14-26, possession 40-60, pass completion 70-88, fouls 6-16, offsides 0-6,
  blow-outs < 5%); QA-21 keeper glitches (holds forever, carries over line, handles outside area, dives late, fights a
  defender, stuck in dive); QA-22 distribution and back-pass rule.
- FIX-14 game feel against the §6 reference values: pass speeds, shot power curve, turn rates, tackle windows.
Coordinate: possession/first-touch physics is QF-1's; ask by CR.
DAT-05 findings to act on (docs/ATTRIBUTE_AUDIT.md): shotPower moves shot speed only ~4% (shot.ts shotPowerMulMin
0.92 -> ~0.8); composure effect weak (composureRelief 0.5 -> ~0.8); skillMoves 4 and 5 identical for humans (add a
4-star tier in T_SKILL.minStars); 40-ballControl has 0% clean first touches at 20 m/s (check against §6). The balance
gate `npx tsx tools/balance.ts` (top v bottom club wins ~80%, equal clubs 50 +- 10%) must PASS with goals per match in band.
From INT-A (Wave 2, 100 Professional matches): goals 0.91 and shots 8.25 per match are far below the bands (2.0-3.6,
14-26): few possessions reach 25 m against a ten-man block, the CPU plays wide, and the TAI-10 xG model under-rates sim
conversion. Do a focused pass on chance creation (box entries, cutbacks, runners into the box, shots from the edge) and
recalibrate xG against measured sim conversion. Move the INT-A LOCAL_TUNING blocks (jobs hold speeds, steer overshoot,
resolveShared meet point, locomotion staminaRefHalfMinutes, carrier value model, passing completion factors, aerial
header geometry, lob lobLeadMaxSec, setpieces gkLongMax) into tuning.ts. gkp-01 movement scenarios pin a loose ball
inside the GKP-03 come-out zone of a full bot match: rework those tests (parked scene or ball outside the zone).
Pre-existing failing tests in your area: reports/suite-wave2-failures.md (gkp-01/02/04/05, tai-05, tai-13, ...).
(If reports/suite-wave2-failures.md is not there yet, the lead's full-suite run is still going: run your area's test
files yourself to list failures.)
