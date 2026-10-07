# Vendored emulator — EmulatorJS 4.2.3 (N64 subset)

Pocket Player runs N64 ROMs with [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS)
**v4.2.3** (stable, released 2025-07-05). Only the files needed for Nintendo 64 are
vendored here, so the player works fully offline and never touches a CDN.

| File | Upstream source |
|---|---|
| `loader.js` | npm `@emulatorjs/emulatorjs@4.2.3` → `data/loader.js` (unmodified) |
| `emulator.min.js`, `emulator.min.css` | `https://cdn.emulatorjs.org/4.2.3/data/` (byte-identical to `emulator.min.zip` of the same release; unmodified) |
| `compression/extractzip.js` | npm `@emulatorjs/emulatorjs@4.2.3` → `data/compression/extractzip.js` (unmodified; only a fallback) |
| `cores/reports/*.json` | npm `@emulatorjs/core-mupen64plus_next@4.2.3`, `@emulatorjs/core-parallel_n64@4.2.3` → `reports/` (unmodified) |
| `cores/*-wasm.data` | same npm packages — **repacked**, see below |
| `LICENSE` | EmulatorJS licence (GPL-3.0) |
| `cores/LICENSE-mupen64plus_next.txt` | `license.txt` from inside the mupen64plus_next core archive (GPL-2.0) |

## Repacked cores

Upstream ships each core as a **7z** archive that EmulatorJS unpacks in a web worker
built from a `blob:` URL. To keep that worker out of the iOS home-screen app, the
cores were unpacked and repacked **unchanged** as **ZIP** archives under the same file
names; `n64.js` unzips them on the main thread with the already-vendored fflate.
Every file inside is byte-identical to the upstream archive.

| Core file | Upstream 7z (npm integrity, sha256 base64) | Repacked ZIP sha256 |
|---|---|---|
| `mupen64plus_next-wasm.data` | `LaHLzp/aOV466DyleHNTuqFZFC1F7z6pDxCLklJPdsw=` | `0545fa37f7a5aebf4ed36da2f969b12e4351478f3ac26b7da7405939df0a2e53` |
| `mupen64plus_next-legacy-wasm.data` | `QlBy9L+U7sAmM8vpuE9H1oA9wOwbPDuN4+u9LrVhfD8=` | `e2661b7108e8c5067641d7f4cbf355d7241e1aa170b4a4b568deb20ef3733cf1` |
| `parallel_n64-legacy-wasm.data` | `3g24e7LZnIqmydcOmhAQJc7Pjc2D0cWnreJayRmyBIU=` | `3ce2d1164dc96af16f1a6449046223193ba797ab3abfce6d2840e8110202e4e7` |

To reproduce: download the npm files, `tar -xf <core>.data` (libarchive/bsdtar reads
7z), then `tar -a -cf <core>.zip <the extracted files>` and rename back to `.data`.

## Corresponding source (GPL)

- EmulatorJS (GPL-3.0): https://github.com/EmulatorJS/EmulatorJS/tree/v4.2.3
- Core build scripts: https://github.com/EmulatorJS/build — cores built 2025-06-14
  (see `cores/reports/*.json` → `buildStart`)
- RetroArch frontend (GPL-3.0): https://github.com/EmulatorJS/RetroArch
- mupen64plus_next (GPL-2.0): https://github.com/EmulatorJS/mupen64plus-libretro-nx
- parallel_n64 (GPL-2.0): https://github.com/EmulatorJS/parallel-n64

Pocket Player's own glue code (`n64.html`, `n64.js`) does not modify these files; it
configures EmulatorJS through its documented `EJS_*` globals and wraps two runtime
hooks (the core decompressor and `FS.writeFile`) as described in `n64.js`.
