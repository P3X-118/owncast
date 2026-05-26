// WebSocket signaling hub + HTTP origin for the okast persistent-peer-mesh
// P2P livestream. Replaces the per-segment-torrent design (which couldn't
// drive piece transfer through WebRTC inside any sane deadline -- see the
// design doc and the "wt-deadline" PoC result).
//
// Responsibilities:
//   - HTTP: player + JS assets + /manifest.json + /media/<seg> (Range/206
//     origin fallback for any peer that can't find the segment in the mesh).
//   - WS at /ws: relays offer/answer/ICE between connected browser peers so
//     they can establish persistent RTCDataChannel meshes between themselves.
//     The Node seeder is signaling-only; it is not itself a WebRTC peer.
//   - Manifest reflects the current HLS window (segment NAMES only -- no
//     torrents, no magnets). Mesh peers refer to segments by name.
//
// Env:
//   PORT          8088
//   WINDOW        6
//   CHUNK_SECONDS 20
//   PUBLIC_HOST   http://localhost:$PORT
//   WEBSEED_BASE  $PUBLIC_HOST/media   URL prefix serving segment bytes
//   WATCH mode:   WATCH_DIR, SEG_RE (default seg-\d+\.m4s; \d+\.ts for owncast),
//                 INIT_NAME (default init.mp4), POLL_MS
//   STATIC mode (no WATCH_DIR): MEDIA (./media), REVEAL_MS

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);
const WINDOW = Number(process.env.WINDOW || 6);
const CHUNK_SECONDS = Number(process.env.CHUNK_SECONDS || 20);
const HOST = process.env.PUBLIC_HOST || `http://localhost:${PORT}`;

const WATCH_DIR = process.env.WATCH_DIR ? path.resolve(process.env.WATCH_DIR) : null;
const MEDIA = path.resolve(__dirname, process.env.MEDIA || 'media');
const SRC_DIR = WATCH_DIR || MEDIA;
const WEBSEED_BASE = process.env.WEBSEED_BASE || `${HOST}/media`;
const POLL_MS = Number(process.env.POLL_MS || 1000);
const REVEAL_MS = Number(process.env.REVEAL_MS || 2000);
const SEG_RE = new RegExp(`^${process.env.SEG_RE || 'seg-\\d+\\.m4s'}$`);
const INIT_NAME = process.env.INIT_NAME || 'init.mp4';

let seq = 0;
const seen = new Set();
const live = []; // sliding window: [{ seq, name, length, webseed }]

function segNum(name) {
  const m = name.match(/(\d+)\.[A-Za-z0-9]+$/);
  return m ? Number(m[1]) : 0;
}
function numeric(a, b) {
  return segNum(a) - segNum(b);
}

function addSegment(name) {
  if (seen.has(name)) return;
  seen.add(name);
  const filePath = path.join(SRC_DIR, name);
  let length = 0;
  try {
    length = fs.statSync(filePath).size;
  } catch {
    return;
  }
  const webseed = `${WEBSEED_BASE}/${name}`;
  const entry = { seq: seq++, name, length, webseed };
  live.push(entry);
  while (live.length > WINDOW) {
    const d = live.shift();
    console.log(`[seeder] window slid past seq=${d.seq} (${d.name})`);
  }
  console.log(`[seeder] +seq=${entry.seq} ${name} (${entry.length}B)`);
  // Hint connected peers; not used as authoritative -- they poll /manifest.json too.
  broadcastSignaling({ type: 'manifest-update', entry });
}

// ----- HTTP origin -----
const send = (res, code, type, body) => {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(body);
};

