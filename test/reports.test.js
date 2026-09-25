'use strict';
// Reports & moderation workstream tests (docs/ARCHITECTURE.md §6 "Reports & ratings", §7 "Reports & moderation").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { startTestServer } = require('./helpers');

// ───────────── image fixtures (built byte by byte; no image library needed) ─────────────
const SECRET_GPS = 'GPS-SECRET-31.4167N-73.0833E';
const SECRET_PHONE_TEXT = 'Owner phone 03219876543';

function jpegSeg(marker, payload) {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(payload.length + 2);
  return Buffer.concat([Buffer.from([0xff, marker]), len, payload]);
}
function exifWithGps() {
  const b = Buffer.alloc(80);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(1, 8); // IFD0: one entry → GPS IFD pointer (tag 0x8825)
  b.writeUInt16LE(0x8825, 10); b.writeUInt16LE(4, 12); b.writeUInt32LE(1, 14); b.writeUInt32LE(26, 18); b.writeUInt32LE(0, 22);
  b.writeUInt16LE(2, 26); // GPS IFD: GPSLatitudeRef 'N', GPSLatitude 31/1 25/1 1234/100
  b.writeUInt16LE(0x0001, 28); b.writeUInt16LE(2, 30); b.writeUInt32LE(2, 32); b.write('N\0', 36, 'latin1');
  b.writeUInt16LE(0x0002, 40); b.writeUInt16LE(5, 42); b.writeUInt32LE(3, 44); b.writeUInt32LE(56, 48); b.writeUInt32LE(0, 52);
  [31, 1, 25, 1, 1234, 100].forEach((v, i) => b.writeUInt32LE(v, 56 + i * 4));
  return Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), b, Buffer.from(SECRET_GPS, 'latin1')]);
}
function makeJpeg({ variant = 0 } = {}) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSeg(0xe0, Buffer.from([...Buffer.from('JFIF\0', 'latin1'), 1, 1, 0, 0, 1, 0, 1, 0, 0])),
    jpegSeg(0xe1, exifWithGps()),
    jpegSeg(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta exif:GPSLatitude="${SECRET_GPS}"/>`, 'latin1')),
    jpegSeg(0xed, Buffer.from('Photoshop 3.0\u00008BIM\x04\x04 by-line ' + SECRET_PHONE_TEXT, 'latin1')),
    jpegSeg(0xfe, Buffer.from(`Comment: ${SECRET_PHONE_TEXT}`, 'latin1')),
    jpegSeg(0xdb, Buffer.from([0, ...Array.from({ length: 64 }, (_, i) => (i + variant) % 255 + 1)])),
    jpegSeg(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
    jpegSeg(0xc4, Buffer.from([0, 1, ...Array(15).fill(0), 0])),
    jpegSeg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, variant & 0xff]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from('TRAILER ' + SECRET_GPS, 'latin1'), // data after EOI must be dropped too
  ]);
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
function makePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', Buffer.from(`Comment\0${SECRET_PHONE_TEXT} at ${SECRET_GPS}`, 'latin1')),
    pngChunk('tIME', Buffer.from([0x07, 0xea, 9, 25, 12, 0, 0])),
    pngChunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 128, 255]))),
    pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${SECRET_GPS}`, 'latin1')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
function riffChunk(fourcc, data) {
  const h = Buffer.alloc(8); h.write(fourcc, 0, 'latin1'); h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function makeWebp() {
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04 | 0x10; // EXIF + XMP + alpha flags
  const body = Buffer.concat([
    riffChunk('VP8X', vp8x),
    riffChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0x10])), // odd length → padded
    riffChunk('EXIF', exifWithGps()),
    riffChunk('XMP ', Buffer.from(`<x:xmpmeta>${SECRET_GPS}</x:xmpmeta>`, 'latin1')),
  ]);
  const h = Buffer.alloc(12); h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(4 + body.length, 4); h.write('WEBP', 8, 'latin1');
  return Buffer.concat([h, body]);
}

// ───────────── helpers ─────────────
const WORDS = ('tap pipe gate queue filter tank handle roof wall floor bucket smell colour taste leak crack wire pump meter door '
  + 'rust mud trash dust sign board light fan bench shade road drain puddle crowd guard lock chain valve hose cup jug').split(' ');
