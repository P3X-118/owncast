// P0 PoC verifier (Node, headless). Proves the live-torrent loop end-to-end at
// the protocol level WITHOUT a browser:
//   1. read the live manifest from the seeder,
//   2. take the newest chunk, fetch its .torrent (metadata) from the origin,
//   3. add it to a WebTorrent client with trackers + DHT DISABLED, so the only
//      possible source is the WebSeed (the origin HTTP URL) -> this deterministic-
//      ally exercises the BEP-19 origin-fallback path,
//   4. verify the downloaded bytes match the origin file byte-for-byte (sha256).
//
// Browser-to-browser WebRTC P2P + MSE playback is the part that needs a human
// (two tabs of player.html); this verifies everything else.

import crypto from 'node:crypto';
import WebTorrent from 'webtorrent';

const BASE = process.env.BASE || 'http://localhost:8088';

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

const streamToBuffer = stream =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

async function main() {
  const manifest = await (await fetch(`${BASE}/manifest.json`)).json();
  if (!manifest.live?.length) throw new Error('manifest has no live chunks yet');
  const chunk = manifest.live[manifest.live.length - 1];
  console.log(`[consume] newest chunk: seq=${chunk.seq} ${chunk.name} (${chunk.length}B) infoHash=${chunk.infoHash}`);

  const torrentBuf = Buffer.from(await (await fetch(`${BASE}${chunk.torrentUrl}`)).arrayBuffer());
  const originBuf = Buffer.from(await (await fetch(`${BASE}${chunk.webseed}`)).arrayBuffer());
  console.log(`[consume] fetched .torrent (${torrentBuf.length}B) + origin file (${originBuf.length}B) for reference`);

  // tracker+dht off => no peers possible => must use the WebSeed (origin).
  const client = new WebTorrent({ tracker: false, dht: false, lsd: false });
  client.on('error', e => {
    console.error('[consume] FAIL client error:', e.message);
    process.exit(1);
  });

  const t0 = Date.now();
  client.add(torrentBuf, { announce: [] }, torrent => {
    console.log(`[consume] added; sources: ${torrent.numPeers} peers + webseed(s)=${(torrent.urlList || []).join(',') || '(none!)'}`);
    if (!torrent.urlList || torrent.urlList.length === 0) {
      console.error('[consume] FAIL: torrent carries no webseed (urlList empty) -> origin fallback would not work');
      process.exit(1);
    }
    torrent.on('done', async () => {
      const file = torrent.files[0];
      const got = await streamToBuffer(file.createReadStream());
      const ok = got.length === originBuf.length && sha256(got) === sha256(originBuf);
      const ms = Date.now() - t0;
      console.log(`[consume] downloaded ${got.length}B in ${ms}ms via webseed; received=${torrent.received}B`);
      console.log(`[consume] sha256 match vs origin: ${ok ? 'YES' : 'NO'}`);
      console.log(ok ? '\nP0 RESULT: PASS - per-chunk torrent + webseed origin-fallback + integrity verified' : '\nP0 RESULT: FAIL');
      client.destroy(() => process.exit(ok ? 0 : 1));
    });
  });

  setTimeout(() => {
    console.error('[consume] FAIL: timed out after 30s');
    process.exit(1);
  }, 30000);
}

main().catch(e => {
  console.error('[consume] FAIL:', e.message);
  process.exit(1);
});
