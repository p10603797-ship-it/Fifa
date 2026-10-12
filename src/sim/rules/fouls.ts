/**
 * [RUL-09] Foul classification, advantage, cards, send-offs (config.fouls; arcade mode = off).
 * Consumes s.match.challenges each tick: classify from who touched the ball first, contact direction, closing
 * speed and slide -> clean, foul, foul+yellow, foul+red, penalty inside the area. Advantage: play on for up to
 * 3 s when the fouled team keeps a good position, then wave it away or bring play back. Second yellow = red
 * (RUL-10 sendOff). Emits FOUL, CARD, ADVANTAGE. Cards go to the right player.
 */
import type { ChallengeOutcome, CardKind } from '../../contracts/enums';
import type { ChallengeRecord } from '../../contracts/state';
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';

export function foulsTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Classify a challenge (deterministic; may use s.rng). */
export function classifyChallenge(s: SimState, rec: Readonly<ChallengeRecord>): ChallengeOutcome { return 0; }
/** Show a card to slot (handles second yellow -> red via RUL-10 sendOff). */
export function showCard(s: SimState, slot: number, kind: CardKind, ev: EventSink): void { /* stub */ }
