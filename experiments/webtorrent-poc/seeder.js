// Static file server for the okast P2P livestream player.
//
// Architecture pivot (2026-05-26): we now use p2p-media-loader (Novage, MIT) --
// the production-tested library for browser P2P-HLS. It runs entirely in the
// browser, discovers peers via public wss trackers, and exchanges segments by
// name over a persistent WebRTC peer mesh. The seeder no longer needs to seed
// torrents, sign mesh peers, or serve a manifest -- the library derives stream
// identity from the HLS playlist URL and handles everything else.
//
// This service therefore reduces to a static file server that hosts:
//   - the player HTML (player-hls.html, at /)
//   - the hls.js + p2p-media-loader browser bundles in /lib/
//
// HTTP origin fallback for HLS segments is okast itself (radio.cooey.club/hls),
// reached directly by hls.js with no proxying through this container.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8088);

const STATIC = {
  '/': ['player-hls.html', 'text/html'],
  '/index.html': ['player-hls.html', 'text/html'],
  '/player-hls.html': ['player-hls.html', 'text/html'],
  '/lib/hls.min.js': ['lib/hls.min.js', 'text/javascript'],
  '/lib/p2p-media-loader-core.es.min.js': ['lib/p2p-media-loader-core.es.min.js', 'text/javascript'],
  '/lib/p2p-media-loader-hlsjs.es.min.js': ['lib/p2p-media-loader-hlsjs.es.min.js', 'text/javascript'],
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const entry = STATIC[p];
  if (entry) {
    try {
      const body = fs.readFileSync(path.join(__dirname, 'public', entry[0]));
      res.writeHead(200, {
        'content-type': entry[1],
        'access-control-allow-origin': '*',
        'cache-control': 'no-cache',
      });
      return res.end(body);
    } catch {
      /* fall through to 404 */
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[player-host] http://localhost:${PORT} -- serving player + p2p-media-loader bundles`);
});
