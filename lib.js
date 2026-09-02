// heic2jpg — shared helpers. Loaded by worker.js (importScripts), index.html
// (zipStore only) and test.js (require). Pure byte-twiddling, no DOM.
'use strict';

const HEIC2JPG = (() => {
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  const ascii = s => Uint8Array.from(s, c => c.charCodeAt(0));

  // HEIF stores the Exif item as a 4-byte big-endian offset to the TIFF header,
  // then the payload (normally "Exif\0\0" followed by the TIFF). Return the TIFF part.
  function tiffFromExifItem(item) {
    if (item.length < 8) return null;
    const off = ((item[0] << 24) | (item[1] << 16) | (item[2] << 8) | item[3]) >>> 0;
    const s = 4 + off;
    if (s + 8 > item.length) return null;
    const ok = (item[s] === 0x49 && item[s + 1] === 0x49 && item[s + 2] === 0x2a && item[s + 3] === 0) ||
               (item[s] === 0x4d && item[s + 1] === 0x4d && item[s + 2] === 0 && item[s + 3] === 0x2a);
    return ok ? item.slice(s) : null;
  }

  // Copy of the TIFF with the GPS IFD (tag 0x8825) unlinked from IFD0 and every
  // byte it owned zeroed, and Orientation (0x0112) forced to 1 because libheif
  // already applied the rotation to the pixels. Nothing else moves, so every other
  // absolute offset stays valid. Throws on malformed input so the caller drops
  // the metadata instead of writing something corrupt.
  function stripGps(tiff) {
    const t = tiff.slice();
    const le = t[0] === 0x49;
    const need = (p, n) => { if (p < 0 || p + n > t.length) throw new Error('EXIF offset out of range'); };
    const rd16 = p => { need(p, 2); return le ? t[p] | (t[p + 1] << 8) : (t[p] << 8) | t[p + 1]; };
    const rd32 = p => {
      need(p, 4);
      return (le ? t[p] | (t[p + 1] << 8) | (t[p + 2] << 16) | (t[p + 3] << 24)
                 : (t[p] << 24) | (t[p + 1] << 16) | (t[p + 2] << 8) | t[p + 3]) >>> 0;
    };
    const wr16 = (p, v) => { need(p, 2); if (le) { t[p] = v & 255; t[p + 1] = v >> 8; } else { t[p] = v >> 8; t[p + 1] = v & 255; } };

    const ifd0 = rd32(4);
    const count = rd16(ifd0);
    need(ifd0 + 2, 12 * count + 4);
    let gpsEntry = -1, gpsIfd = 0;
    for (let i = 0; i < count; i++) {
      const p = ifd0 + 2 + 12 * i;
      const tag = rd16(p);
      if (tag === 0x0112) wr16(p + 8, 1);
      if (tag === 0x8825) { gpsEntry = p; gpsIfd = rd32(p + 8); }
    }
    if (gpsEntry < 0) return t;

    // zero the GPS IFD and every out-of-line value it points at
    const n = rd16(gpsIfd);
    need(gpsIfd + 2, 12 * n + 4);
    for (let i = 0; i < n; i++) {
      const p = gpsIfd + 2 + 12 * i;
      const size = (TYPE_SIZE[rd16(p + 2)] || 1) * rd32(p + 4);
      if (size > 4) { const v = rd32(p + 8); need(v, size); t.fill(0, v, v + size); }
    }
    t.fill(0, gpsIfd, gpsIfd + 2 + 12 * n + 4);

    // drop the pointer entry from IFD0: shift later entries + next-IFD link up 12 bytes
    const end = ifd0 + 2 + 12 * count + 4;
    t.copyWithin(gpsEntry, gpsEntry + 12, end);
    t.fill(0, end - 12, end);
    wr16(ifd0, count - 1);
    return t;
  }

  function segment(marker, ...parts) {
    const len = parts.reduce((n, p) => n + p.length, 0) + 2;
    if (len > 0xffff) throw new Error('JPEG segment too large');
    const out = new Uint8Array(2 + len);
    out[0] = 0xff; out[1] = marker; out[2] = len >> 8; out[3] = len & 255;
    let o = 4;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  // APP1 Exif segment for a TIFF blob. Throws if it cannot fit in one segment.
  function exifSegment(tiff) {
    return segment(0xe1, ascii('Exif\0\0'), tiff);
  }

  // APP2 ICC_PROFILE segments (chunked at 65519 bytes per the ICC spec).
  function iccSegments(icc) {
    const CHUNK = 0xffff - 2 - 12 - 2;
    const total = Math.ceil(icc.length / CHUNK);
    if (total > 255) throw new Error('ICC profile too large');
    const segs = [];
    for (let i = 0; i < total; i++)
      segs.push(segment(0xe2, ascii('ICC_PROFILE\0'), Uint8Array.of(i + 1, total), icc.subarray(i * CHUNK, (i + 1) * CHUNK)));
    return segs;
  }

  // Insert segments directly after SOI, where the Exif spec wants APP1 (and where
  // Apple's own JPEGs put it). Any Exif or ICC_PROFILE segment the encoder already
  // wrote is dropped first: Chrome's canvas tags its output as sRGB, and two ICC
  // profiles with the same chunk number make readers ignore both.
  function spliceJpeg(jpeg, segs) {
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG');
    const starts = (p, s) => s.split('').every((c, i) => jpeg[p + i] === c.charCodeAt(0));
    const keep = [];
    let p = 2;
    while (p + 4 <= jpeg.length && jpeg[p] === 0xff && jpeg[p + 1] >= 0xe0 && jpeg[p + 1] <= 0xef) {
      const len = 2 + ((jpeg[p + 2] << 8) | jpeg[p + 3]);
      const dup = (jpeg[p + 1] === 0xe1 && starts(p + 4, 'Exif\0\0')) || (jpeg[p + 1] === 0xe2 && starts(p + 4, 'ICC_PROFILE\0'));
      if (!dup) keep.push(jpeg.subarray(p, p + len));
      p += len;
    }
    const parts = [...segs, ...keep, jpeg.subarray(p)];
    const out = new Uint8Array(2 + parts.reduce((n, s) => n + s.length, 0));
    out[0] = 0xff; out[1] = 0xd8;
    let o = 2;
    for (const s of parts) { out.set(s, o); o += s.length; }
    return out;
  }

  const CRC_TABLE = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    return c;
  });
  function crc32(b) {
    let c = -1;
    for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  // Store-only ZIP (method 0): JPEGs don't compress, deflate would only burn CPU.
  // Returns the parts in order so the browser can build a Blob without copying.
  // ponytail: no ZIP64 — throws past 4 GB / 65535 entries, which a phone can't hold anyway.
  function zipStore(entries, date = new Date()) {
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const { name, data } of entries) {
      const n = enc.encode(name), crc = crc32(data);
      const local = new Uint8Array(30 + n.length), lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
      lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true); lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, n.length, true);
      local.set(n, 30);
      const cd = new Uint8Array(46 + n.length), cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true);
      cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, n.length, true);
      cv.setUint32(42, offset, true);
      cd.set(n, 46);
      parts.push(local, data); central.push(cd);
      offset += local.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    if (offset + cdSize > 0xfffffff0 || entries.length > 0xffff) throw new Error('ZIP too large');
    const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return [...parts, ...central, eocd];
  }

  // --- raw libheif calls on a libheif-js image handle -----------------------
  // heif.HEAPU8 is re-read on every access: wasm memory growth detaches the old view.
  const cstr = (heif, p) => { let s = ''; while (heif.HEAPU8[p]) s += String.fromCharCode(heif.HEAPU8[p++]); return s; };
  const u32 = (heif, p) => new DataView(heif.HEAPU8.buffer).getUint32(p, true);
  function checked(heif, fn) {
    const err = heif._malloc(12);              // struct heif_error { int code; int subcode; const char* message; }
    try { fn(err); const code = u32(heif, err); if (code) throw new Error('libheif error ' + code + ': ' + cstr(heif, u32(heif, err + 8))); }
    finally { heif._free(err); }
  }

  // The three readers below take a libheif-js HeifImage (the wrapper with .handle).
  function readExifTiff(heif, img) {
    const h = img.handle.$$.ptr;
    const n = heif._heif_image_handle_get_number_of_metadata_blocks(h, 0);
    if (!n) return null;
    const ids = heif._malloc(4 * n);
    try {
      heif._heif_image_handle_get_list_of_metadata_block_IDs(h, 0, ids, n);
      for (let i = 0; i < n; i++) {
        const id = u32(heif, ids + 4 * i);
        if (cstr(heif, heif._heif_image_handle_get_metadata_type(h, id)) !== 'Exif') continue;
        const size = heif._heif_image_handle_get_metadata_size(h, id);
        const out = heif._malloc(size);
        try {
          checked(heif, err => heif._heif_image_handle_get_metadata(err, h, id, out));
          return tiffFromExifItem(heif.HEAPU8.slice(out, out + size));
        } finally { heif._free(out); }
      }
      return null;
    } finally { heif._free(ids); }
  }

  // Raw ICC profile ('prof' or 'rICC'). nclx-only sources return null.
  // ponytail: an nclx Display-P3 tag could map to a bundled ICC; iPhones always ship 'prof', so not yet.
  function readIcc(heif, img) {
    const h = img.handle.$$.ptr;
    const type = heif._heif_image_handle_get_color_profile_type(h);
    if (type !== 0x70726f66 && type !== 0x72494343) return null;
    const size = heif._heif_image_handle_get_raw_color_profile_size(h);
    if (!size) return null;
    const out = heif._malloc(size);
    try {
      checked(heif, err => heif._heif_image_handle_get_raw_color_profile(err, h, out));
      return heif.HEAPU8.slice(out, out + size);
    } finally { heif._free(out); }
  }

  // Decode the primary image to RGBA. Returns { width, height, data: Uint8ClampedArray }.
  function decodeRgba(heif, img) {
    const r = heif.heif_js_decode_image2(img.handle, heif.heif_colorspace.heif_colorspace_RGB, heif.heif_chroma.heif_chroma_interleaved_RGBA);
    if (!r || r.code) throw new Error('decode failed' + (r && r.message ? ': ' + r.message : ''));
    try {
      const { width, height } = r;
      const ch = r.channels.find(c => c.id === heif.heif_channel.heif_channel_interleaved);
      const data = new Uint8ClampedArray(width * height * 4);
      if (ch.stride === width * 4) data.set(ch.data);
      else for (let y = 0; y < height; y++) data.set(ch.data.subarray(y * ch.stride, y * ch.stride + width * 4), y * width * 4);
      return { width, height, data };
    } finally { heif._heif_image_release(r.image); }
  }

  // Primary image handle from a decoded container; caller frees all returned images.
  function primaryImage(heif, images) {
    return images.find(i => heif._heif_image_handle_is_primary_image(i.handle.$$.ptr)) || images[0];
  }

  return { tiffFromExifItem, stripGps, exifSegment, iccSegments, spliceJpeg, crc32, zipStore,
           readExifTiff, readIcc, decodeRgba, primaryImage };
})();

if (typeof module !== 'undefined') module.exports = HEIC2JPG;
