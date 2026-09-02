// heic2jpg self-check. Run: node test.js [your-photo.heic ...]
// Fixtures are synthetic (test/fix.png rendered by macOS sips); extra HEICs on the
// command line get the real-world checks (GPS gone, orientation 1, EXIF/ICC kept).
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert'), { execFileSync } = require('child_process');
const L = require('./lib.js');

const wasmBinary = fs.readFileSync(path.join(__dirname, 'vendor/libheif.wasm'));
const heif = require('./vendor/libheif.js')({ wasmBinary });
assert(heif.calledRun, 'wasm should initialise synchronously when given the binary');

// ---- synthetic little-endian TIFF: IFD0 { Make, Orientation=6, ExifIFD, GPSIFD } ----
function buildTiff() {
  const b = new Uint8Array(512), v = new DataView(b.buffer);
  b.set([0x49, 0x49, 0x2a, 0], 0); v.setUint32(4, 8, true);
  const entry = (at, tag, type, count, value) => { v.setUint16(at, tag, true); v.setUint16(at + 2, type, true); v.setUint32(at + 4, count, true); v.setUint32(at + 8, value, true); };
  // IFD0 at 8: 4 entries -> 8 + 2 + 48 + 4 = 62
  v.setUint16(8, 4, true);
  entry(10, 0x010f, 2, 6, 100);          // Make -> "Apple\0" at 100
  entry(22, 0x0112, 3, 1, 6);            // Orientation = 6
  entry(34, 0x8769, 4, 1, 120);          // Exif IFD at 120
  entry(46, 0x8825, 4, 1, 160);          // GPS IFD at 160
  v.setUint32(58, 0, true);
  b.set(Buffer.from('Apple\0'), 100);
  // Exif IFD at 120: 1 entry DateTimeOriginal -> 20 bytes at 140
  v.setUint16(120, 1, true); entry(122, 0x9003, 2, 20, 140); v.setUint32(134, 0, true);
  b.set(Buffer.from('2026:09:02 12:34:56\0'), 140);
  // GPS IFD at 160: 2 entries -> 160 + 2 + 24 + 4 = 190
  v.setUint16(160, 2, true);
  entry(162, 0x0001, 2, 2, 0x004e);      // GPSLatitudeRef "N" inline
  entry(174, 0x0002, 5, 3, 200);         // GPSLatitude 3 RATIONALs at 200 (24 bytes)
  v.setUint32(186, 0, true);
  for (let i = 0; i < 24; i++) b[200 + i] = 0xa5;   // sentinel: must be zeroed
  return b;
}
function readIfd0(t) {
  const le = t[0] === 0x49, v = new DataView(t.buffer, t.byteOffset);
  const ifd0 = v.getUint32(4, le), n = v.getUint16(ifd0, le), tags = {};
  for (let i = 0; i < n; i++) { const p = ifd0 + 2 + 12 * i; tags[v.getUint16(p, le)] = { type: v.getUint16(p + 2, le), count: v.getUint32(p + 4, le), value: v.getUint32(p + 8, le), short: v.getUint16(p + 8, le) }; }
  return { n, tags, v, le };
}

{
  const t = L.stripGps(buildTiff());
  const { n, tags } = readIfd0(t);
  assert.strictEqual(n, 3, 'IFD0 loses exactly the GPS entry');
  assert(!(0x8825 in tags), 'GPS pointer removed');
  assert.strictEqual(tags[0x0112].short, 1, 'orientation forced to 1');
  assert.strictEqual(Buffer.from(t.subarray(100, 105)).toString(), 'Apple', 'Make untouched at its old offset');
  assert.strictEqual(tags[0x8769].value, 120, 'Exif IFD pointer survives the shift');
  assert.strictEqual(Buffer.from(t.subarray(140, 159)).toString(), '2026:09:02 12:34:56', 'DateTimeOriginal untouched');
  assert(t.subarray(160, 190).every(x => x === 0) && t.subarray(200, 224).every(x => x === 0), 'GPS IFD and its values zeroed');
  assert.deepStrictEqual(L.stripGps(t), t, 'idempotent');
  const bad = buildTiff(); new DataView(bad.buffer).setUint32(54, 5000, true);   // GPS pointer out of range
  assert.throws(() => L.stripGps(bad), /out of range/, 'malformed EXIF throws instead of corrupting');
  console.log('ok  stripGps');
}

