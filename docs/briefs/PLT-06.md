# PLT-06 — README, deploy guides, credits and licences, device checklist
Owns: `README.md`, `docs/ASSETS.md`, `docs/DEVICE_CHECKLIST.md`, `docs/DEPLOY.md`. Spec: BRIEF §19 Deliverables ("README.md: run it locally; put it online free in
two step-by-step ways (a drag-and-drop static host and GitHub Pages); open it on the iPad and add it to the Home Screen; pair a controller; the full touch and
controller reference; troubleshooting." "DEVICE_CHECKLIST.md: a 15-minute script for me on the iPad. Benchmark; five-finger touch test; a multitasking swipe
in the middle of a sprint; pair a controller and disconnect it mid-match; install and play offline; one online match."), §2 (ASSETS.md: name, URL and licence
of every CC0/OFL source — the two fonts via @fontsource (OFL-1.1), Three.js (MIT), PeerJS (MIT)), §3 (README explains how to reach a dev build from the iPad
over HTTPS), §11 privacy note (peer-to-peer shows each player's IP address to the other, so codes should go only to people you know). Stubs by FND-04/FND-06 (read src/platform/* and public/*). BRIEF §3 (target device and iPadOS behaviours), §4 build output, §19 deliverables.
Write clear, step-by-step docs for a non-developer iPad owner: local run (npm install, npm run dev, HTTPS for the iPad: e.g. `vite --https` with a local
certificate via mkcert, or a tunnel), the two free hosting paths (drag-and-drop static host such as Netlify Drop / Cloudflare Pages direct upload — describe
generically and accurately without inventing UI details you are unsure of; GitHub Pages via the repository settings and an Actions workflow file you also
write at `.github/workflows/pages.yml` (you own it) that builds and deploys dist/), Add to Home Screen, pairing a controller in iPadOS Settings > Bluetooth,
complete controls reference (generate the tables from the brief §9/§10 and docs/KEYBOARD.md), troubleshooting (Low Power Mode, audio silent, controller not
detected until a button press, online errors), privacy. Do not publish anything yourself.
Tests: a docs lint script is not required; verify every command in the README actually works locally (run them) and every referenced file exists.
