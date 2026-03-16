# Treasure Hunt Runner (propfirmpayless.com)

Fast detection stack for "treasure hunt" events where hidden gift images/icons/popups are injected into the site.

## What It Detects

- New image/icon URLs in HTML and JS assets.
- Changed pages compared to baseline.
- Dynamic elements only visible after interaction (scroll/click/wait) using Playwright.
- Overlay/popup/dialog text changes and late animation-end content.

## One-Time Setup

```bash
npm install
npx playwright install chromium
npm run treasure:init
```

## Fast Competition Mode

```bash
npm run treasure:watch
```

Behavior:

- Runs in quick mode for speed.
- Stops on first hit by default.
- Opens detected URLs automatically in browser.
- Writes evidence to `.treasure-hunt/hits` and latest run to `.treasure-hunt/last-scan.json`.

## Useful Commands

- `npm run treasure:scan`  
  Single quick scan against baseline (auto-open enabled).

- `npm run treasure:watch:live`  
  Aggressive loop (keeps running after hit).

- `node scripts/treasure-hunt/runner.mjs scan --full --open-on-hit`  
  Full deep scan (slower) with screenshots.

- `node scripts/treasure-hunt/runner.mjs watch --interval=6 --open-on-hit`  
  Faster polling interval.

## Output Files

- `.treasure-hunt/baseline.json`
- `.treasure-hunt/last-scan.json`
- `.treasure-hunt/hits/*.json`
- `.treasure-hunt/shots/*.png` (only in full scan mode)

## Notes

- Watch mode uses a quick route set focused on likely event pages.
- If the site introduces a new route for events, add it in `scripts/treasure-hunt/config.mjs` under `watchRoutes`.
- For a clean reset before a new event: `npm run treasure:init`.

## GitHub Automation (Backup Mode)

This repo now includes:

- `.github/workflows/treasure-monitor.yml`

Behavior:

- Runs automatically every 5 minutes.
- Can also run manually via **Actions -> Treasure Monitor -> Run workflow**.
- Uses cached baseline between runs.
- Uploads `.treasure-hunt` artifacts for every run.
- Creates a GitHub Issue on HIT.
- Fails the workflow on HIT for strong visibility.

Recommended:

1. In GitHub repo settings, enable notifications for workflow failures and issues.
2. Keep this workflow active even when your local machine is offline.

## Mobile UI (GitHub Pages)

A dedicated page is available:

- `docs/treasure-monitor.html`

Features:

- `Run Now` button (dispatches the workflow immediately).
- Browser notifications on HIT.
- Shows the issue and extracted gift links.
- Optional continuous issue polling for \"hands-off\" monitoring.
