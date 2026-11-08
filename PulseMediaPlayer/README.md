# Pulse Media Player

Minimal, offline-first music player (PWA). Import your own MP3, FLAC, WAV and M4A files; they are stored on the device in IndexedDB and play with no internet. Lock-screen and notification controls work through the MediaSession API.

Developed by Last Dulani.

(Formerly AfroBox, then DeciBox. The internal storage name is still `afrobox` on purpose, so music already imported stays in the library after the rename.)

## Files

```
Pulse Media Player/
├── index.html              app shell, splash, icon sprite
├── manifest.webmanifest    install info (name, icons, colours)
├── sw.js                   service worker (offline app shell)
├── css/styles.css          onyx + crimson glass styling
├── js/app.js               UI, import, library, tabs
├── js/player.js            queue, shuffle, repeat, MediaSession
├── js/db.js                IndexedDB (tracks + audio blobs)
├── js/meta.js              ID3 / FLAC / M4A tag + cover reader
├── assets/                 splash logo, wordmark
└── icons/                  app icons (192, 512, maskable, Apple)
```

## Host it (GitHub Pages, free)

A PWA must be served over HTTPS. It will not install by double-clicking index.html.

1. Create a new GitHub repository, e.g. `pulse`.
2. Upload everything inside this folder (index.html at the top level of the repo, not inside a subfolder).
3. Repository Settings → Pages → Source: "Deploy from a branch" → `main` / `(root)` → Save.
4. After a minute your app is live at `https://<your-username>.github.io/pulse/`.

All paths in the app are relative, so it works in a sub-folder like this without changes.

## Install it

- iPhone (Safari): open the link → Share → Add to Home Screen. Use the home-screen icon from then on.
- Android (Chrome): open the link → menu → Install app (or Add to Home screen).
- Desktop (Chrome/Edge): install icon at the right end of the address bar.

Open it once while online so the app shell is cached. After that, turn on airplane mode and check it still opens.

## Add music

Library → Import songs (pick files) or Import folder. On iPhone, tap Browse in the picker to reach "On My iPhone" or iCloud Drive. Imported songs are copies stored inside Pulse Media Player; deleting the original file does not affect them.

## Updating the app

Edit your files, then change `VERSION` in `sw.js` (e.g. `pulse-v8`) and upload again. Phones fetch the new version on their next launch (close and reopen the app once or twice).

## Good to know

- iPhone volume: Safari does not let web apps change volume, so the slider is hidden there and the hardware buttons are used.
- iPhone storage: install to the Home Screen. Safari can clear data for websites that are not installed and unused for a while; installed apps are treated better. Large collections are limited by the space your browser gives the app.
- Playback runs through a single audio element, so tracks change instantly rather than crossfading.
- Metadata: if a file has no tags, the title and artist are taken from the file name ("Artist - Title.mp3").