const uniqueText = () => 'Observed ' + Array.from({ length: 14 }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(' ')
  + ' ' + Math.random().toString(36).slice(2, 8);
const karachiLocal = (minutesAgo = 60) => new Date(Date.now() + 5 * 3600e3 - minutesAgo * 60e3).toISOString().slice(0, 16);

test('reports, ratings, verification & moderation', async (t) => {
  const s = await startTestServer({ env: { SMS_PROVIDER: 'console' } });
  const config = require('../server/config');
  const images = require('../server/lib/images');
  const { runRetention } = require('../server/lib/retention');

  // Capture every log line so we can prove phone numbers are never logged.
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.map(String).join(' ')); };
  t.after(async () => { Object.assign(console, orig); await s.close(); });

  const publicBodies = [];
  const phones = [];
  let phoneSeq = 1000000;
  const newPhone = () => { const p = `0300${String(phoneSeq++).padStart(7, '0')}`; phones.push(p); return p; };
  const clearIp = () => s.db.prepare("DELETE FROM rate_events WHERE bucket LIKE '%ip'").run();

  const plant = s.insertPlant({ latitude: 31.41, longitude: 73.08, coord_status: 'verified' });
  const plantB = s.insertPlant();
  const demo = s.insertPlant({ plant_code: 'DEMO-0001', is_demo: 1 });

  async function pub(p, opts) {
    const res = await s.fetch(p, opts);
    const text = await res.text();
    publicBodies.push(text);
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body, headers: res.headers };
  }
  async function submit(fields = {}, photos = [], { keepIp = false } = {}) {
    if (!keepIp) clearIp();
    const fd = new FormData();
    const base = { plantCode: plant.plant_code, category: 'broken_equipment', description: uniqueText(), observedAt: karachiLocal(), consent: 'true' };
    const all = { ...base, ...fields };
    if (!('phone' in fields)) all.phone = newPhone();
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null) fd.append(k, String(v));
    for (const ph of photos) fd.append('photos', new Blob([ph.buf], { type: ph.type || 'image/jpeg' }), ph.name || 'photo.jpg');
    const r = await pub('/api/reports', { method: 'POST', body: fd });
    return { ...r, phone: all.phone };
  }
  const moderator = await s.login('moderator');
  const admin = await s.login('admin');
  const editor = await s.login('editor');
  const reportId = (ref) => s.db.prepare('SELECT id FROM reports WHERE reference = ?').get(ref).id;
  const detail = async (ref) => (await moderator.fetch(`/api/admin/reports/${reportId(ref)}`)).json();
  const decide = (ref, json) => moderator.fetch(`/api/admin/reports/${reportId(ref)}/decision`, { method: 'POST', json });

  await t.test('image stripping: JPEG, PNG, WebP (unit)', () => {
    const jpeg = makeJpeg();
    assert.deepEqual(images.listMetadata(jpeg).sort(), ['APP1', 'APP1', 'APP13', 'COM'].sort());
    const j = images.processPhoto(jpeg);
    assert.equal(j.mime, 'image/jpeg');
    assert.deepEqual(images.listMetadata(j.buffer), []);
    const js = j.buffer.toString('latin1');
    for (const secret of ['Exif', SECRET_GPS, SECRET_PHONE_TEXT, 'Photoshop', 'TRAILER']) assert.ok(!js.includes(secret), `JPEG still contains ${secret}`);
    assert.ok(js.includes('JFIF'), 'APP0 JFIF kept');
    assert.ok(j.buffer.includes(Buffer.from([0xff, 0xc0])) && j.buffer.includes(Buffer.from([0xff, 0xdb])), 'SOF/DQT kept');
    assert.ok(j.buffer.includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])), 'entropy data kept byte-for-byte');
    assert.deepEqual([...j.buffer.subarray(-2)], [0xff, 0xd9]);

    const png = images.processPhoto(makePng());
    assert.deepEqual(png.removed.sort(), ['iTXt', 'tEXt', 'tIME']);
    const ps = png.buffer.toString('latin1');
    assert.ok(!ps.includes(SECRET_GPS) && !ps.includes('tEXt') && !ps.includes('tIME') && ps.includes('IDAT') && ps.includes('IEND'));
    assert.deepEqual(images.listMetadata(png.buffer), []); // re-parse also verifies every CRC

    const webp = images.processPhoto(makeWebp());
    assert.deepEqual(webp.removed.sort(), ['EXIF', 'XMP']);
    assert.equal(webp.buffer.readUInt32LE(4), webp.buffer.length - 8, 'RIFF size fixed');
    assert.equal(webp.buffer[20] & 0x0c, 0, 'VP8X EXIF/XMP flags cleared');
    assert.equal(webp.buffer[20] & 0x10, 0x10, 'other VP8X flags kept');
    assert.ok(!webp.buffer.toString('latin1').includes(SECRET_GPS));

    // Corrupt inputs are rejected with a clear error
    const truncated = makeJpeg().subarray(0, 60);
    assert.throws(() => images.processPhoto(truncated), (e) => e.code === 'corrupt_file' && /damaged or incomplete/.test(e.message));
    const badCrc = makePng(); badCrc[badCrc.length - 30] ^= 0xff;
    assert.throws(() => images.processPhoto(badCrc), (e) => e.code === 'corrupt_file');
    assert.throws(() => images.processPhoto(Buffer.from('GIF89a-not-allowed-here')), (e) => e.code === 'invalid_file_type');
  });

  let photoReport;
  await t.test('submission with photos stores stripped files that are private by default', async () => {
    const r = await submit({ category: 'dirty_surroundings' }, [{ buf: makeJpeg(), name: 'IMG_home.jpg' }, { buf: makePng(), type: 'image/png', name: 'x.png' }]);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.reference, /^TW-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    assert.equal(r.body.status, 'pending');
    assert.equal(r.body.photoCount, 2);
    assert.equal(r.body.ratingRecorded, false);
    assert.equal(r.body.statusUrl, `/status.html?ref=${r.body.reference}`);
    photoReport = r;
    const files = s.db.prepare(`SELECT f.* FROM files f JOIN report_photos rp ON rp.file_id = f.id WHERE rp.report_id = ?`).all(reportId(r.body.reference));
    assert.equal(files.length, 2);
    for (const f of files) {
      assert.equal(f.metadata_stripped, 1);
      assert.match(f.storage_path, /^photos\/[0-9a-f]{32}\.(jpg|png)$/);
      assert.equal(f.original_name, null, 'client file names are not kept');
      const bytes = fs.readFileSync(path.join(config.uploadDir, f.storage_path));
      const txt = bytes.toString('latin1');
      assert.ok(!txt.includes(SECRET_GPS) && !txt.includes(SECRET_PHONE_TEXT) && !txt.includes('Exif') && !txt.includes('tEXt'));
      assert.deepEqual(images.listMetadata(bytes), []);
    }
    const d = await detail(r.body.reference);
    assert.equal(d.photos.length, 2);
    const [p1] = d.photos;
    assert.equal(p1.moderationStatus, 'pending');
    assert.equal(p1.public, false);
    assert.equal((await pub(`/api/photos/${p1.id}`)).status, 404, 'unmoderated photo is not public');
    assert.equal((await moderator.fetch(p1.url)).status, 200);
    assert.equal((await editor.fetch(p1.url)).status, 403, 'admin photo route needs reports:read');
    assert.equal((await s.fetch(p1.url)).status, 401);
    // Approve privately: still not public
    let m = await moderator.fetch(`/api/admin/photos/${p1.id}/moderate`, { method: 'POST', json: { action: 'approve' } });
    assert.equal(m.status, 400, 'public must be chosen explicitly');
    m = await moderator.fetch(`/api/admin/photos/${p1.id}/moderate`, { method: 'POST', json: { action: 'approve', public: false } });
    assert.equal(m.status, 200);
    assert.equal((await pub(`/api/photos/${p1.id}`)).status, 404);
    m = await moderator.fetch(`/api/admin/photos/${p1.id}/moderate`, { method: 'POST', json: { action: 'approve', public: true } });
    assert.equal(m.status, 400, 'publishing requires a note documenting the privacy check');
    m = await moderator.fetch(`/api/admin/photos/${p1.id}/moderate`, { method: 'POST', json: { action: 'approve', public: true, note: 'Checked: no faces, numbers or private details' } });
    assert.equal(m.status, 200);
    const served = await s.fetch(`/api/photos/${p1.id}`);
    assert.equal(served.status, 200);
    assert.match(served.headers.get('content-type'), /^image\//);
  });

  await t.test('invalid file types are rejected and nothing is stored', async () => {
    const before = s.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n;
    const filesBefore = fs.readdirSync(path.join(config.uploadDir, 'photos')).length;
    let r = await submit({}, [{ buf: Buffer.from('GIF89a\x01\x00\x01\x00 pretend gif data', 'latin1'), type: 'image/jpeg', name: 'fake.jpg' }]);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_file_type');
    assert.equal(r.body.error.details.field, 'photos');
    r = await submit({}, [{ buf: makeJpeg().subarray(0, 70), name: 'broken.jpg' }]);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'corrupt_file');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM reports').get().n, before);
    assert.equal(fs.readdirSync(path.join(config.uploadDir, 'photos')).length, filesBefore);
  });

  await t.test('photo count and size limits', async () => {
    const four = Array.from({ length: 4 }, (_, i) => ({ buf: makeJpeg({ variant: i }) }));
    let r = await submit({}, four);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'too_many_files');
    assert.equal(r.body.error.details.field, 'photos');
    const big = Buffer.concat([makeJpeg(), Buffer.alloc(config.uploads.maxPhotoBytes)]);
    r = await submit({}, [{ buf: big }]);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'file_too_large');
    assert.equal(r.body.error.details.field, 'photos');
  });

  await t.test('field validation', async () => {
    const cases = [
      [{ description: 'too short' }, 400, 'description'],
      [{ description: 'x'.repeat(2001) }, 400, 'description'],
      [{ observedAt: karachiLocal(-24 * 60) }, 400, 'observedAt'],
      [{ observedAt: karachiLocal(91 * 24 * 60) }, 400, 'observedAt'],
      [{ observedAt: '2026-02-30T10:00' }, 400, 'observedAt'],
      [{ consent: 'false' }, 400, 'consent'],
      [{ phone: '12345' }, 400, 'phone'],
      [{ category: 'rumour' }, 400, 'category'],
      [{ plantCode: 'NOPE-9999' }, 422, 'plantCode'],
      [{ plantCode: demo.plant_code }, 422, 'plantCode'],
      [{ shareProximity: 'true', proximityLat: 'abc', proximityLng: '73' }, 400, 'proximityLat'],
    ];
    for (const [fields, status, field] of cases) {
      const r = await submit(fields);
      assert.equal(r.status, status, `${JSON.stringify(fields).slice(0, 60)} → ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.details.field, field);
    }
    const ok = await submit({ observedAt: karachiLocal(89 * 24 * 60) });
    assert.equal(ok.status, 201, '89 days ago is accepted');
  });

  await t.test('rate limits and cooldown return 429 with retryAfterSec', async () => {
    const phone = newPhone();
    const plants = [plant, ...Array.from({ length: 5 }, () => s.insertPlant())];
    let r = await submit({ phone, plantCode: plants[0].plant_code });
    assert.equal(r.status, 201);
    r = await submit({ phone, plantCode: plants[0].plant_code });
    assert.equal(r.status, 429, 'same phone + same plant within 30 minutes');
    assert.ok(r.body.error.details.retryAfterSec > 0 && r.body.error.details.retryAfterSec <= 1800);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
    for (let i = 1; i < 5; i++) assert.equal((await submit({ phone, plantCode: plants[i].plant_code })).status, 201);
    r = await submit({ phone, plantCode: plants[5].plant_code });
    assert.equal(r.status, 429, '6th report from one phone in 24 h');
    assert.ok(r.body.error.details.retryAfterSec > 0);

    clearIp();
    for (let i = 0; i < 10; i++) assert.equal((await submit({ plantCode: plantB.plant_code }, [], { keepIp: true })).status, 201);
    r = await submit({ plantCode: plantB.plant_code }, [], { keepIp: true });
    assert.equal(r.status, 429, '11th report from one IP in an hour');
    assert.ok(r.body.error.details.retryAfterSec > 0);
    clearIp();
  });

  await t.test('duplicate text raises risk and queues for review, but the report stays pending', async () => {
    const text = uniqueText() + ' the tap near the main gate has been broken for three days and water spills everywhere';
    const first = await submit({ description: text, plantCode: plant.plant_code });
    const second = await submit({ description: '  ' + text.toUpperCase() + '!!', plantCode: plantB.plant_code });
    assert.equal(second.status, 201);
    assert.equal(second.body.status, 'pending');
    assert.ok(!('riskScore' in second.body) && !JSON.stringify(second.body).toLowerCase().includes('risk'), 'no risk data in public response');
    const d = await detail(second.body.reference);
    assert.equal(d.status, 'pending', 'never auto-rejected');
    assert.equal(d.reviewQueue, true);
    assert.ok(d.riskScore >= 40);
    assert.equal(d.riskLevel, 'high');
    const dup = d.riskReasons.find((x) => x.code === 'duplicate_text');
    assert.ok(dup && dup.weight > 0 && dup.detail.includes(first.body.reference));
    assert.ok(d.similarReports.some((x) => x.reference === first.body.reference && x.similarity === 1));
    assert.ok(d.events.some((e) => e.action === 'auto_flagged'));
    const list = await (await moderator.fetch('/api/admin/reports?queue=1')).json();
    assert.ok(list.items.some((x) => x.reference === second.body.reference));
    assert.ok(!JSON.stringify(list).includes('threshold') && !JSON.stringify(d).includes('threshold'), 'threshold never exposed');
    // Near-duplicate (one word changed) is also detected
    const near = await submit({ description: text.replace('broken', 'damaged'), plantCode: plant.plant_code });
    const nd = await detail(near.body.reference);
    assert.ok(nd.riskReasons.some((x) => x.code === 'duplicate_text' || x.code === 'near_duplicate_text'));
    assert.equal(s.db.prepare('SELECT status FROM reports WHERE reference = ?').get(first.body.reference).status, 'pending');
  });

  await t.test('other abuse signals: honeypot, duplicate image, targeting, history, blocked reporter', async () => {
    const target = s.insertPlant();
    const codes = async (ref) => (await detail(ref)).riskReasons.map((x) => x.code);
    // Honeypot: silently accepted with the same response shape, held in the review queue
    const hp = await submit({ plantCode: target.plant_code, website: 'http://spam.example' });
    assert.equal(hp.status, 201);
    assert.equal(hp.body.status, 'pending');
    const hpd = await detail(hp.body.reference);
    assert.ok(hpd.reviewQueue && hpd.riskReasons.some((x) => x.code === 'honeypot'));
    // Duplicate image (hash of stripped bytes), even from a different phone
    const img = makeJpeg({ variant: 42 });
    await submit({ plantCode: target.plant_code }, [{ buf: img }]);
    const dupImg = await submit({ plantCode: plantB.plant_code }, [{ buf: img }]);
    assert.ok((await codes(dupImg.body.reference)).includes('duplicate_image'));
    // Repeated targeting: same phone, same plant, 3rd report within 7 days (cooldown expiry simulated)
    const phone = newPhone();
    const passCooldown = () => s.db.prepare("DELETE FROM rate_events WHERE bucket = 'report:phone-plant'").run();
    const other = s.insertPlant();
    await submit({ phone, plantCode: other.plant_code }); passCooldown();
    await submit({ phone, plantCode: other.plant_code }); passCooldown();
    const third = await submit({ phone, plantCode: other.plant_code });
    assert.ok((await codes(third.body.reference)).includes('repeated_targeting'));
    // Burst by one phone across plants
    const burstPhone = newPhone();
    let last;
    for (let i = 0; i < 3; i++) last = await submit({ phone: burstPhone, plantCode: s.insertPlant().plant_code });
    assert.ok((await codes(last.body.reference)).includes('reporter_burst'));
    // History of rejected reports, then a blocked reporter: still accepted and pending, never auto-rejected
    const hist = newPhone();
    const h1 = await submit({ phone: hist, plantCode: s.insertPlant().plant_code });
    const repId = s.db.prepare('SELECT reporter_id FROM reports WHERE reference = ?').get(h1.body.reference).reporter_id;
    s.db.prepare('UPDATE reporters SET rejected_reports = 3, confirmed_reports = 1 WHERE id = ?').run(repId);
    const h2 = await submit({ phone: hist, plantCode: s.insertPlant().plant_code });
    assert.ok((await codes(h2.body.reference)).includes('reporter_history'));
    await moderator.fetch(`/api/admin/reporters/${repId}/status`, { method: 'POST', json: { status: 'blocked', reason: 'Coordinated false reports' } });
    const h3 = await submit({ phone: hist, plantCode: s.insertPlant().plant_code });
    assert.equal(h3.status, 201);
    const h3d = await detail(h3.body.reference);
    assert.ok(h3d.riskReasons.some((x) => x.code === 'reporter_blocked'));
    assert.equal(h3d.reviewQueue, true);
    assert.equal(h3d.status, 'pending');
    await moderator.fetch(`/api/admin/reporters/${repId}/status`, { method: 'POST', json: { status: 'active', reason: 'Reviewed' } });
  });

  await t.test('SMS daily cap per phone', async () => {
    const phone = newPhone();
    for (let i = 0; i < 5; i++) {
      clearIp();
      s.db.prepare("DELETE FROM rate_events WHERE bucket = 'sms:phone'").run(); // simulate the 60 s cooldown passing
      assert.equal((await pub('/api/verify/start', { method: 'POST', json: { phone } })).status, 200);
    }
    s.db.prepare("DELETE FROM rate_events WHERE bucket = 'sms:phone'").run();
    const r = await pub('/api/verify/start', { method: 'POST', json: { phone } });
    assert.equal(r.status, 429);
    assert.ok(r.body.error.details.retryAfterSec > 0);
  });

  let verifiedToken, verifiedPhone;
  await t.test('SMS console flow, wrong-code attempt limit, disabled SMS', async () => {
    const phone = newPhone();
    let r = await pub('/api/verify/start', { method: 'POST', json: { phone } });
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.equal(r.body.sent, true);
    assert.equal(r.body.expiresInSec, 600);
    assert.match(r.body.devCode, /^\d{6}$/);
    assert.match(r.body.message, /does not confirm/i);
    const code = r.body.devCode;
    const again = await pub('/api/verify/start', { method: 'POST', json: { phone } });
    assert.equal(again.status, 429, 'one SMS per 60 s per phone');
    assert.ok(again.body.error.details.retryAfterSec > 0);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      r = await pub('/api/verify/confirm', { method: 'POST', json: { phone, code: wrong } });
      assert.equal(r.status, 400);
      assert.equal(r.body.error.code, 'invalid_code');
      assert.equal(r.body.error.details.attemptsRemaining, 5 - i);
    }
    r = await pub('/api/verify/confirm', { method: 'POST', json: { phone, code: wrong } });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'too_many_attempts');
    r = await pub('/api/verify/confirm', { method: 'POST', json: { phone, code } });
    assert.equal(r.status, 400, 'correct code no longer works after 5 wrong attempts');
    assert.ok(logs.some((l) => l.includes(code)), 'console provider logs the code server-side');

    // Happy path
    verifiedPhone = newPhone();
    r = await pub('/api/verify/start', { method: 'POST', json: { phone: verifiedPhone } });
    r = await pub('/api/verify/confirm', { method: 'POST', json: { phone: verifiedPhone, code: r.body.devCode } });
    assert.equal(r.status, 200);
    assert.equal(r.body.verified, true);
    verifiedToken = r.body.token;
    assert.ok(verifiedToken.length > 20);
    const stored = s.db.prepare('SELECT token_hash FROM phone_verifications WHERE verified_at IS NOT NULL ORDER BY id DESC LIMIT 1').get();
    assert.notEqual(stored.token_hash, verifiedToken, 'token stored hashed');
    const rep = await submit({ phone: verifiedPhone, verificationToken: verifiedToken });
    assert.equal(rep.status, 201);
    assert.equal(rep.body.phoneVerified, true);
    assert.equal(rep.body.verification.status, 'verified');
    assert.equal(s.db.prepare('SELECT phone_verified FROM reports WHERE reference = ?').get(rep.body.reference).phone_verified, 1);
    assert.ok(s.db.prepare('SELECT phone_verified_at FROM reporters WHERE id = (SELECT reporter_id FROM reports WHERE reference = ?)').get(rep.body.reference).phone_verified_at);
    // A token for another phone does not verify
    const other = await submit({ verificationToken: verifiedToken });
    assert.equal(other.body.phoneVerified, false);
    assert.equal(other.body.verification.status, 'token_invalid');

    // SMS disabled: verification unavailable, reports still accepted as unverified
    config.sms.provider = 'none';
    try {
      r = await pub('/api/verify/start', { method: 'POST', json: { phone: newPhone() } });
      assert.equal(r.body.enabled, false);
      assert.equal(r.body.sent, false);
      assert.ok(!('devCode' in r.body));
      const rep2 = await submit({});
      assert.equal(rep2.status, 201);
      assert.equal(rep2.body.phoneVerified, false);
      assert.equal(rep2.body.verification.available, false);
      assert.match(rep2.body.verification.message, /not available/);
      const d = await detail(rep2.body.reference);
      assert.ok(!d.riskReasons.some((x) => x.code === 'unverified_phone'), 'no unverified penalty when verification is impossible');
    } finally {
      config.sms.provider = 'console';
    }
  });

  await t.test('no photo and no location add no risk; proximity is a distance only', async () => {
    const quiet = s.insertPlant({ latitude: 31.41, longitude: 73.08, coord_status: 'verified' }); // no burst history
    const phone = newPhone();
    let r = await pub('/api/verify/start', { method: 'POST', json: { phone } });
    r = await pub('/api/verify/confirm', { method: 'POST', json: { phone, code: r.body.devCode } });
    const rep = await submit({ phone, verificationToken: r.body.token, plantCode: quiet.plant_code });
    let d = await detail(rep.body.reference);
    assert.equal(d.riskScore, 0, JSON.stringify(d.riskReasons));
    assert.deepEqual(d.riskReasons, []);
    assert.equal(d.proximityShared, false);
    // Unverified, no photo, no location → only the small unverified weight, never enough to queue
    const plain = await submit({ plantCode: quiet.plant_code });
    d = await detail(plain.body.reference);
    assert.deepEqual(d.riskReasons.map((x) => x.code), ['unverified_phone']);
    assert.ok(d.riskScore < 40 && d.reviewQueue === false);
    // Near: negative weight. Far: stored distance, no penalty. Coordinates never stored.
    const near = await submit({ plantCode: quiet.plant_code, shareProximity: 'true', proximityLat: '31.4123', proximityLng: '73.0812' });
    d = await detail(near.body.reference);
    assert.ok(d.proximityDistanceM < 500);
    assert.ok(d.riskReasons.some((x) => x.code === 'proximity_near' && x.weight < 0));
    const far = await submit({ plantCode: quiet.plant_code, shareProximity: 'true', proximityLat: '31.5987', proximityLng: '73.2765' });
    d = await detail(far.body.reference);
    assert.ok(d.proximityDistanceM > 5000);
    const prox = d.riskReasons.filter((x) => x.code.startsWith('proximity'));
    assert.deepEqual(prox.map((x) => [x.code, x.weight]), [['proximity_far', 0]], 'far location is not penalised');
    const rows = JSON.stringify(s.db.prepare('SELECT * FROM reports WHERE reference IN (?, ?)').all(near.body.reference, far.body.reference));
    assert.ok(!rows.includes('31.4123') && !rows.includes('73.0812') && !rows.includes('31.5987'), 'raw coordinates not stored');
  });

  await t.test('serious categories are flagged and listed first', async () => {
    const a = await submit({ category: 'no_water' });
    const b = await submit({ category: 'color_odor_taste' });
    await submit({ category: 'other' });
    assert.equal((await detail(a.body.reference)).severity, 'serious');
    assert.equal((await detail(b.body.reference)).severity, 'serious');
    const list = await (await moderator.fetch('/api/admin/reports?status=pending&sort=priority&pageSize=200')).json();
    const firstNormal = list.items.findIndex((x) => x.severity === 'normal');
    const lastSerious = list.items.map((x) => x.severity).lastIndexOf('serious');
    assert.ok(lastSerious < firstNormal, 'serious open reports come first with sort=priority');
    const serious = await (await moderator.fetch('/api/admin/reports?severity=serious')).json();
    assert.ok(serious.items.every((x) => x.severity === 'serious') && serious.total >= 2);
  });

  await t.test('admin list: proximityBasis, Karachi date filters, priority sort', async () => {
    // proximityBasis: exact plant position vs approximate area centre
    const now = new Date().toISOString();
    const areaId = Number(s.db.prepare(`INSERT INTO areas (area_key, name, town, latitude, longitude, radius_m, geocode_status, updated_at)
                                        VALUES ('basis-area|t', 'Basis Area', 'T', 31.45, 73.12, 1500, 'matched', ?)`).run(now).lastInsertRowid);
    const areaPlant = s.insertPlant({ area_id: areaId });
    const exactPlant = s.insertPlant({ latitude: 31.41, longitude: 73.08, coord_status: 'verified' });
    const a = await submit({ plantCode: areaPlant.plant_code, shareProximity: 'true', proximityLat: '31.451', proximityLng: '73.121' });
    const e = await submit({ plantCode: exactPlant.plant_code, shareProximity: 'true', proximityLat: '31.4101', proximityLng: '73.0801' });
    const n = await submit({ plantCode: exactPlant.plant_code });
    assert.equal((await detail(a.body.reference)).proximityBasis, 'area_centre');
    assert.equal((await detail(e.body.reference)).proximityBasis, 'plant');
    assert.equal((await detail(n.body.reference)).proximityBasis, null);

    // from/to are Asia/Karachi calendar dates; `to` is inclusive
    const late = await submit({});
    const early = await submit({});
    s.db.prepare('UPDATE reports SET created_at = ? WHERE reference = ?').run('2026-01-10T18:30:00.000Z', late.body.reference); // 23:30 PKT on the 10th
    s.db.prepare('UPDATE reports SET created_at = ? WHERE reference = ?').run('2026-01-10T19:30:00.000Z', early.body.reference); // 00:30 PKT on the 11th
    const refs = async (qs) => (await (await moderator.fetch('/api/admin/reports?' + qs)).json()).items.map((x) => x.reference);
    assert.deepEqual(await refs('from=2026-01-10&to=2026-01-10'), [late.body.reference]);
    assert.deepEqual(await refs('from=2026-01-11&to=2026-01-11'), [early.body.reference]);
    assert.deepEqual((await refs('from=2026-01-01&to=2026-01-31')).sort(), [late.body.reference, early.body.reference].sort());
    assert.equal((await moderator.fetch('/api/admin/reports?from=2026-13-01')).status, 400);
    assert.equal((await moderator.fetch('/api/admin/reports?sort=random')).status, 400);

    // sort=priority: serious → review queue → pending/under_review → oldest first; default is newest first
    const pp = s.insertPlant();
    const mk = async (fields, minutesAgo) => {
      const r = await submit({ plantCode: pp.plant_code, ...fields });
      s.db.prepare('UPDATE reports SET created_at = ? WHERE reference = ?').run(new Date(Date.now() - minutesAgo * 60e3).toISOString(), r.body.reference);
      return r.body.reference;
    };
    const clar = await mk({}, 500);
    await decide(clar, { action: 'request_clarification', reason: 'Need detail', publicNote: 'Which tap?' });
    const oldPending = await mk({}, 300);
    const newPending = await mk({}, 100);
    const queued = await mk({ website: 'http://bot.example' }, 50);
    const serious = await mk({ category: 'no_water' }, 10);
    assert.deepEqual(await refs(`plantCode=${pp.plant_code}&sort=priority`), [serious, queued, oldPending, newPending, clar]);
    const def = await (await moderator.fetch(`/api/admin/reports?plantCode=${pp.plant_code}`)).json();
    assert.equal(def.sort, 'newest');
    assert.deepEqual(def.items.map((x) => x.reference), [serious, queued, newPending, oldPending, clar]);
  });

  let decided;
  await t.test('decisions: reason required, valid transitions, counts, audit; plant status unchanged', async () => {
    const plantBefore = s.db.prepare('SELECT status, status_source, status_updated_at FROM plants WHERE id = ?').get(plant.id);
    const r = await submit({ category: 'no_water' });
    decided = r;
    const ref = r.body.reference;
    let res = await decide(ref, { action: 'confirm' });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.details.field, 'reason');
    res = await decide(ref, { action: 'resolve', reason: 'fixed' });
    assert.equal(res.status, 409, 'cannot resolve a pending report');
    res = await editor.fetch(`/api/admin/reports/${reportId(ref)}/decision`, { method: 'POST', json: { action: 'start_review', reason: 'x'.repeat(5) } });
    assert.equal(res.status, 403, 'editors cannot moderate');
    res = await decide(ref, { action: 'start_review', reason: 'Looking into it' });
    assert.equal((await res.json()).status, 'under_review');
    res = await decide(ref, { action: 'request_clarification', reason: 'Need timing' });
    assert.equal(res.status, 400, 'clarification needs a public question');
    res = await decide(ref, { action: 'request_clarification', reason: 'Need timing', publicNote: 'Which tap was dry, and at what time?' });
    assert.equal((await res.json()).status, 'needs_clarification');
    res = await decide(ref, { action: 'confirm', reason: 'INTERNAL: field officer visited', publicNote: 'Confirmed by our team.' });
    const out = await res.json();
    assert.equal(out.status, 'confirmed');
    assert.deepEqual(out.allowedActions.sort(), ['resolve', 'start_review']);
    const rep = s.db.prepare('SELECT confirmed_reports, rejected_reports FROM reporters WHERE id = (SELECT reporter_id FROM reports WHERE reference = ?)').get(ref);
    assert.equal(rep.confirmed_reports, 1);
    // Plant official status untouched
    assert.deepEqual({ ...s.db.prepare('SELECT status, status_source, status_updated_at FROM plants WHERE id = ?').get(plant.id) }, { ...plantBefore });
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM plant_status_history').get().n, 0);
    // Reject another report → rejected count
    const other = await submit({ phone: r.phone, plantCode: plantB.plant_code });
    assert.equal((await decide(other.body.reference, { action: 'reject', reason: 'Could not be substantiated' })).status, 200);
    assert.equal(s.db.prepare('SELECT rejected_reports FROM reporters WHERE id = (SELECT reporter_id FROM reports WHERE reference = ?)').get(ref).rejected_reports, 1);
    const auditRows = s.db.prepare("SELECT * FROM audit_log WHERE action = 'report.decision' AND entity_id = ?").all(String(reportId(ref)));
    assert.equal(auditRows.length, 3);
    assert.ok(auditRows.every((a) => a.reason && a.actor_label === 'test-moderator'));
    const events = (await detail(ref)).events.filter((e) => e.actor);
    assert.ok(events.every((e) => e.reason));
  });

  await t.test('status page requires reference + last4 and shows only public information', async () => {
    const ref = decided.body.reference;
    const last4 = decided.phone.slice(-4);
    let r = await pub(`/api/reports/status?reference=${ref}`);
    assert.equal(r.status, 400);
    assert.equal(r.body.error.details.field, 'last4');
    r = await pub(`/api/reports/status?reference=${ref}&last4=${last4 === '0000' ? '1111' : '0000'}`);
    assert.equal(r.status, 404);
    r = await pub(`/api/reports/status?reference=${ref.toLowerCase()}&last4=${last4}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.reference, ref);
    assert.equal(r.body.status, 'confirmed');
    assert.equal(r.body.plant.code, plant.plant_code);
    assert.deepEqual(r.body.timeline.map((x) => x.status), ['pending', 'under_review', 'needs_clarification', 'confirmed']);
    assert.ok(r.body.timeline.some((x) => x.publicNote === 'Which tap was dry, and at what time?'));
    const text = JSON.stringify(r.body);
    assert.ok(!text.includes('INTERNAL') && !text.includes('Looking into it') && !/risk/i.test(text), 'no internal reasons or risk');
  });

  await t.test('reporter replies to a clarification request', async () => {
    const r = await submit({});
    const ref = r.body.reference;
    const last4 = r.phone.slice(-4);
    let res = await pub('/api/reports/reply', { method: 'POST', json: { reference: ref, last4, message: 'It was the left tap at 9am' } });
    assert.equal(res.status, 409, 'not awaiting a reply yet');
    await decide(ref, { action: 'request_clarification', reason: 'Unclear', publicNote: 'Which tap?' });
    let st = await pub(`/api/reports/status?reference=${ref}&last4=${last4}`);
    assert.equal(st.body.canReply, true);
    const wrong4 = String((Number(last4) + 1) % 10000).padStart(4, '0');
    res = await pub('/api/reports/reply', { method: 'POST', json: { reference: ref, last4: wrong4, message: 'x'.repeat(10) } });
    assert.equal(res.status, 404, 'wrong last4 cannot reply');
    res = await pub('/api/reports/reply', { method: 'POST', json: { reference: ref, last4, message: 'It was the left tap at 9am' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'under_review');
    const d = await detail(ref);
    assert.equal(d.status, 'under_review');
    assert.ok(d.events.some((e) => e.action === 'reporter_reply' && e.reason === 'It was the left tap at 9am'));
    st = await pub(`/api/reports/status?reference=${ref}&last4=${last4}`);
    assert.equal(st.body.status, 'under_review');
    assert.ok(!JSON.stringify(st.body).includes('left tap'), 'reply text is internal');
  });

  await t.test('reveal-contact is admin-only, needs a reason and is audited without the number', async () => {
    const id = reportId(decided.body.reference);
    assert.equal((await moderator.fetch(`/api/admin/reports/${id}/reveal-contact`, { method: 'POST', json: { reason: 'Follow up' } })).status, 403);
    assert.equal((await admin.fetch(`/api/admin/reports/${id}/reveal-contact`, { method: 'POST', json: {} })).status, 400);
    const res = await admin.fetch(`/api/admin/reports/${id}/reveal-contact`, { method: 'POST', json: { reason: 'Field visit follow-up call' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).phone, '+92' + decided.phone.slice(1));
    const a = s.db.prepare("SELECT * FROM audit_log WHERE action = 'contact.reveal' ORDER BY id DESC LIMIT 1").get();
    assert.equal(a.reason, 'Field visit follow-up call');
    assert.equal(a.actor_label, 'test-admin');
    assert.ok(!JSON.stringify(a).includes(decided.phone.slice(1)));
    const d = await detail(decided.body.reference);
    assert.match(d.reporter.phoneMasked, /••\d{2}$/);
    assert.ok(!JSON.stringify(d).includes(decided.phone.slice(1)), 'moderator detail never has the number');
    assert.match(d.reporter.alias, /^Community member \d+$/);
    assert.equal(typeof d.reporter.reports30d, 'number');
  });

  await t.test('ratings are separate from complaints; one per phone per plant', async () => {
    const p = s.insertPlant();
    const count = () => s.db.prepare('SELECT COUNT(*) AS n FROM ratings WHERE plant_id = ?').get(p.id).n;
    const phone = newPhone();
    const r1 = await submit({ phone, plantCode: p.plant_code });
    assert.equal(r1.body.ratingRecorded, false);
    assert.equal(count(), 0, 'a complaint never creates a rating');
    const phone2 = newPhone();
    const withRating = await submit({ phone: phone2, plantCode: p.plant_code, rating: '4' });
    assert.equal(withRating.status, 201);
    assert.equal(withRating.body.ratingRecorded, true);
    assert.equal(count(), 1);
    clearIp();
    let res = await pub('/api/ratings', { method: 'POST', json: { plantCode: p.plant_code, stars: 2, phone: phone2, consent: true } });
    assert.equal(res.status, 200);
    assert.equal(res.body.replaced, true);
    assert.equal(res.body.status, 'accepted');
    assert.match(res.body.message, /not water-quality test results/);
    assert.equal(count(), 1);
    assert.equal(s.db.prepare('SELECT stars FROM ratings WHERE plant_id = ?').get(p.id).stars, 2);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE plant_id = ?').get(p.id).n, 2, 'a rating never creates a report');
    res = await pub('/api/ratings', { method: 'POST', json: { plantCode: p.plant_code, stars: 6, phone: phone2, consent: true } });
    assert.equal(res.status, 400);
    res = await pub('/api/ratings', { method: 'POST', json: { plantCode: p.plant_code, stars: 3, phone: phone2, consent: false } });
    assert.equal(res.status, 400);
    // A phone rating many plants quickly → pending for a moderator
    const spree = newPhone();
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const q = s.insertPlant();
      statuses.push((await pub('/api/ratings', { method: 'POST', json: { plantCode: q.plant_code, stars: 1, phone: spree, consent: true } })).body.status);
    }
    assert.deepEqual(statuses.slice(0, 3), ['accepted', 'accepted', 'accepted']);
    assert.equal(statuses[4], 'pending');
    const pending = await (await moderator.fetch('/api/admin/ratings?status=pending')).json();
    assert.ok(pending.total >= 1 && pending.items[0].riskReasons.some((x) => x.code === 'rating_spree'));
    const dec = await moderator.fetch(`/api/admin/ratings/${pending.items[0].id}/decision`, { method: 'POST', json: { action: 'accept', reason: 'Looks genuine' } });
    assert.equal((await dec.json()).status, 'accepted');
  });

  await t.test('deletion request erases phone, redacts reports, deletes photos, detaches ratings', async () => {
    const phone = newPhone();
    const r = await submit({ phone, rating: '5', description: 'My neighbour Ali Raza told me the pump is broken ' + uniqueText() }, [{ buf: makeJpeg({ variant: 9 }) }]);
    assert.equal(r.status, 201);
    const id = reportId(r.body.reference);
    const reporterId = s.db.prepare('SELECT reporter_id FROM reports WHERE id = ?').get(id).reporter_id;
    const photoPaths = s.db.prepare('SELECT f.storage_path FROM report_photos rp JOIN files f ON f.id = rp.file_id WHERE rp.report_id = ?').all(id).map((x) => x.storage_path);
    assert.equal(photoPaths.length, 1);
    clearIp();
    const ap = await pub('/api/appeals', { method: 'POST', json: { kind: 'deletion_request', reference: r.body.reference, phone, message: 'Please delete all my data.' } });
    assert.equal(ap.status, 201);
    assert.match(ap.body.reference, /^AP-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    const list = await (await moderator.fetch('/api/admin/appeals?status=open')).json();
    const item = list.items.find((x) => x.reference === ap.body.reference);
    assert.equal(item.kind, 'deletion_request');
    assert.equal(item.matchedReporter, true);
    const res = await moderator.fetch(`/api/admin/appeals/${item.id}/resolve`, { method: 'POST', json: { status: 'completed', resolution: 'Identity matched by phone; data erased.' } });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.erasure.reportsRedacted, 1);
    assert.equal(out.erasure.photosDeleted, 1);
    assert.equal(out.erasure.ratingsDetached, 1);
    const rep = s.db.prepare('SELECT phone_enc, phone_last4 FROM reporters WHERE id = ?').get(reporterId);
    assert.equal(rep.phone_enc, null);
    assert.equal(rep.phone_last4, null);
    const row = s.db.prepare('SELECT description, redacted_at FROM reports WHERE id = ?').get(id);
    assert.equal(row.description, "[redacted at reporter's request]");
    assert.ok(row.redacted_at);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM report_photos WHERE report_id = ?').get(id).n, 0);
    for (const p of photoPaths) assert.ok(!fs.existsSync(path.join(config.uploadDir, p)), 'photo file deleted');
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM ratings WHERE reporter_id = ?').get(reporterId).n, 0);
    const erase = s.db.prepare("SELECT * FROM audit_log WHERE action = 'reporter.erase' ORDER BY id DESC LIMIT 1").get();
    assert.ok(erase && !JSON.stringify(erase).includes(phone.slice(1)));
    assert.equal((await moderator.fetch(`/api/admin/reports/${id}/reveal-contact`, { method: 'POST', json: { reason: 'x'.repeat(10) } })).status, 403);
    assert.equal((await admin.fetch(`/api/admin/reports/${id}/reveal-contact`, { method: 'POST', json: { reason: 'Checking erasure' } })).status, 410);
    assert.equal((await pub(`/api/reports/status?reference=${r.body.reference}&last4=${phone.slice(-4)}`)).status, 404);
    const again = await moderator.fetch(`/api/admin/appeals/${item.id}/resolve`, { method: 'POST', json: { status: 'declined', resolution: 'oops' } });
    assert.equal(again.status, 409);
  });

  await t.test('retention redacts expired reports and purges old data, idempotently', async () => {
    const r = await submit({}, [{ buf: makePng(), type: 'image/png' }]);
    const id = reportId(r.body.reference);
    const past = new Date(Date.now() - 86400e3).toISOString();
    s.db.prepare('UPDATE reports SET retention_until = ? WHERE id = ?').run(past, id);
    const repId = s.db.prepare('SELECT reporter_id FROM reports WHERE id = ?').get(id).reporter_id;
    s.db.prepare('UPDATE reporters SET last_seen_at = ? WHERE id = ?').run(new Date(Date.now() - 400 * 86400e3).toISOString(), repId);
    s.db.prepare("INSERT INTO rate_events (bucket, subject, created_at) VALUES ('test:old', 'x', ?)").run(Date.now() - 100 * 3600e3);
    s.db.prepare("INSERT INTO phone_verifications (phone_hash, code_hash, expires_at, created_at) VALUES ('h', 'c', ?, ?)").run(past, past);
    const created = s.db.prepare('SELECT created_at, retention_until FROM reports WHERE id = (SELECT MAX(id) FROM reports WHERE id != ?)').get(id);
    assert.equal(Math.round((Date.parse(created.retention_until) - Date.parse(created.created_at)) / 86400e3), config.retention.reportDays);

    const first = runRetention();
    assert.ok(first.reportsRedacted >= 1);
    assert.ok(first.photosDeleted >= 1);
    assert.ok(first.contactsErased >= 1);
    assert.ok(first.rateEventsPurged >= 1);
    assert.ok(first.verificationsDeleted >= 1);
    const row = s.db.prepare('SELECT description, redacted_at FROM reports WHERE id = ?').get(id);
    assert.match(row.description, /redacted/);
    assert.ok(row.redacted_at);
    assert.equal(s.db.prepare('SELECT phone_enc FROM reporters WHERE id = ?').get(repId).phone_enc, null);
    const second = runRetention();
    assert.deepEqual(
      [second.reportsRedacted, second.photosDeleted, second.contactsErased, second.verificationsDeleted],
      [0, 0, 0, 0], 'second run changes nothing');
  });

  await t.test('CSV export is injection-safe and contact export is admin-only, justified and audited', async () => {
    await submit({ description: '=HYPERLINK("http://evil.example","click me") please' });
    let res = await moderator.fetch('/api/admin/export/reports.csv');
    assert.equal(res.status, 200);
    let csv = await res.text();
    const header = csv.replace(/^﻿/, '').split('\r\n')[0];
    assert.ok(!header.includes('phone"') || header.includes('phone_verified'));
    assert.ok(!header.split(',').includes('"phone"'), 'no phone column by default');
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil.example"",""click me"") please"`), 'formula neutralised');
    for (const p of phones) assert.ok(!csv.includes(p.slice(1)), 'no phone numbers in default export');
    assert.equal((await moderator.fetch('/api/admin/export/reports.csv?includeContact=1&reason=Needed%20for%20survey')).status, 403);
    assert.equal((await admin.fetch('/api/admin/export/reports.csv?includeContact=1')).status, 400);
    res = await admin.fetch('/api/admin/export/reports.csv?includeContact=1&reason=Ministry%20follow-up%20calls');
    assert.equal(res.status, 200);
    csv = await res.text();
    assert.ok(csv.split('\r\n')[0].split(',').includes('"phone"'));
    assert.ok(csv.includes("\"'+92"), 'phone cells are neutralised too');
    const a = s.db.prepare("SELECT * FROM audit_log WHERE action = 'export.reports_with_contacts' ORDER BY id DESC LIMIT 1").get();
    assert.equal(a.reason, 'Ministry follow-up calls');
    assert.ok(!phones.some((p) => JSON.stringify(a).includes(p.slice(1))));
  });

  await t.test('moderation stats, reporter page and investigations', async () => {
    const st = await moderator.fetch('/api/admin/moderation/stats');
    assert.equal(st.status, 200);
    const stats = await st.json();
    assert.ok(stats.reports.total > 10 && stats.reports.seriousOpen >= 1 && stats.reports.reviewQueueOpen >= 1);
    assert.equal((await editor.fetch('/api/admin/moderation/stats')).status, 403);
    const d = await detail(decided.body.reference);
    const rp = await (await moderator.fetch(`/api/admin/reporters/${d.reporter.id}`)).json();
    assert.ok(rp.reports.length >= 2);
    let res = await moderator.fetch(`/api/admin/reporters/${d.reporter.id}/status`, { method: 'POST', json: { status: 'restricted' } });
    assert.equal(res.status, 400);
    res = await moderator.fetch(`/api/admin/reporters/${d.reporter.id}/status`, { method: 'POST', json: { status: 'restricted', reason: 'Repeated unfounded reports' } });
    assert.equal((await res.json()).status, 'restricted');
    res = await moderator.fetch('/api/admin/investigations', { method: 'POST', json: { plantCode: plant.plant_code, title: 'Dry taps in the morning', reportIds: [d.id] } });
    assert.equal(res.status, 201);
    const inv = await res.json();
    assert.equal(inv.reports.length, 1);
    res = await moderator.fetch(`/api/admin/investigations/${inv.id}`, { method: 'PATCH', json: { status: 'closed' } });
    assert.equal(res.status, 400, 'closing requires a resolution');
    res = await moderator.fetch(`/api/admin/investigations/${inv.id}`, { method: 'PATCH', json: { status: 'closed', resolution: 'Operator replaced the valve on site.' } });
    assert.equal((await res.json()).status, 'closed');
    assert.equal(s.db.prepare('SELECT status FROM plants WHERE id = ?').get(plant.id).status, 'operational');
  });

  await t.test('phone numbers never appear in public responses, audit_log or logs', () => {
    assert.ok(phones.length > 20);
    const variants = (p) => [p, p.slice(1), '+92' + p.slice(1)];
    const pubText = publicBodies.join('\n');
    const auditText = JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all());
    const logText = logs.join('\n');
    for (const p of phones) {
      for (const v of variants(p)) {
        assert.ok(!pubText.includes(v), `public response contains ${v}`);
        assert.ok(!auditText.includes(v), `audit_log contains ${v}`);
        assert.ok(!logText.includes(v), `log contains ${v}`);
      }
    }
    // Stored encrypted: no plaintext number in the reporters table
    const reportersText = JSON.stringify(s.db.prepare('SELECT phone_hash, phone_enc, public_alias FROM reporters').all());
    for (const p of phones) assert.ok(!reportersText.includes(p.slice(1)));
  });
});
