# AUD-02 — Crowd bed and reactions
Owns: `src/audio/crowd.ts`. Spec: BRIEF §8 ("A crowd bed whose intensity follows the match: build-up in the final third, shots, near misses, goals, lulls.").
Contracts: src/contracts/app.ts (AudioEngine, UiSound), events.ts (EventType, WhistleKind), settings.ts AudioSettings. Your stub was created by FND-04: read src/audio/types.ts (AudioModule, AudioCtx) and src/audio/engine.ts first. Rules (BRIEF §8 Sound, §3 Audio): all sound synthesised with Web Audio (no audio files), starts only after a user gesture, resumes after interruptions and visibility, volumes for master/crowd/effects/menus, no commentary. Never allocate per event in the steady state (reuse nodes or pre-rendered AudioBuffers generated once at unlock). Test pure parts in Node (envelopes, event mapping, scheduling maths); test lifecycle in Playwright (AudioContext state, no errors) — headless Chromium supports Web Audio.
Implement: a continuous crowd bed synthesised from filtered noise layers (seamless looping AudioBuffers with crossfaded loop points — no clicks), intensity
driven by state (ball position toward goals, ATTACK_BUILD events, possession) with smoothing; reactions on events: SHOT (rising "ooh"), NEAR_MISS (groan),
SAVE, GOAL (big cheer for the home side, quieter for away; home/away perspective from the human's team when one exists), FOUL/CARD (whistle-adjacent
murmurs), half-time lull; all on the crowd bus.
Tests: unit — intensity mapping and smoothing, loop crossfade continuity (no sample discontinuity at loop boundary); e2e — no errors during a match.
