// WebTorrent chunk seeder for the okast P2P livestream experiment.
//
// Turns a directory of sequential HLS-style segments into a WebTorrent-backed
// live stream: each segment becomes its own torrent whose WebSeed (BEP-19)
// points at the segment's origin URL (so origin fallback is automatic), and the
// magnet/.torrent/webseed are published in a sliding-window manifest.
//
// Two modes:
//   - STATIC (PoC, default): reveal the bundled seg-*.m4s on a timer to fake
//     "live". Run: npm run segments first.
//   - WATCH (P1, set WATCH_DIR): poll a live HLS output dir and torrent new
//     segments as the transcoder writes them. This is the companion-container
//     mode that attaches to Owncast's HLS output via a shared volume.
//
// Env:
//   PORT          8088
//   WINDOW        4         live segments kept in the manifest
//   CHUNK_SECONDS 20        advisory chunk length (for the manifest/metrics)
//   PUBLIC_HOST   http://localhost:$PORT   how clients reach THIS seeder
//   WEBSEED_BASE  $PUBLIC_HOST/media       URL prefix that serves the segment
//                                          bytes (the ORIGIN; in prod = okast HLS)
//   STATIC mode:  MEDIA (./media), REVEAL_MS (2000)
//   WATCH mode:   WATCH_DIR (dir to poll), SEG_RE (default seg-\d+\.m4s; use
//                 '\d+\.ts' for Owncast), INIT_NAME (init.mp4 if present),
//                 POLL_MS (1000)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const WINDOW = Number(process.env.WINDOW || 4);
const CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS || 20);
const HOST = process.env.PUBLIC_HOST || `http://localhost:${PORT}`;

const WATCH_DIR = process.env.WATCH_DIR ? path.resolve(process.env.WATCH_DIR) : null;
const MEDIA = path.resolve(__dirname, process.env.MEDIA || 'media');
const SRC_DIR = WATCH_DIR || MEDIA; // where segment files live (read + serve)
const WEBSEED_BASE = process.env.WEBSEED_BASE || `${HOST}/media`;
const REVEAL_MS = Number(process.env.REVEAL_MS || 2000);
const POLL_MS = Number(process.env.POLL_MS || 1000);
const SEG_RE = new RegExp(`^${process.env.SEG_RE || 'seg-\\d+\\.m4s'}$`);
const INIT_NAME = process.env.INIT_NAME || 'init.mp4';

const TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'];

const client = new WebTorrent();
client.on('error', e => console.error('[webtorrent]', e.message));

let seq = 0;
const live = []; // sliding window of manifest entries
const seeded = new Set(); // segment names already torrented
const torrentFiles = new Map(); // name -> .torrent Buffer

const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, HOST).pathname;

  if (p === '/' || p === '/player' || p === '/index.html') {
    return send(res, 200, 'text/html', fs.readFileSync(path.join(__dirname, 'public', 'player.html')));
  }
  if (p === '/lib/webtorrent.min.js') {
    return send(res, 200, 'text/javascript', fs.readFileSync(path.join(__dirname, 'public', 'lib', 'webtorrent.min.js')));
  }
  if (p === '/manifest.json') {
    const initUrl = fs.existsSync(path.join(SRC_DIR, INIT_NAME)) ? `${WEBSEED_BASE}/${INIT_NAME}` : null;
    return send(res, 200, 'application/json', JSON.stringify({ chunkSeconds: CHUNK_SECONDS, window: WINDOW, initUrl, trackers: TRACKERS, live }, null, 2));
  }
  // Serve segment bytes (the WebSeed target) with Range/206 support (required
  // by BEP-19). In prod WEBSEED_BASE points at okast instead and this is unused.
  if (p.startsWith('/media/')) {
    const f = path.join(SRC_DIR, path.basename(p));
    if (!fs.existsSync(f)) return send(res, 404, 'text/plain', 'not found');
    const stat = fs.statSync(f);
    const type = f.endsWith('.mp4') ? 'video/mp4' : f.endsWith('.ts') ? 'video/mp2t' : 'video/iso.segment';
    const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : stat.size - 1;
      res.writeHead(206, { 'content-type': type, 'access-control-allow-origin': '*', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*', 'accept-ranges': 'bytes', 'content-length': stat.size });
    return fs.createReadStream(f).pipe(res);
  }
  if (p.startsWith('/torrents/')) {
    const buf = torrentFiles.get(path.basename(p).replace(/\.torrent$/, ''));
    if (!buf) return send(res, 404, 'text/plain', 'not found');
    return send(res, 200, 'application/x-bittorrent', buf);
  }
  return send(res, 404, 'text/plain', 'not found');
});

// Seed one segment as its own torrent (with webseed) and add it to the window.
function seedSegment(name) {
  if (seeded.has(name)) return;
  seeded.add(name);
  const filePath = path.join(SRC_DIR, name);
  const webseed = `${WEBSEED_BASE}/${name}`;
  client.seed(filePath, { name, urlList: [webseed], announce: TRACKERS }, torrent => {
    torrentFiles.set(name, torrent.torrentFile);
    const entry = { seq: seq++, name, length: torrent.length, infoHash: torrent.infoHash, magnet: torrent.magnetURI, torrentUrl: `/torrents/${name}.torrent`, webseed };
    live.push(entry);
    while (live.length > WINDOW) {
      const d = live.shift();
      console.log(`[seeder] window slid past seq=${d.seq} (${d.name})`);
    }
    console.log(`[seeder] +seq=${entry.seq} ${name} infoHash=${entry.infoHash} (${entry.length}B) webseed=${webseed}`);
  });
}

server.listen(PORT, () => {
  console.log(`[seeder] origin/manifest/player on ${HOST}; webseed base=${WEBSEED_BASE}; window=${WINDOW}`);
  if (WATCH_DIR) {
    console.log(`[seeder] WATCH mode: polling ${WATCH_DIR} for /${SEG_RE.source}/ every ${POLL_MS}ms`);
    const scan = () => {
      let files;
      try { files = fs.readdirSync(SRC_DIR); } catch { return; }
      files.filter(f => SEG_RE.test(f)).sort(numeric).forEach(seedSegment);
    };
    scan();
    setInterval(scan, POLL_MS);
  } else {
    const segs = fs.readdirSync(MEDIA).filter(f => /^seg-\d+\.m4s$/.test(f)).sort(numeric);
    if (!fs.existsSync(path.join(MEDIA, INIT_NAME)) || segs.length === 0) {
      console.error(`No segments in ${MEDIA}. Run: npm run segments`);
      process.exit(1);
    }
    console.log(`[seeder] STATIC mode: revealing ${segs.length} segments, 1 every ${REVEAL_MS}ms`);
    let i = 0;
    const tick = () => { if (i < segs.length) { seedSegment(segs[i++]); setTimeout(tick, REVEAL_MS); } };
    tick();
  }
});

function numeric(a, b) {
  return Number((a.match(/\d+/) || [0])[0]) - Number((b.match(/\d+/) || [0])[0]);
}
