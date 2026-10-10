'use strict';
/**
 * Local admin server for the Hetaira catalog. Run only while editing data:
 *   npm start   ->  http://localhost:3000/admin/server.html
 *
 * Env:
 *   PORT       (default 3000)
 *   HOST       (default 127.0.0.1 — keep it local)
 *   MEDIA_DIR  media repo root (default ../hetaira-c1 if it exists, else ./media)
 *              files are written to <MEDIA_DIR>/<artist-uuid>/cover|audio/<record-uuid>.<ext>
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const catalog = require('./lib/catalog');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = catalog.ROOT;
const sibling = path.join(ROOT, '..', 'hetaira-c1');
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || (fs.existsSync(sibling) ? sibling : path.join(ROOT, 'media')));
const IS_LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);

const MEDIA_TYPES = {
  cover: { exts: ['jpg', 'png', 'webp'], maxBytes: 25 * 1024 * 1024, fallback: 'jpg', mime: /^image\// },
  audio: { exts: ['mp3', 'wav', 'flac', 'ogg', 'm4a'], maxBytes: 500 * 1024 * 1024, fallback: 'mp3', mime: /^(audio\/|application\/octet-stream|binary\/octet-stream)/ }
};
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');

/* ---------- security: local-only ---------- */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// Blocks DNS-rebinding: a hostile site pointing its own domain at 127.0.0.1 would otherwise reach this API.
app.use((req, res, next) => {
  if (IS_LOOPBACK && !LOCAL_HOST.test(req.headers.host || '')) return res.status(403).json({ error: 'Forbidden host' });
  next();
});
// CORS for local pages on another port (e.g. Live Server); cross-site writes are refused outright (CSRF).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    if (!LOCAL_ORIGIN.test(origin)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(403).json({ error: 'Forbidden origin' });
    } else {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '50mb' }));
// raw binary uploads (no base64 overhead, no giant JSON bodies)
app.use('/api/artists/:artist/upload', express.raw({ type: ['application/octet-stream', 'audio/*', 'image/*'], limit: '520mb' }));

// Don't serve code, deps, backups or git internals.
app.use((req, res, next) => {
  if (/^\/(node_modules|lib|tools|\.git|server\.js|package(-lock)?\.json|[^/]+\/backups)(\/|$)/i.test(req.path)) return res.sendStatus(404);
  next();
});
app.get('/', (req, res) => res.redirect('/admin/server.html'));
app.use('/media', express.static(MEDIA_DIR, { dotfiles: 'deny' }));
app.use(express.static(ROOT, { dotfiles: 'deny' }));