// ---- JPEG splice: SOI, APP1 Exif, APP2 ICC x2, then the original segments ----
function segments(j) {
  const out = []; let p = 2;
  while (p < j.length && j[p] === 0xff && j[p + 1] !== 0xda) { const len = (j[p + 2] << 8) | j[p + 3]; out.push({ marker: j[p + 1], start: p, len }); p += 2 + len; }
  return out;
}
{
  const jpg = new Uint8Array(fs.readFileSync(path.join(__dirname, 'test/fix.jpg')));
  const tiff = L.stripGps(buildTiff());
  const icc = new Uint8Array(70000).map((_, i) => i & 255);          // forces two APP2 chunks
  const out = L.spliceJpeg(jpg, [L.exifSegment(tiff), ...L.iccSegments(icc)]);
  const segs = segments(out);
  // sips writes its own Exif APP1 into fix.jpg; spliceJpeg must drop encoder metadata, keep APP0 and the rest
  const isMeta = (j, s) => s.marker === 0xe2 || (s.marker === 0xe1 && j[s.start + 4] === 0x45);
  const orig = segments(jpg).filter(s => !isMeta(jpg, s));
  assert(segments(jpg).some(s => isMeta(jpg, s)), 'fixture has encoder-written metadata to remove');
  const tail = (j, sg) => j.subarray(sg[sg.length - 1].start + 2 + sg[sg.length - 1].len);
  assert.deepStrictEqual(segs.slice(0, 3).map(s => s.marker), [0xe1, 0xe2, 0xe2]);
  assert.strictEqual(Buffer.from(out.subarray(segs[0].start + 4, segs[0].start + 10)).toString('latin1'), 'Exif\0\0');
  assert.deepStrictEqual([...out.subarray(segs[0].start + 10, segs[0].start + 10 + tiff.length)], [...tiff], 'TIFF embedded verbatim');
  assert.strictEqual(Buffer.from(out.subarray(segs[1].start + 4, segs[1].start + 16)).toString('latin1'), 'ICC_PROFILE\0');
  assert.deepStrictEqual([out[segs[1].start + 16], out[segs[1].start + 17], out[segs[2].start + 16], out[segs[2].start + 17]], [1, 2, 2, 2], 'chunk numbering');
  assert.deepStrictEqual(segs.slice(3).map(s => s.marker), orig.map(s => s.marker), 'original non-metadata segments follow intact');
  assert.deepStrictEqual([...tail(out, segs)], [...tail(jpg, segments(jpg))], 'image payload byte-identical');
  assert.throws(() => L.exifSegment(new Uint8Array(70000)), /too large/);
  // an encoder-written sRGB ICC (what Chrome's canvas emits) must be replaced, not duplicated
  const tagged = L.spliceJpeg(jpg, L.iccSegments(new Uint8Array(456).fill(1)));
  const again = L.spliceJpeg(tagged, [L.exifSegment(tiff), ...L.iccSegments(new Uint8Array(536).fill(2))]);
  const iccs = segments(again).filter(s => s.marker === 0xe2);
  assert.strictEqual(iccs.length, 1, 'exactly one ICC segment');
  assert.strictEqual(iccs[0].len, 2 + 14 + 536, 'and it is ours');
  assert.deepStrictEqual(segments(again).slice(2).map(s => s.marker), orig.map(s => s.marker), 'APP0 and the rest kept');
  console.log('ok  spliceJpeg');
}

