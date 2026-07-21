# Pocket Player

A tiny PWA that runs a web game **fully offline, from the device it's installed on**.
Import a game once from a `.zip`, and from then on it launches straight from the
browser's storage — no server, no network, no PC.

Built for **RPG Maker MV** games (which are plain web games under the hood), but it
will serve any static-web game whose zip contains an `index.html`.

**This tool ships no game content.** Whatever you import stays in your browser's
Cache Storage on your own device; nothing is uploaded anywhere. Only import games
you own.

## How it works

- The page unzips your file **in the browser** (streaming, via
  [fflate](https://github.com/101arrowz/fflate), MIT) and stores every file in
  **Cache Storage** with a proper MIME type.
- A **service worker** answers every request under `game/…` straight from that
  cache — including **HTTP Range** responses, which iOS Safari requires for
  audio/video elements. The game never touches the network.
- `Play` simply navigates to the shallowest `index.html` found in the zip.

## Using it on an iPhone

**The order matters** — on iOS, Safari and an installed home-screen app have
**separate storage**: a game imported in Safari is invisible to the app.

1. Open the player page in Safari → Share → **Add to Home Screen**
   (from the player page itself, never from inside a game).
2. Get the game's zip onto the phone (iCloud Drive / AirDrop / Files).
   For RPG Maker MV, zip the **contents of the `www` folder**.
3. Open the **home-screen icon** → **Import game (.zip)** → pick the zip →
   wait for the bar. (The screen is kept awake during the import.)
4. **▶ Play.** Next time, it's two taps: open app → Play. Airplane mode welcome.

If a game misbehaves, the player injects a small shim that (a) replaces the
useless "Script error" with the real message on screen, (b) rescues failed
audio decodes with silence so a missing codec can't crash the game, (c) fixes
the mobile viewport, and (d) neutralises desktop-only `require()`/Steam plugin
calls.

## On-screen gamepad (RPG Maker MV/MZ)

Touch-to-move often misfires inside an iOS standalone web app, so for RPG Maker
games the shim adds an **on-screen gamepad** that drives the engine's `Input`
state directly (bypassing touch coordinates entirely):

- **D-pad** (bottom-left) — move / navigate menus.
- **A** — OK / confirm / advance dialogue (`ok`).
- **B** — back / cancel (`escape`).
- **X** — menu (`escape`; on the map, cancel opens the menu in MV).

It appears automatically on touch devices, installed apps, and coarse-pointer
screens (or force it with `?pad` on the game URL). Buttons are held for
directions and momentary for actions, with a minimum hold so fast taps still
register a frame. The engine's own keyboard input keeps working alongside.

Notes:
- One game slot. Importing another zip replaces the previous game
  (in-game saves are kept — they live in `localStorage`, separately).
- Removing the home-screen app deletes the imported game *and* its saves.
- RPG Maker MV audio is OGG; iOS support for it arrived in recent Safari
  versions — if a game is silent, that's the codec, not the import.

## Files

```
index.html    – the player UI
app.js        – zip import → Cache Storage, meta, UI logic
sw.js         – service worker: app shell + game cache (with Range support)
fflate.min.js – vendored fflate 0.8.2 UMD (MIT)
manifest.json – PWA manifest
icon-*.png    – app icons
```
