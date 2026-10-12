# AUD-01 — Audio engine
Owns: `src/audio/engine.ts`. Spec: BRIEF §3 ("Audio. It starts only after a user gesture. Resume the audio context after interruptions and when the page
becomes visible."), §8 Sound (volume sliders), glitch list Audio lines ("silent after returning from the background; crowd loop clicking; sounds stacking
after a pause"). Contracts: src/contracts/app.ts (AudioEngine, UiSound), events.ts (EventType, WhistleKind), settings.ts AudioSettings. Your stub was created by FND-04: read src/audio/types.ts (AudioModule, AudioCtx) and src/audio/engine.ts first. Rules (BRIEF §8 Sound, §3 Audio): all sound synthesised with Web Audio (no audio files), starts only after a user gesture, resumes after interruptions and visibility, volumes for master/crowd/effects/menus, no commentary. Never allocate per event in the steady state (reuse nodes or pre-rendered AudioBuffers generated once at unlock). Test pure parts in Node (envelopes, event mapping, scheduling maths); test lifecycle in Playwright (AudioContext state, no errors) — headless Chromium supports Web Audio.
Implement the engine: AudioContext creation in unlock() (user gesture), master + four bus gains with smoothed volume changes, a limiter/compressor on the
master, module wiring (crowd, sfx, whistles, ui, eventMap from AUD-02..05), suspend/resume with state checks (iOS 'interrupted' state handling: resume on
the next user gesture or visibility), setPaused (duck crowd, mute sfx), matchStart/matchEnd, voice limiting (cap simultaneous one-shots, steal oldest) so
sounds never stack, pre-rendering of generated buffers at unlock (off-thread friendly, chunked so no hitch).
Tests: e2e — unlock on tap, suspend on hidden + resume on visible, no AudioContext errors, voice cap; unit — volume ramps, voice allocator.