const STATIC = {
  '/': ['player-hls.html', 'text/html'],
  '/index.html': ['player-hls.html', 'text/html'],
  '/raw': ['player.html', 'text/html'],
  '/player-hls.html': ['player-hls.html', 'text/html'],
  '/mesh.js': ['mesh.js', 'text/javascript'],
  '/mesh-loader.js': ['mesh-loader.js', 'text/javascript'],
  '/wt-hls-loader.js': ['wt-hls-loader.js', 'text/javascript'],
  '/lib/hls.min.js': ['lib/hls.min.js', 'text/javascript'],
  '/lib/webtorrent.min.js': ['lib/webtorrent.min.js', 'text/javascript'],
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, HOST).pathname;

  if (STATIC[p]) {
    const [rel, type] = STATIC[p];
    try {
      return send(res, 200, type, fs.readFileSync(path.join(__dirname, 'public', rel)));
    } catch {
      return send(res, 404, 'text/plain', 'not found');
    }
  }
  if (p === '/manifest.json') {
    const initUrl = fs.existsSync(path.join(SRC_DIR, INIT_NAME)) ? `${WEBSEED_BASE}/${INIT_NAME}` : null;
    return send(
      res,
      200,
      'application/json',
      JSON.stringify({ chunkSeconds: CHUNK_SECONDS, window: WINDOW, initUrl, live }, null, 2),
    );
  }
  if (p.startsWith('/media/')) {
    const f = path.join(SRC_DIR, path.basename(p));
    if (!fs.existsSync(f)) return send(res, 404, 'text/plain', 'not found');
    const stat = fs.statSync(f);
    const type = f.endsWith('.mp4')
      ? 'video/mp4'
      : f.endsWith('.ts')
        ? 'video/mp2t'
        : 'video/iso.segment';
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
  return send(res, 404, 'text/plain', 'not found');
});

// ----- WebSocket signaling -----
const wss = new WebSocketServer({ noServer: true });
const peers = new Map(); // peerId -> ws

function broadcastSignaling(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of peers.values()) {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(raw);
      } catch {
        /* noop */
      }
    }
  }
}

wss.on('connection', ws => {
  const peerId = Math.random().toString(36).slice(2, 12);
  peers.set(peerId, ws);
  console.log(`[mesh] +peer ${peerId} (total ${peers.size})`);

  // Tell the newcomer who else is here so it can offer them.
  const others = Array.from(peers.keys()).filter(id => id !== peerId);
  ws.send(JSON.stringify({ type: 'hello', peerId, peers: others }));
  // Tell existing peers about the newcomer so they expect an offer.
  for (const [id, otherWs] of peers) {
    if (id !== peerId && otherWs.readyState === otherWs.OPEN) {
      otherWs.send(JSON.stringify({ type: 'newpeer', peerId }));
    }
  }

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || !msg.to) return;
    const target = peers.get(msg.to);
    if (target && target.readyState === target.OPEN) {
      target.send(JSON.stringify({ ...msg, from: peerId }));
    }
  });

  ws.on('close', () => {
    peers.delete(peerId);
    console.log(`[mesh] -peer ${peerId} (total ${peers.size})`);
    for (const otherWs of peers.values()) {
      if (otherWs.readyState === otherWs.OPEN) {
        otherWs.send(JSON.stringify({ type: 'leave', peerId }));
      }
    }
  });

  ws.on('error', e => console.warn('[mesh] ws error:', e.message));
});

server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, HOST).pathname;
  if (p === '/ws') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ----- segment watcher -----
server.listen(PORT, () => {
  console.log(`[seeder] http+ws on ${HOST}; webseed base=${WEBSEED_BASE}; window=${WINDOW}`);
  if (WATCH_DIR) {
    console.log(
      `[seeder] WATCH mode: polling ${WATCH_DIR} for /${SEG_RE.source}/ every ${POLL_MS}ms`,
    );
    const scan = () => {
      let files;
      try {
        files = fs.readdirSync(SRC_DIR);
      } catch {
        return;
      }
      files
        .filter(f => SEG_RE.test(f))
        .sort(numeric)
        .forEach(addSegment);
    };
    scan();
    setInterval(scan, POLL_MS);
  } else {
    const segs = fs
      .readdirSync(MEDIA)
      .filter(f => /^seg-\d+\.m4s$/.test(f))
      .sort(numeric);
    if (segs.length === 0) {
      console.error(`No segments in ${MEDIA}. Run: npm run segments`);
      process.exit(1);
    }
    console.log(`[seeder] STATIC mode: revealing ${segs.length} segments, 1 every ${REVEAL_MS}ms`);
    let i = 0;
    const tick = () => {
      if (i < segs.length) {
        addSegment(segs[i++]);
        setTimeout(tick, REVEAL_MS);
      }
    };
    tick();
  }
});
