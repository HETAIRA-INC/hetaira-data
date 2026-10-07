const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const coversDir = path.join(__dirname, '7ce7929c-7574-4a8e-8405-5422ff1f16dc/covers');
const audioDir = path.join(__dirname, '7ce7929c-7574-4a8e-8405-5422ff1f16dc/audio');
const recordsDir = path.join(__dirname, '7ce7929c-7574-4a8e-8405-5422ff1f16dc/records');
const dataFile = path.join(__dirname, '7ce7929c-7574-4a8e-8405-5422ff1f16dc/data.json');
const summaryFile = path.join(__dirname, '7ce7929c-7574-4a8e-8405-5422ff1f16dc/summary.json');

fs.mkdirSync(coversDir, { recursive: true });
fs.mkdirSync(audioDir, { recursive: true });
fs.mkdirSync(recordsDir, { recursive: true });

if (!fs.existsSync(dataFile)) {
  fs.writeFileSync(dataFile, '[]', 'utf-8');
}

app.use(express.static(__dirname));

function getExtensionFromMime(mime, fallback) {
  if (!mime) return fallback;
  const lower = mime.toLowerCase();
  if (lower.includes('image/jpeg')) return 'jpg';
  if (lower.includes('image/png')) return 'png';
  if (lower.includes('image/webp')) return 'webp';
  if (lower.includes('audio/mpeg') || lower.includes('audio/mp3')) return 'mp3';
  if (lower.includes('audio/wav') || lower.includes('audio/x-wav')) return 'wav';
  if (lower.includes('audio/ogg')) return 'ogg';
  if (lower.includes('audio/mp4') || lower.includes('audio/m4a')) return 'm4a';
  return fallback;
}

// Write summary.json and individual record files for static GitHub Pages speed
async function generateStaticOptimizations(records) {
  const summaries = records.map(r => ({
    uuid: r.uuid,
    id: r.id,
    title: r.title,
    author: r.author,
    artist: r.artist,
    tag: r.tag,
    tags: r.tags || [],
    tier: r.tier,
    audience: r.audience,
    cover: r.cover,
    status: r.status || 'ACTIVE'
  }));

  await fs.promises.writeFile(summaryFile, JSON.stringify(summaries), 'utf-8');

  for (const record of records) {
    if (record.uuid) {
      await fs.promises.writeFile(
        path.join(recordsDir, `${record.uuid}.json`),
        JSON.stringify(record, null, 2),
        'utf-8'
      );
    }
  }
}

// 1. INGEST FROM REMOTE URL
app.post('/api/fetch-url', async (req, res) => {
  const { url, type, uuid, extension } = req.body;
  if (!url || !type || !uuid) {
    return res.status(400).json({ error: 'Missing parameters (url, type, or uuid required)' });
  }

  const folder = type === 'cover' ? 'covers' : 'audio';

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': '*/*'
      }
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const contentType = response.headers.get('content-type');
    let ext = extension ? extension.replace(/^\./, '') : null;
    if (!ext || ext.length > 5) {
      ext = getExtensionFromMime(contentType, type === 'cover' ? 'jpg' : 'mp3');
    }

    const fileName = `${uuid}.${ext}`;
    const targetPath = path.join(__dirname, folder, fileName);

    const arrayBuffer = await response.arrayBuffer();
    await fs.promises.writeFile(targetPath, Buffer.from(arrayBuffer));

    console.log(`[INGEST] ${url} -> ${folder}/${fileName}`);
    res.json({ success: true, path: `${folder}/${fileName}` });
  } catch (err) {
    console.error(`[FETCH FAILED]:`, err.message);
    res.status(500).json({ error: 'Failed to download remote file', details: err.message });
  }
});

// 2. COMMIT DATA + BUILD OPTIMIZATIONS
app.post('/api/save', async (req, res) => {
  try {
    const records = req.body;
    await fs.promises.writeFile(dataFile, JSON.stringify(records, null, 2), 'utf-8');
    await generateStaticOptimizations(records);
    console.log(`[COMMIT] data.json, summary.json & per-item records updated (${records.length} records)`);
    res.json({ success: true });
  } catch (err) {
    console.error('[SAVE ERROR]', err.message);
    res.status(500).json({ error: 'Failed to write data.json', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  CYBER.EROS SERVER RUNNING on http://localhost:${PORT}`);
  console.log(`  Summary Builder & Record Splitter: ACTIVE`);
  console.log(`======================================================\n`);
});