// ---- ZIP: two entries, verified by the system unzip ----
{
  const parts = L.zipStore([{ name: 'a.jpg', data: Uint8Array.from([1, 2, 3]) }, { name: 'photo (2).jpg', data: new Uint8Array(1000).fill(7) }]);
  const zip = Buffer.concat(parts.map(p => Buffer.from(p)));
  assert.strictEqual(zip.readUInt32LE(zip.length - 22), 0x06054b50, 'EOCD present');
  assert.strictEqual(zip.readUInt16LE(zip.length - 12), 2, 'two entries');
  assert.strictEqual(L.crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 check value');
  const tmp = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'heic2jpg-')), 't.zip');
  fs.writeFileSync(tmp, zip);
  const listing = execFileSync('unzip', ['-t', tmp]).toString();
  assert(/a\.jpg.*OK/.test(listing) && /photo \(2\)\.jpg.*OK/.test(listing) && /No errors/.test(listing), listing);
  console.log('ok  zipStore');
}

// ---- real decode of the synthetic HEIC ----
function withPrimary(file, fn) {
  const decoder = new heif.HeifDecoder();
  const images = decoder.decode(new Uint8Array(fs.readFileSync(file)));
  try { assert(images.length, 'decoded ' + file); return fn(L.primaryImage(heif, images)); }
  finally { for (const i of images) i.free(); }
}
{
  withPrimary(path.join(__dirname, 'test/fix.heic'), img => {
    const { width, height, data } = L.decodeRgba(heif, img);
    assert.strictEqual(`${width}x${height}`, '96x64');
    const px = (x, y) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
    // fix.png is a gradient: red rises with x, green with y, blue = 128
    assert(px(0, 0)[0] < 30 && px(95, 0)[0] > 220, 'red gradient across x: ' + px(0, 0) + ' / ' + px(95, 0));
    assert(px(0, 0)[1] < 30 && px(0, 63)[1] > 220, 'green gradient across y');
    assert(Math.abs(px(48, 32)[2] - 128) < 12 && px(48, 32)[3] === 255, 'blue ~128, alpha 255');
    assert.strictEqual(L.readExifTiff(heif, img), null, 'sips fixture carries no EXIF');
    assert.strictEqual(L.readIcc(heif, img), null, 'sips fixture is nclx-only, no ICC bytes');
  });
  console.log('ok  decodeRgba');
}

// ---- optional: real photos from the command line ----
for (const file of process.argv.slice(2)) {
  withPrimary(file, img => {
    const w = img.get_width(), h = img.get_height();
    const tiff = L.readExifTiff(heif, img), icc = L.readIcc(heif, img);
    assert(tiff, 'expected EXIF in ' + file);
    const before = readIfd0(tiff), after = readIfd0(L.stripGps(tiff));
    assert(!(0x8825 in after.tags), 'GPS removed');
    assert.strictEqual(after.tags[0x0112] && after.tags[0x0112].short, 1, 'orientation 1');
    assert.strictEqual(after.n, before.n - (0x8825 in before.tags ? 1 : 0));
    assert(0x8769 in after.tags, 'Exif IFD kept');
    const t0 = Date.now(); const { width, height } = L.decodeRgba(heif, img); const ms = Date.now() - t0;
    assert.strictEqual(`${width}x${height}`, `${w}x${h}`);
    console.log(`ok  ${path.basename(file)} ${w}x${h} decode ${ms}ms exif ${tiff.length}B gps:${0x8825 in before.tags ? 'removed' : 'none'} orientation ${before.tags[0x0112] ? before.tags[0x0112].short : '-'}→1 icc ${icc ? icc.length + 'B' : 'none'}`);
  });
}
let p = heif._heif_get_version(), ver = ''; while (heif.HEAPU8[p]) ver += String.fromCharCode(heif.HEAPU8[p++]);
console.log('all good · libheif ' + ver);
