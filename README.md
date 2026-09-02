# heic2jpg

Convert HEIC photos to JPG in the browser. Nothing is uploaded.

**Use it:** https://lamoon-p.github.io/heic2jpg/

Drop one or more `.heic` files, pick a JPG quality, press Convert, then Download.
One photo downloads as a `.jpg`; several come as a ZIP, and each row has its own
download link too.

## Why

Every online HEIC converter asks you to upload your photos to someone else's
server. This one runs entirely on your device: the decoder (libheif, compiled to
WebAssembly) ships with the page, and after the page loads it makes **no network
requests at all**. Open the browser's Network tab to see for yourself.

## What it preserves, and what it does not

- **Quality.** A slider from 60 to 100 (default 92) with a live size estimate.
  JPG is lossy, so even 100 re-compresses the pixels. There is no lossless path
  from HEIC to JPG. Resolution is never changed.
- **Colour.** The source's ICC profile (Display P3 on iPhones) is copied into the
  JPG, so colours match the original in any viewer that honours profiles. A HEIC
  without an embedded profile is written untagged.
- **EXIF.** Date, camera, lens, exposure and the rest are kept. **The GPS block is
  removed on purpose**, so a shared JPG cannot reveal where it was taken. Rotation
  is baked into the pixels and the orientation tag reset to 1. Maker notes are
  left as they are.
- **HDR.** 10-bit and HDR photos are flattened to 8-bit standard range. Highlight
  detail beyond SDR is lost.
- **Live Photos and bursts.** Only the main still is converted. Motion, depth and
  gain-map data are dropped.
- **Size estimate.** The figure under the slider comes from encoding the largest
  photo once and scaling by pixel count. The true total appears after Convert.
- **Memory.** Converted files stay in the tab until you download. A few hundred
  12-megapixel photos may exhaust a phone browser; convert in smaller batches.
  Files over 100 MB are skipped.

## How it works

`index.html` is the whole UI. It hands each file to `worker.js`, which decodes the
primary image with libheif, draws it on an `OffscreenCanvas`, encodes JPG with the
browser's own encoder, then splices in an APP1 Exif segment (GPS stripped) and
APP2 ICC segments. `lib.js` holds the byte-level helpers and a store-only ZIP writer,
shared with the test.

No build step, no framework, no runtime dependencies beyond the vendored `libheif.js`
and `libheif.wasm` in `vendor/`. Requires a browser with `OffscreenCanvas`
(current Chrome, Firefox, Edge, or Safari 16.4+).

## Development

```sh
python3 -m http.server 8000     # then open http://localhost:8000/
node test.js                    # self-check on synthetic fixtures
node test.js ~/Photos/*.HEIC    # also verify against your own photos (nothing is committed)
```

The fixtures in `test/` were rendered from a generated gradient with macOS `sips`,
so they contain no personal data.

## Licence

Code in this repository is MIT. The vendored decoder is libheif and libde265,
both LGPL-3.0, packaged by libheif-js. See `NOTICE` and `vendor/`.
