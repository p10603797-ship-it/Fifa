# GKP-02 — Saves
Owns: `src/sim/keeper/saves.ts`. Spec: BRIEF §6 Goalkeepers ("Saves: reaction delay, dive reach and dive speed come
from attributes. Results are catch, parry (away from danger when good), tip over, or beaten. A save is decided by
whether he physically reaches the ball, never by a dice roll that ignores where the shot went."; target 65-78% of
on-target shots saved with equal teams), T_GK, glitch list Keeper lines ("dives after the ball has passed", "stays
stuck in a dive", "handles outside the area", "fights a defender for the same ball").
Implement `keeperSaveDecision`, `keeperContacts`, GK_DIVE and GK_CATCH handlers:
- Decision: when a shot (ball.shotBy >= 0, or any fast ball heading toward the goal mouth by SIM-01 predictBall)
  approaches, after a reaction delay (gkReflexes -> reactBest..reactWorst ticks, worse when screened), compute where
  the ball crosses the keeper's plane/line; if within standing reach: step + catch/block; else start GK_DIVE toward
  the interception point with height class (low/mid/high) and side; dive kinematics: launch speed from gkDiving
  (diveSpeedBest..Worst), max reach (reachBest..Worst), duration, then on the ground (FALLEN-like) recovery.
  Never start a dive after the ball has passed the keeper's plane.
- Contact (first in the contact phase): if during the dive/stand the keeper's hand volume (body/arms capsule along
  the dive) intersects the ball's swept path this tick: catch if the ball is slow enough for handling (catchSpeed
  scaled by gkHandling) and the keeper is inside his own area -> keeperPickUp (GKP-05) and emit SAVE(CATCH); else
  parry (redirect the ball away from goal and from the centre — good keepers parry wide; poor keepers parry into
  danger), tip over the bar for high shots near the bar; emit SAVE. Outside the area: no hands — block with the body
  (deflection) only. If he does not physically reach it, the shot goes on (beaten).
- GK_DIVE ends with a get-up (no stuck dive); GK_CATCH animation window before GK_HOLD.
Tests: saves only when physically reachable (shots to the corners at 30 m/s vs keeper attributes), reaction delay
effect, catch vs parry by speed/handling, parry direction away from goal, no dive after the ball passed, no catch
outside the area, dive always ends, save rate band over a batch of scripted shots (report the measured rate).
