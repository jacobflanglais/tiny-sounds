# Tiny Sounds

A private offline soundboard for little hands, built with vanilla HTML, CSS, and JavaScript. No build step or backend.

## Play

Tap a tile to play its sound. The four starter tiles play a dog bark, cat meow, duck quack, and car horn. Audio passes through a gain cap and soft limiter.

## Add your own buttons

Hold the bottom-right gear for three seconds. Choose **Add a sound**, enter a name, take or choose a photo, then record and save a sound. Recordings can be up to 15 seconds. Drag the dotted handles to reorder, or use the arrows. Tap a card to edit it. The board holds up to 12 sounds.

Photos and recordings stay in IndexedDB on the device where you add them. They are never uploaded or synced. Clearing browser storage can remove them.

## Install on a phone

Open the HTTPS site online. Hold the gear and wait for **Ready for offline play**. In Safari on iPhone, choose **Share → Add to Home Screen**. In Android Chrome, choose **Install app** or **Add to Home screen**. Launch from that icon and add your family content there. After the initial setup, it works offline.

## Run locally

From this folder, run:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open http://localhost:8080. Microphone recording requires HTTPS or localhost. Opening an HTML file directly is not supported for installation.

## Deploy

GitHub Pages: publish the `main` branch from `/(root)`. All assets and installation paths are relative to support repository subpaths. Increment the cache version in `sw.js` when changing cached files, then reopen online to update.

## Sound credits

See [SOUND-CREDITS.md](SOUND-CREDITS.md) for the bundled recordings, modifications, creators, and audio licenses.
