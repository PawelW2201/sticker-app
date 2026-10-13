# StickerTracker app

An installable web app for a private StickerTracker repository: your book's value and overnight change,
the agent's alerts and intents, the drift desk, and per-sticker price and listings charts.

This repository holds **only the app's code**. It contains no data and no repository names. When you open
the app, it reads the nightly summary that the tracker publishes to the `dashboard-data` branch of your
private repository, straight from GitHub's API, using a read-only token you paste once on each device.

## Set up

1. Open the app's GitHub Pages address on your computer or phone.
2. Tap **Create a read-only token**. On GitHub, set *Repository access* to *Only select repositories* and pick
   your tracker repository. *Contents: Read-only* is already filled in. Generate the token and copy it.
3. Paste it into the app and tap **Connect**.

To install it: in Chrome or Edge use *Install app*; on Android use *Add to Home screen*; on iPhone use
Safari's *Share → Add to Home Screen*, then open it from there and connect. Settings has a setup link and QR code
to connect another device without making a new token.

## Privacy

- The token stays in this browser's storage and is only ever sent to `api.github.com`.
- The last downloaded summary is kept on the device so the app opens offline.
- Settings → *Disconnect this device* removes both.

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell and styles |
| `app.js` | The app: setup, data loading, Today / Drift desk / Your book / Agent, sticker detail, settings |
| `charts.js` | Small SVG charts (one y-axis each; stacked charts share a crosshair) |
| `sw.js` | Offline copy of the app's own files (never touches GitHub data requests) |
| `manifest.webmanifest`, `icons/` | Install metadata and icons |
| `fonts/` | Barlow and Barlow Semi Condensed, SIL Open Font License 1.1 (`fonts/OFL-Barlow.txt`) |
| `vendor/qrcode.mjs` | QR Code Generator for JavaScript by Kazuhiko Arase, MIT license (header in the file) |

No build step: GitHub Pages serves these files as they are.
