// heic2jpg — decode + encode off the main thread. All image bytes stay in this worker.
'use strict';
importScripts('lib.js', 'vendor/libheif.js');
const { readExifTiff, readIcc, decodeRgba, primaryImage, stripGps, exifSegment, iccSegments, spliceJpeg } = HEIC2JPG;

const files = new Map();   // id -> Uint8Array of the original HEIC
let cache = null;          // ponytail: one decoded photo kept for slider estimates; make it an LRU if re-decoding on Convert ever hurts
let heif, decoder;

const ready = fetch('vendor/libheif.wasm').then(r => r.arrayBuffer()).then(wasmBinary => {
  heif = libheif({ wasmBinary });
  decoder = new heif.HeifDecoder();
  if (!heif.calledRun) return new Promise(res => { heif.onRuntimeInitialized = res; });
});

// decoder.decode() frees the previous context, so only one file is open at a time.
function withPrimary(bytes, fn) {
  const images = decoder.decode(bytes);
  try {
    if (!images.length) throw new Error('not a HEIC/HEIF file, or an unsupported variant');
    return fn(primaryImage(heif, images));
  } finally { for (const i of images) i.free(); }
}

function open(id, buffer) {
  const bytes = new Uint8Array(buffer);
  const info = withPrimary(bytes, img => ({ width: img.get_width(), height: img.get_height() }));
  files.set(id, bytes);
  return info;
}

async function encode(id, quality) {
  if (!cache || cache.id !== id) {
    cache = null; // drop the old one before decoding the next
    cache = withPrimary(files.get(id), img => ({ id, image: decodeRgba(heif, img), tiff: readExifTiff(heif, img), icc: readIcc(heif, img) }));
  }
  const { image, tiff, icc } = cache;
  const canvas = new OffscreenCanvas(image.width, image.height);
  canvas.getContext('2d').putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());

  const warnings = [], segs = [];
  if (!tiff) warnings.push('no EXIF in source');
  else try { segs.push(exifSegment(stripGps(tiff))); } catch (e) { warnings.push('EXIF dropped (' + e.message + ')'); }
  if (!icc) warnings.push('no colour profile in source');
  else try { segs.push(...iccSegments(icc)); } catch (e) { warnings.push('colour profile dropped (' + e.message + ')'); }

  const bytes = spliceJpeg(jpeg, segs);
  return { bytes, size: bytes.length, warnings };
}

async function handle(msg) {
  await ready;
  switch (msg.type) {
    case 'open': return { type: 'opened', id: msg.id, ...open(msg.id, msg.buffer) };
    case 'encode': return { type: 'encoded', id: msg.id, quality: msg.quality, ...(await encode(msg.id, msg.quality)) };
    case 'reset': files.clear(); cache = null; return null;
    default: throw new Error('unknown message ' + msg.type);
  }
}

// Serialise: an estimate and a convert must never decode concurrently (memory).
let queue = Promise.resolve();
self.onmessage = e => {
  queue = queue.then(() => handle(e.data))
    .then(reply => { if (reply) self.postMessage(reply, reply.bytes ? [reply.bytes.buffer] : []); })
    .catch(err => self.postMessage({ type: 'error', id: e.data.id, message: err.message || String(err) }));
};
