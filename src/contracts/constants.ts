/**
 * DotKick shared constants. Lead-owned, frozen after Wave 0.
 *
 * Units: metres and seconds. Origin is the centre spot. x runs along the pitch length,
 * z across the width with +z toward the main (broadcast) camera, y is up.
 * Home attacks left to right (toward +x) in the first half.
 */

/** Working title. Change it here and only here. */
export const GAME_NAME = 'DotKick';
export const GAME_VERSION = '0.1.0';
/** Bumped whenever sim behaviour changes in a way that breaks replays or online compatibility. */
export const SIM_VERSION = 1;

// ---------------------------------------------------------------- timing
/** Fixed simulation rate. */
export const TICK_HZ = 60;
/** Seconds per tick. Use only multiplications by DT inside sim (deterministic). */
export const DT = 1 / 60;
/** Convert seconds to whole ticks (rounded). Safe to use in sim. */
export const secToTicks = (sec: number): number => Math.round(sec * TICK_HZ);
/** Max real time the loop adds per animation frame (ms). */
export const MAX_FRAME_MS = 100;
/** Max ticks run per animation frame. */
export const MAX_TICKS_PER_FRAME = 3;

// ---------------------------------------------------------------- squads
export const PLAYERS_PER_TEAM = 11;
export const SQUAD_SIZE = 18;
export const BENCH_SIZE = SQUAD_SIZE - PLAYERS_PER_TEAM;
/** Number of on-pitch player slots. Team 0 uses slots 0..10, team 1 uses 11..21. Slot 0 and 11 start as keepers. */
export const NUM_SLOTS = 22;
export const MAX_SUBS = 5;
/** A team reduced below this many players forfeits 3-0. */
export const MIN_PLAYERS = 7;
/** Max humans in one match (player 1 ember, player 2 cyan). */
export const MAX_HUMANS = 2;
/** Controller slots in sim state: 0,1 = humans P1/P2; 2,3 = CPU brains for team 0/1. */
export const NUM_CONTROLLERS = 4;
export const CPU_CONTROLLER_BASE = 2;

/** First slot of a team. */
export const teamFirstSlot = (team: number): number => (team === 0 ? 0 : PLAYERS_PER_TEAM);
/** Team of a slot. */
export const slotTeam = (slot: number): number => (slot < PLAYERS_PER_TEAM ? 0 : 1);

// ---------------------------------------------------------------- pitch geometry
export const PITCH_LENGTH = 105;
export const PITCH_WIDTH = 68;
export const HALF_LENGTH = PITCH_LENGTH / 2; // 52.5 (goal lines at x = +-52.5)
export const HALF_WIDTH = PITCH_WIDTH / 2; // 34 (touchlines at z = +-34)
export const LINE_WIDTH = 0.12;

export const GOAL_WIDTH = 7.32;
export const GOAL_HALF_WIDTH = GOAL_WIDTH / 2; // 3.66 (inside of posts at z = +-3.66)
export const GOAL_HEIGHT = 2.44; // underside of crossbar
export const GOAL_DEPTH = 2.0; // net depth behind the goal line
export const POST_RADIUS = 0.06; // posts and bar are 12 cm cylinders

export const PENALTY_AREA_DEPTH = 16.5;
export const PENALTY_AREA_WIDTH = 40.32;
export const PENALTY_AREA_HALF_WIDTH = PENALTY_AREA_WIDTH / 2; // 20.16
export const GOAL_AREA_DEPTH = 5.5;
export const GOAL_AREA_WIDTH = 18.32;
export const GOAL_AREA_HALF_WIDTH = GOAL_AREA_WIDTH / 2; // 9.16
export const PENALTY_SPOT_DIST = 11;
export const CENTRE_CIRCLE_RADIUS = 9.15;
export const PENALTY_ARC_RADIUS = 9.15;
export const CORNER_ARC_RADIUS = 1;

export const BALL_RADIUS = 0.11;
export const BALL_MASS = 0.43;

/** World bounds (ball and players must stay inside; invariant). Includes run-off and the goals. */
export const WORLD_MIN_X = -62;
export const WORLD_MAX_X = 62;
export const WORLD_MIN_Z = -44;
export const WORLD_MAX_Z = 44;
export const WORLD_MAX_Y = 80;
/** Players may never go past these (advertising boards). */
export const BOARD_X = 58;
export const BOARD_Z = 40;

/** Minimum opponent distance at restarts (m). */
export const RESTART_DISTANCE = 9.15;
export const THROW_IN_DISTANCE = 2;

/** Goal-line x for the goal a team defends, given its attack direction (+1 attacks +x). */
export const ownGoalX = (dir: number): number => -dir * HALF_LENGTH;
/** Goal-line x of the goal a team attacks. */
export const oppGoalX = (dir: number): number => dir * HALF_LENGTH;

// ---------------------------------------------------------------- crossing zone
/** Crossing zone: within this many metres of the attacking goal line and at least this far from the centre line (|z|). */
export const CROSS_ZONE_DEPTH = 30;
export const CROSS_ZONE_MIN_Z = 13;
