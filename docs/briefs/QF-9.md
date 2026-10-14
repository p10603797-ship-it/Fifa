# QF-9 — Wave 4 round 2: sim control, bodies, receiving and defending (FIX-01, FIX-04 follow-up)

Area (exclusive): `src/sim/control/**`, `src/sim/players/**`, `src/sim/defend/**`, `src/sim/contacts.ts`, the
T_TOUCH / T_PLAYER / T_INPUT blocks of `src/contracts/tuning.ts`. QF-10 (kicks, actions, rules) and QF-12 (app) run
in parallel; QF-11 (AI ladder) runs after you. Each item has an `it.fails` test: fix the code, flip it to `it()`.
1. Lofted receiver (SIM-15 resolveShared meetPoint): a controlled receiver runs to the first reachable point of the
   ball's ground track ignoring height, so lobs/keeper throws fly over him (LOB_PASS reached a teammate 2 of 64; keeper
   throws 1 of 10). Skip samples where the ball is above ~2.0 m. Test qf-2-cr-lofted-receiver.
2. CPU auto-switch away from the man a loose ball rolls into, then back (use SIM-07's receive reach). Test
   qf-2-cr-switch-receiver.
3. Auto-switch in a frame with a fresh face press resolves the press for the new man (a 67 m header SHOT): no
   auto-switch on a fresh face-press frame, or resolve the press first. Test qf-2-cr-switch-press.
4. Body lock (SIM-05 bodies slide-around): a runner beside an opponent running the same way stays locked at 0.75 m
   for 80 ticks with 14 velocity flips. Keep one side through the contact / slide round the back. Test
   qf-2-cr-body-lock (glitch: run in place).
5. Shots pass straight through defenders who are not controlled / chasing / the pass target: bodies block a fresh
   shot (defend/tackle interceptContacts; firstTouch receiveContacts leaves opponents out for a fresh shot). Test
   qf-2-cr-shot-block.
6. Sprinting receiver's clean first touch fires the ball 2.6 m clear at 14 m/s: plan the settle point with the capped
   speed or cap the ball speed near his own. Test qf-2-cr-first-touch-sprint.
7. Move constants per the brief: locomotion staminaRefHalfMinutes -> T_PLAYER.staminaRefHalfMinutes; resolveShared
   meetOvershoot* / meetCatchDist -> T_TOUCH.meet* (values identical; QF-2 already added the tuning entries).
8. §6 first touch depends on ball control: a 40-ballControl player gets 0% clean first touches at 20 m/s (DAT-05).
   Check against §6 and make the curve plausible (poor players miscontrol often, not always).
Every change alters sim behaviour: run the area tests, `tools/soak.ts --matches 60 --enforce all --halfMinutes 4`
(bands must stay in §7) and `tools/fuzz.ts --matches 60 --enforce all`. Document tuning changes in docs/TUNING.md.
