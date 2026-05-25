// P0 PoC seeder: turns a directory of sequential fMP4 segments (simulating a
// live HLS output) into a WebTorrent-backed live stream.
//
// For each revealed segment it:
//   1. seeds the segment as its own torrent, with a WebSeed (BEP-19) pointing at
//      the segment's own HTTP URL -> origin fallback is automatic,
//   2. publishes the magnet + .torrent + webseed in a sliding-window manifest.
//
// Everything (player, media/webseed, manifest, .torrent files) is served from
// this one origin, so the browser player has no cross-origin (CORS) problem.
//
// This proves the *live torrent strategy* (the valuable idea from BemTV),
// rebuilt on WebTorrent, without any player/Clappr coupling.
//
// Env: PORT (8088), MEDIA (./media), WINDOW (4 = live segments kept),
//      REVEAL_MS (2000 = how fast to reveal segments; real live would be
//      CHUNK_SECONDS*1000), CHUNK_SECONDS (20, advisory metadata).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebTorrent from 'webtorrent';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const MEDIA = path.resolve(__dirname, process.env.MEDIA || 'media');
const WINDOW = Number(process.env.WINDOW || 4);
const REVEAL_MS = Number(process.env.REVEAL_MS || 2000);
const CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS || 20);
const HOST = process.env.PUBLIC_HOST || `http://localhost:${PORT}`;

// Public wss trackers let browser peers find each other. Flaky in the wild;
// the design doc calls for self-hosting these on the SGC mesh later.
const TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev'];

const client = new WebTorrent();
client.on('error', e => console.error('[webtorrent]', e.message));

const live = []; // sliding window: [{ seq, name, length, infoHash, magnet, torrentUrl, webseed }]
const torrentFiles = new Map(); // name -> .torrent Buffer

const initName = 'init.mp4';
const segments = fs
  .readdirSync(MEDIA)
  .filter(f => /^seg-\d+\.m4s$/.test(f))
  .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

if (!fs.existsSync(path.join(MEDIA, initName)) || segments.length === 0) {
  console.error(`No segments in ${MEDIA}. Run: npm run segments`);
  process.exit(1);
}

const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, HOST);
  const p = url.pathname;

  if (p === '/' || p === '/player' || p === '/index.html') {
    return send(res, 200, 'text/html', fs.readFileSync(path.join(__dirname, 'public', 'player.html')));
  }
  if (p === '/lib/webtorrent.min.js') {
    return send(res, 200, 'text/javascript', fs.readFileSync(path.join(__dirname, 'public', 'lib', 'webtorrent.min.js')));
  }
  if (p === '/manifest.json') {
    return send(res, 200, 'application/json', JSON.stringify({
      chunkSeconds: CHUNK_SECONDS,
      window: WINDOW,
      initUrl: `/media/${initName}`,
      trackers: TRACKERS,
      live,
    }, null, 2));
  }
  if (p.startsWith('/media/')) {
    const f = path.join(MEDIA, path.basename(p));
    if (!fs.existsSync(f)) return send(res, 404, 'text/plain', 'not found');
    const stat = fs.statSync(f);
    const type = p.endsWith('.mp4') ? 'video/mp4' : 'video/iso.segment';
    // WebSeed (BEP-19) fetches pieces via HTTP Range -> must answer 206.
    const range = req.headers.range && /bytes=(\d+)-(\d*)/.exec(req.headers.range);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : stat.size - 1;
      res.writeHead(206, {
        'content-type': type,
        'access-control-allow-origin': '*',
        'accept-ranges': 'bytes',
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'content-length': end - start + 1,
      });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, {
      'content-type': type,
      'access-control-allow-origin': '*',
      'accept-ranges': 'bytes',
      'content-length': stat.size,
    });
    return fs.createReadStream(f).pipe(res);
  }
  if (p.startsWith('/torrents/')) {
    const name = path.basename(p).replace(/\.torrent$/, '');
    const buf = torrentFiles.get(name);
    if (!buf) return send(res, 404, 'text/plain', 'not found');
    return send(res, 200, 'application/x-bittorrent', buf);
  }
  return send(res, 404, 'text/plain', 'not found');
});

server.listen(PORT, () => {
  console.log(`[seeder] origin + manifest + player on ${HOST}`);
  console.log(`[seeder] revealing ${segments.length} segments, 1 every ${REVEAL_MS}ms, window=${WINDOW}`);
  revealNext(0);
});

function revealNext(i) {
  if (i >= segments.length) {
    console.log('[seeder] all segments revealed; continuing to seed the live window.');
    return;
  }
  const name = segments[i];
  const filePath = path.join(MEDIA, name);
  const webseed = `${HOST}/media/${name}`;

  client.seed(filePath, { name, urlList: [webseed], announce: TRACKERS }, torrent => {
    torrentFiles.set(name, torrent.torrentFile);
    const entry = {
      seq: i,
      name,
      length: torrent.length,
      infoHash: torrent.infoHash,
      magnet: torrent.magnetURI,
      torrentUrl: `/torrents/${name}.torrent`,
      webseed: `/media/${name}`,
    };
    live.push(entry);
    while (live.length > WINDOW) {
      const dropped = live.shift();
      console.log(`[seeder] window slid past seq=${dropped.seq} (${dropped.name})`);
      // Real impl would destroy the torrent after a grace period; PoC keeps
      // seeding so late joiners/tests still work.
    }
    console.log(`[seeder] +seq=${entry.seq} ${name} infoHash=${entry.infoHash} (${entry.length}B)`);
    setTimeout(() => revealNext(i + 1), REVEAL_MS);
  });
}