/* ---------- helpers ---------- */
function requireArtist(req, res, next) {
  const artist = catalog.getArtist(req.params.artist);
  if (!artist) return res.status(404).json({ error: `Unknown artist: ${req.params.artist}` });
  req.artist = artist;
  next();
}
function extFrom(requested, mime, spec) {
  let ext = String(requested || '').replace(/^\./, '').toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (spec.exts.includes(ext)) return ext;
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('flac')) return 'flac';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  return spec.fallback;
}
/** Writes to <MEDIA_DIR>/<artist-uuid>/<cover|audio>/<uuid>.<ext>; returns the repo-relative path stored in records. */
function storeMedia(artist, type, uuid, ext, buffer) {
  const rel = catalog.mediaRelPath(artist, type, uuid, ext);
  const dir = path.join(MEDIA_DIR, artist.uuid, catalog.MEDIA_FOLDERS[type]);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${uuid}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, path.join(dir, `${uuid}.${ext}`));
  // drop stale copies of the same uuid with a different extension
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${uuid}.`) && f !== `${uuid}.${ext}` && !f.endsWith('.tmp')) fs.unlinkSync(path.join(dir, f));
  }
  return rel;
}
function checkMediaParams({ type, uuid }) {
  if (!MEDIA_TYPES[type]) return 'type must be "cover" or "audio"';
  if (!catalog.UUID_RE.test(uuid || '')) return 'uuid must be a valid UUID';
  return null;
}

/* ---------- SSRF protection for fetch-url ---------- */
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return true;
}
async function assertPublicUrl(u) {
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Private/local addresses are not allowed');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('Private/local addresses are not allowed');
}
/** fetch() that re-validates every redirect hop and caps the body size while streaming. */
async function safeDownload(startUrl, spec) {
  let url = new URL(startUrl);
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: '*/*' },
      signal: AbortSignal.timeout(180000)
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url);
      continue;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const contentType = response.headers.get('content-type') || '';
    if (!spec.mime.test(contentType)) throw new Error(`Unexpected content-type "${contentType}" (broken link or HTML page?)`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > spec.maxBytes) throw new Error(`File too large (${(declared / 1048576).toFixed(1)} MB)`);
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > spec.maxBytes) throw new Error('File too large');
      chunks.push(chunk);
    }
    return { buffer: Buffer.concat(chunks), contentType };
  }
  throw new Error('Too many redirects');
}

/* ---------- read APIs ---------- */
app.get('/api/artists', (req, res) => res.json(catalog.loadArtists()));
app.get('/api/vocab', (req, res) => res.json(catalog.loadVocab()));
app.get('/api/artists/:artist/records', requireArtist, (req, res) => {
  try { res.json(catalog.loadRecords(req.artist)); }
  catch (err) { res.status(500).json({ error: 'data.json is unreadable', details: err.message }); }
});

/* ---------- write APIs (per artist) ---------- */
// Upload a file: raw body (preferred) with ?type=&uuid=&extension=, or legacy JSON {type,uuid,extension,data(base64)}
app.post('/api/artists/:artist/upload', requireArtist, (req, res) => {
  const isRaw = Buffer.isBuffer(req.body);
  const src = isRaw ? req.query : (req.body || {});
  const { type, uuid, extension } = src;
  const bad = checkMediaParams({ type, uuid });
  if (bad) return res.status(400).json({ error: bad });
  try {
    const spec = MEDIA_TYPES[type];
    let buffer;
    if (isRaw) buffer = req.body;
    else {
      if (typeof src.data !== 'string' || !src.data) return res.status(400).json({ error: 'Missing file data' });
      buffer = Buffer.from(src.data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    }
    if (!buffer.length) return res.status(400).json({ error: 'Empty file' });
    if (buffer.length > spec.maxBytes) return res.status(413).json({ error: `File too large (max ${spec.maxBytes / 1048576} MB)` });
    const ext = extFrom(extension, req.headers['content-type'], spec);
    const rel = storeMedia(req.artist, type, uuid.toLowerCase(), ext, buffer);
    console.log(`[UPLOAD] ${req.artist.slug}: ${rel} (${(buffer.length / 1024).toFixed(0)} KB)`);
    res.json({ success: true, path: rel });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err.message);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// Download a remote file (e.g. a free file you have permission to host) into the media folder
app.post('/api/artists/:artist/fetch-url', requireArtist, async (req, res) => {
  const { url, type, uuid, extension } = req.body || {};
  const bad = checkMediaParams({ type, uuid });
  if (bad) return res.status(400).json({ error: bad });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const spec = MEDIA_TYPES[type];
  try {
    const { buffer, contentType } = await safeDownload(parsed, spec);
    const rel = storeMedia(req.artist, type, uuid.toLowerCase(), extFrom(extension, contentType, spec), buffer);
    console.log(`[INGEST] ${req.artist.slug}: ${parsed.href} -> ${rel}`);
    res.json({ success: true, path: rel });
  } catch (err) {
    console.error('[FETCH FAILED]', err.message);
    res.status(502).json({ error: 'Failed to download remote file', details: err.message });
  }
});

// Validate + normalize + back up + write data.json, summary.json, records/*.json, shared files
app.post('/api/artists/:artist/save', requireArtist, (req, res) => {
  try {
    const result = catalog.saveArtistRecords(req.artist, req.body, { force: req.query.force === '1' });
    console.log(`[COMMIT] ${req.artist.slug}: ${result.records.length} records` +
      (result.backup ? `, backup ${path.basename(result.backup)}` : '') +
      (result.orphans.length ? `, ${result.orphans.length} orphan file(s) moved to backups/orphans` : ''));
    res.json({ success: true, records: result.records, vocab: catalog.loadVocab(), orphans: result.orphans, warnings: result.warnings, shared: result.shared });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: 'Validation failed', errors: err.errors });
    console.error('[SAVE ERROR]', err);
    res.status(500).json({ error: 'Failed to save', details: err.message });
  }
});

// Vocabulary + artist management (used by admin/manage.html)
const wrap = fn => (req, res) => {
  try { res.json({ success: true, ...fn(req.body || {}, req.params) }); }
  catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message, errors: err.errors });
    console.error('[MANAGE ERROR]', err); res.status(500).json({ error: err.message });
  }
};
const kindOk = (req, res, next) => (['tags', 'triggers'].includes(req.params.kind) ? next() : res.status(404).json({ error: 'kind must be tags or triggers' }));
app.post('/api/vocab/:kind', kindOk, wrap((b, p) => ({ shared: catalog.upsertTerm(p.kind, b) })));
app.post('/api/vocab/:kind/merge', kindOk, wrap((b, p) => ({ shared: catalog.mergeTerms(p.kind, b.from, b.into) })));
app.post('/api/vocab/:kind/delete', kindOk, wrap((b, p) => ({ shared: catalog.deleteTerm(p.kind, b.slug) })));
app.post('/api/artists', wrap(b => ({ artist: catalog.upsertArtist(b) })));

app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

// Express error handler (e.g. malformed JSON, payload too large)
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log('\n======================================================');
  console.log(`  HETAIRA ADMIN  http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}/admin/server.html`);
  console.log(`  Artists: ${catalog.loadArtists().map(a => a.slug).join(', ') || '(none)'}`);
  console.log(`  Media dir: ${MEDIA_DIR}`);
  console.log('======================================================\n');
});
server.on('error', err => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (set PORT=...)` : err);
  process.exit(1);
});
