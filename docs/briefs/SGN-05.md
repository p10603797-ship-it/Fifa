# SGN-05 — Originality and licence audit (BRIEF §2, §15, DoD 9)

Area: read everything; you may edit `docs/ASSETS.md`, `src/data/names.ts` / `src/data/screen.ts` (name lists and the
screen) and regenerate data with `npm run gen:data` ONLY if a name must change (then prove attributes and kits are
unchanged apart from the renamed strings: diff the generated file), and add tests `tests/**/sgn-05-*.test.ts`.
Audit and report pass/fail per item, with evidence:
1. Names: 20 club names, cities, 3-letter codes, 360 player names, stadium names, nicknames — none matches a real club,
   real footballer (screen against a broad list of famous current and historic players), league, FIFA/EA/brand. Check
   the screen lists are broad enough; extend them if not and re-run the screen.
2. Visuals: crests, kits, logos, fonts, UI — generated in code or OFL fonts; nothing imitates a real club crest, league
   logo, FIFA/EA/FC visual identity, broadcaster graphics or a real stadium. Look at screenshots in tmp/ and reports/.
3. Audio: everything synthesised (no samples); no chants or melodies copied from real clubs or broadcasts.
4. Dependencies: every shipped package and font is listed in docs/ASSETS.md with version, licence and URL, and the
   licence texts ship inside dist/index.html (build and check); no copyleft-incompatible licence; dev-only packages
   (incl. 'peer') are not in the bundle.
5. Runtime network: build the game and prove (Playwright request log over a full local match, menus, settings, practice,
   install/offline) that no request leaves the page except the online 1v1 path (PeerJS broker / STUN / TURN only when an
   online room is used). No analytics, fonts from CDNs, telemetry or API keys anywhere in src/ or dist/.
6. Text: in-game strings and docs never claim affiliation with FIFA, EA, any league or club; "FC" style naming avoided
   where it imitates the EA FC brand.
Report: per item PASS/FAIL with evidence and fixes made.
