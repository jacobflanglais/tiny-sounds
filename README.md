# Tiny Sounds

A private offline soundboard for little hands, built with vanilla HTML, CSS, and JavaScript. No build step. Optional private device sync uses sign-in.

## Play

Tap a tile to play its sound. The four starter tiles play a dog bark, cat meow, duck quack, and car horn. All defaults play for four seconds, with short calls repeated at their original pitch. Defaults and custom recordings fade out over their final half-second, bounded to the final half of very short clips. Custom recordings retain their saved length. Audio passes through a gain cap and soft limiter.

## Choose and create buttons

Hold the bottom-right gear for three seconds. **Sound library** contains 25 bundled sounds. Preview one, then choose **Add to play**. At 12 selected buttons, choose one to swap out; both remain saved.

**Your recordings** holds up to 25 custom sounds. Choose **Add a sound**, enter a name, take or choose a photo, then record and save up to 15 seconds of audio. New recordings can stay saved while play is full. Personalizing a default creates a custom copy and keeps the original. Remove from play to save a sound for later; delete a custom sound only when you want to remove it permanently.

The collection holds 50 sounds: 25 defaults and 25 custom recordings. The play screen shows at most 12. Icons, labels, and spacing scale to each tile. Custom photos fit without cropping. Long labels wrap to two lines, with one-line ellipsis in very short landscape tiles; accessible names remain complete. Drag active cards' dotted handles to reorder, or use the arrows.

Photos and recordings persist offline in IndexedDB. Sign in to privately sync the collection and play selections across devices. Offline changes upload when connected. Clearing browser storage can remove local copies.

## Install on a phone

Open the HTTPS site online. Hold the gear and wait for **Ready for offline play**. In Safari on iPhone, choose **Share → Add to Home Screen**. In Android Chrome, choose **Install app** or **Add to Home screen**. Launch from that icon and sign in to the same account to download your board, or add your family content there. After the initial setup, it works offline.

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

## Device sync

Hold the gear and sign in in the sync section. Use the same account on each device. Offline edits sync on reconnection. If two boards conflict, choose one and keep the alternate as a local backup. See [SYNC.md](SYNC.md) for access controls, data models, and recovery behavior.
