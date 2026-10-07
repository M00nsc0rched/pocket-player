# Pocket Player

A tiny PWA that runs a web game **fully offline, from the device it's installed on**.
Import a game once from a `.zip`, and from then on it launches straight from the
browser's storage — no server, no network, no PC.

Built for **RPG Maker MV** games (which are plain web games under the hood), but it
will serve any static-web game whose zip contains an `index.html` — and it also
plays **Nintendo 64 ROMs** (`.z64` / `.n64` / `.v64`, zipped or bare) in a
vendored, fully offline copy of EmulatorJS (see [N64 games](#n64-games)).

**This tool ships no game content.** Whatever you import stays in your browser's
Cache Storage on your own device; nothing is uploaded anywhere. Only import games
you own.

## How it works

- The page unzips your file **in the browser** (streaming, via
  [fflate](https://github.com/101arrowz/fflate), MIT) and stores every file in
  **Cache Storage** with a proper MIME type.
- A **service worker** answers every game request straight from cache —
  including **HTTP Range** responses, which iOS Safari requires for audio/video
  elements. The game never touches the network.
- `Play` navigates to the shallowest `index.html` found in the zip.

## A library of games (each isolated)

Several games live side by side. Each import gets its **own id**, its **own
cache** (`pp-game-<id>`) and its **own URL base** (`g/<id>/…`), so importing a
new game never clobbers the others. Saves are isolated too: the shim namespaces
each game's `localStorage` by its id (`pp:<id>:…`), so two RPG Maker games can't
overwrite each other's save files.

The original single-slot install (cache `pp-game-v1`, base `game/`) is preserved
untouched — updating the tool leaves an already-installed game and its saves
exactly as they were. Removing one game leaves the rest intact.

## Using it on an iPhone

**The order matters** — on iOS, Safari and an installed home-screen app have
**separate storage**: a game imported in Safari is invisible to the app.

1. Open the player page in Safari → Share → **Add to Home Screen**
   (from the player page itself, never from inside a game).
2. Get the game's zip onto the phone (iCloud Drive / AirDrop / Files).
   For RPG Maker MV, zip the **contents of the `www` folder**.
3. Open the **home-screen icon** → **Import a game (.zip or N64 ROM)** → pick the file →
   wait for the bar. (The screen is kept awake during the import.) Repeat to
   add more games — they stack in the library, each with its own saves.
4. Tap **▶** next to a game to play. Next time, it's two taps: open app → ▶.
   Airplane mode welcome.

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
- Removing the home-screen app deletes the imported games *and* their saves.
- RPG Maker MV audio is OGG; the shim decodes it itself on iOS.

## N64 games

Import a zip that holds an N64 ROM (and no `index.html`), or the bare ROM file.
The player recognises the ROM by its header (all three byte orders), stores it
like any other game (`pp-game-<id>`) and ▶ opens **`n64.html`**, which runs it in
**EmulatorJS 4.2.3** with the **mupen64plus_next** core (GLideN64 graphics, HLE
audio) — vendored under `emu/ejs-4.2.3/`, cached by the service worker in its own
cache (`pp-emu-ejs-4.2.3-r1`), so nothing ever comes from a CDN.

- **Offline:** the emulator (~6 MB) is cached when the service worker installs,
  and again checked when you import an N64 game; the status line says when it
  is ready for offline play.
- **Start:** tap ▶ on the start screen. That tap also unlocks iOS audio (the
  emulator's own AudioContext is created much later, outside any gesture), and
  sets the audio session to *playback*, so sound plays with the silent switch on.
- **Controls:** EmulatorJS's on-screen N64 pad (stick, D-pad, A/B, C-buttons,
  L/R/Z, Start) appears on touch screens; a Bluetooth controller or the keyboard
  work too. Turn the phone sideways. The **✕** at the top saves and goes back to
  the library.
- **Saves:** in-game saves (cartridge EEPROM/SRAM) live in IndexedDB as
  `/data/saves/Mupen64Plus-Next/<ROM key>.srm`, where the key comes from the ROM
  header (e.g. `N64-NFUE-30C7AC50`) — so removing and re-importing the same ROM
  keeps them. They are written every 30 s, whenever the app is hidden, and before
  ✕ leaves. *Export Save File* in the emulator's menu opens the share sheet
  (Save to Files) for a backup; *Import Save File* restores one. Save states
  stay in the browser (IndexedDB).
- **Speed:** N64 emulation in WebAssembly is heavy (no dynarec). If a game is
  slow, open the emulator menu → *Settings → Backend Core Options* and lower
  *4:3 Resolution* to 320x240, then try *Count Per Op* 3. The *Core* setting can
  switch to parallel_n64 (faster renderer, fewer effects) for an A/B test.
- **iOS:** needs iOS 18.4+ (26.2+ on the 26 line); a recent iPhone (15 Pro or
  newer) is recommended for demanding games.

The emulator is GPL software; `emu/ejs-4.2.3/SOURCES.md` lists the upstream
files, their checksums, the corresponding source and the one change made (the
core archives repacked from 7z to ZIP so they unpack on the main thread).

## Files

```
index.html    – the player UI
app.js        – import (zip / N64 ROM) → Cache Storage, library, UI logic
sw.js         – service worker: app shell + game caches (with Range support) + emulator cache
pp-shim.js    – injected into web games: errors, audio rescue, gamepad, save isolation
n64.html      – N64 player page
n64.js        – N64 player: audio unlock, ROM loading, EmulatorJS config, save flushing
emu/          – vendored EmulatorJS 4.2.3, N64 cores only (GPL, see SOURCES.md)
fflate.min.js – vendored fflate 0.8.2 UMD (MIT)
ogg-vorbis-decoder.min.js – vendored OGG Vorbis decoder for iOS
manifest.json – PWA manifest
icon-*.png    – app icons
```
