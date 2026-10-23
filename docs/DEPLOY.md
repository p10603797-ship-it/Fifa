# Deploying DotKick

DotKick is a static web app: a single `index.html` plus a few optional files. Any host that serves files over HTTPS can
run it. The step-by-step guides for a non-developer are in the [README](../README.md#4-put-it-online-for-free); this
page has the details behind them, the GitHub Pages workflow file, and how to check a deployment.

Nothing in this repository publishes anything by itself. Every way below starts only when you choose to do it.

## What gets deployed

`npm run build` writes `dist/`:

| File | Size (approx.) | Needed for |
|---|---|---|
| `index.html` | 2.4 MB raw, about 0.8 MB compressed (gzip) | The whole game: all code, styles and the two fonts, inlined |
| `manifest.webmanifest` | 1 KB | Add to Home Screen: name, colours, full screen, landscape, icons |
| `sw.js` | 8 KB | Offline play and the "Update available" flow (service worker) |
| `icons/` (5 PNG files) | 12 KB | Home Screen and browser icons |

- `index.html` runs alone. Without the other files the game still plays; only install, offline and icons are lost.
- Every path is relative (`vite.config.ts` uses `base: './'`), so the folder works at a site root
  (`https://example.com/`) or in a sub-folder (`https://example.github.io/dotkick/`) without changes.
- The build step also runs `tools/postbuild.mjs`. It fails the build if `index.html` refers to any outside file, if it
  is over the 4 MB compressed budget (brief section 3), or if the manifest or icons are broken. It also stamps a build
  id into `sw.js`, so every new build reaches installed copies as an update.
- No server code, no database, no environment variables, no API keys.

## What a host must do

1. **Serve over HTTPS.** Install, offline play and controllers need a secure page. All hosts below give HTTPS for free.
2. **Serve `index.html` for the folder address** (`/` or `/dotkick/`). Every static host does this by default.
3. **Send sensible content types.** `sw.js` must be served as JavaScript, or the browser refuses the service worker
   (the game still runs, without offline play). `manifest.webmanifest` should be `application/manifest+json`. The
   hosts below do this by default.
4. **No special caching is needed.** The page registers the service worker with `updateViaCache: 'none'`, so the
   browser always checks `sw.js` for a new version, and the service worker fetches the page network-first. If you
   configure caching yourself, do not give `index.html` or `sw.js` a long cache lifetime.

No redirects, rewrites or headers have to be configured.

## Way 1: drag-and-drop static hosts

Follow the README steps. Notes:

- Upload the **contents of `dist/`** so that `index.html` sits at the top of the upload. Dragging the `dist` folder
  itself does this on drop pages; dragging the project folder does not work (there is no built `index.html` at its
  top, and it would upload source files).
- Netlify Drop ([app.netlify.com/drop](https://app.netlify.com/drop)) keeps a site dropped without an account for a
  short time only; claiming it with a free account keeps it. New versions are dropped on the site's Deploys page.
- Cloudflare Pages takes direct uploads (a folder or a zip) for a Pages project created without a Git connection. The
  site is at `https://<project>.pages.dev`; each upload is a new deployment.
- Host dashboards change often. If a button named in the README has moved, look for "deploy manually", "upload" or
  "direct upload" in the host's own help pages.

## Way 2: GitHub Pages

A GitHub Actions workflow builds the game on GitHub's servers and publishes `dist/` on every push to the main branch.

1. The project is in a GitHub repository. GitHub Pages is free for public repositories; private repositories need a
   paid plan.
2. The repository contains `.github/workflows/pages.yml` with the contents below. To add it in the browser: **Add file
   > Create new file**, name `.github/workflows/pages.yml`, paste, **Commit changes**.
3. **Settings > Pages > Build and deployment > Source: GitHub Actions.** This creates the `github-pages` environment
   the workflow deploys to.
4. Push to `main` (or `master`), or run it by hand: **Actions > Deploy to GitHub Pages > Run workflow**.
5. The address appears on the run's deploy step and in **Settings > Pages**:
   `https://<user>.github.io/<repository>/`.

### The workflow file

Save this as `.github/workflows/pages.yml` (indentation matters: spaces only):

```yaml
# DotKick: build the game and publish dist/ to GitHub Pages (docs/DEPLOY.md).
# Needs: repository Settings > Pages > Build and deployment > Source = "GitHub Actions".
name: Deploy to GitHub Pages

on:
  push:
    branches: [main, master]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Check out the code
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install the pinned dependencies
        run: npm ci

      - name: Build dist/
        run: npm run build

      - name: Configure GitHub Pages
        uses: actions/configure-pages@v5

      - name: Upload dist/
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

What it does:

- **Triggers:** a push to `main` or `master`, or **Run workflow** in the Actions tab. If your main branch has another
  name, change the `branches` line.
- **build job:** checks out the code, installs Node.js 22 with the npm cache, runs `npm ci` (the exact versions in
  `package-lock.json`) and `npm run build` (which includes the post-build check, so a broken build fails here and the
  published site stays as it was), then uploads `dist/` as the Pages artifact.
- **deploy job:** publishes that artifact to the `github-pages` environment and shows the address.
- **permissions:** only what Pages needs (`pages: write` and `id-token: write` to deploy, `contents: read` to check
  out). **concurrency:** one deployment at a time; a newer push waits instead of cancelling a deployment halfway.

The install and build steps are the same commands as on a computer and were checked on a fresh copy of the project
(`npm ci`, then `npm run build`: "postbuild: PASS").

### If the GitHub Pages run fails

| Symptom | Fix |
|---|---|
| The deploy step fails with "Not Found" or asks to enable Pages | Set **Settings > Pages > Source** to **GitHub Actions**, then **Re-run all jobs** |
| "Branch ... is not allowed to deploy to github-pages due to environment protection rules" | You ran it from another branch. Run it from the main branch, or allow the branch under **Settings > Environments > github-pages** |
| The build step fails at `npm ci` | `package.json` and `package-lock.json` disagree. Run `npm install` on a computer and commit both files |
| The build step fails with "postbuild: FAIL" | The build broke a budget or self-containment rule; the log lists each problem. Run `npm run build` locally to see the same output |
| The site shows an old version | Reload once; an installed copy shows **Update available**. Pages can take a minute or two to switch versions |
| The site is a 404 at `https://<user>.github.io/` | A project site lives in a sub-folder: add `/<repository>/` to the address |

A custom domain can be set in **Settings > Pages > Custom domain** (see GitHub's documentation). Nothing in the build
needs to change for it.

## Other hosts

Any static host with HTTPS works the same way: upload the contents of `dist/`. Examples are Vercel, Render static
sites, Surge, an S3-style bucket behind HTTPS, or your own web server. A plain web server needs no configuration
beyond HTTPS.

## Testing a build on your own network

The README explains three ways to open a local build on the iPad: plain `http://` over Wi-Fi (touch only), HTTPS with
a [mkcert](https://github.com/FiloSottile/mkcert) certificate and `npx http-server dist -S -C <cert> -K <key>`, and an
HTTPS tunnel to `npx http-server dist`. Two details:

- The Vite development server (`npm run dev`) never registers the service worker (`src/platform/pwa.ts`), so test
  install, offline play and updates with a build (`npm run build`), not with the development server.
- The Vite servers (`npm run dev` and `npm run preview`) answer only to `localhost` and IP addresses. A request for any
  other host name (a tunnel address, a `.local` name) gets "Blocked request. This host is not allowed". A plain static
  server such as `http-server` has no such check, which is why the README tunnels to it.

## After deploying: a two-minute check

1. Open the address on a computer: the splash screen appears; the browser shows a padlock.
2. Open it in Safari on the iPad, tap to start, and play a few seconds of **Play now**.
3. Add it to the Home Screen and open it from there: full screen, no Safari toolbar.
4. Switch on Airplane Mode and open the Home Screen app again: it still starts (online 1v1 excepted).
5. Optional: open the address with `?bench=1` for the benchmark, and run the full
   [device checklist](DEVICE_CHECKLIST.md).

## Updates and rolling back

- Publishing a new build is all it takes. Open pages and installed apps check for a new `sw.js` when they start or
  come back to the foreground, then show **Update available** with a **Reload** button. Declining keeps the old version
  until the next launch.
- To roll back, publish the older build again: on a drop host redeploy the old folder (or restore an older deploy in
  the host's dashboard); on GitHub Pages revert the commit or re-run the workflow of an older commit.

## Self-hosted PeerJS server (optional)

Online 1v1 uses the free public PeerJS broker (`0.peerjs.com`, port 443) and PeerJS's default STUN and TURN servers
to introduce the two players; after that the match data goes directly between them where the network allows. All
broker and ICE settings are one object, `NET_CONFIG` in `src/net/config.ts`: `host`, `port`, `path`, `secure` and
`iceServers` (undefined means the PeerJS defaults). To use your own server:

1. Run a PeerServer (the open-source `peer` package from the PeerJS project; see its README) behind HTTPS.
2. Change `host`, `port`, `path` and `secure` in `NET_CONFIG` to match it (`createNetConfig({...})` builds a config
   with only some fields changed), and optionally list your own STUN or TURN servers in `iceServers`.
3. Rebuild and deploy. Both players must use builds with the same settings.

No keys are needed for the public broker, and none should be added to the code.

## Privacy reminder

A published address can be opened by anyone who has it. The game itself sends nothing anywhere except during online
1v1, where the two players' IP addresses become visible to each other (see the README's
[Privacy](../README.md#10-privacy) section).
