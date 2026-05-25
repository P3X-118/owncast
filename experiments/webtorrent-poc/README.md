# okast WebTorrent P2P live — P0 PoC

Player-agnostic proof that the **live-streaming torrent strategy** (the idea worth
keeping from `clappr-p2phls-plugin`/BemTV) works on **WebTorrent**: package a live
HLS-style stream into per-chunk torrents, share them peer-to-peer, and fall back
to the origin automatically via **WebSeed (BEP-19)**. See the design doc:
`../webtorrent-p2p-hls.md`.

This is "off to the side" — it does NOT touch Owncast.

## What it proves

- Each ~20s segment is seeded as its own torrent whose **WebSeed = the segment's
  own origin URL**, so origin fallback is free.
- A **sliding-window manifest** advertises the live chunks (magnet + .torrent +
  webseed), refreshed like an HLS playlist.
- A headless Node consumer fetches the newest chunk with **trackers + DHT
  disabled** (webseed is then the only possible source) and verifies the bytes
  match the origin **sha256, byte-for-byte**.
- Verified 2026-05-25: `P0 RESULT: PASS` (2.29MB chunk via webseed in ~1.9s,
  hash match).

## Run it

```bash
npm install            # webtorrent (node side)
npm run segments       # generate self-contained 20s fMP4 test segments (uses
                       # the okast image's ffmpeg; no host ffmpeg needed)

# terminal 1 — seeder (origin + manifest + player + torrents):
PORT=8099 REVEAL_MS=1500 npm run seed
# REVEAL_MS = how fast segments appear (1500 for a quick demo; 20000 ~ real live)

# terminal 2 — headless protocol verification (webseed origin-fallback path):
BASE=http://localhost:8099 npm run consume     # prints P0 RESULT: PASS

# browser P2P + playback (human test):
#   open http://localhost:8099 in TWO tabs/devices and watch the stats:
#   peers > 0 and "P2P bytes" rising = chunks shared peer-to-peer (origin offloaded)
```

Uses the **P3X-118/webtorrent fork**: the browser build is vendored at
`public/lib/webtorrent.min.js` (the fork's `dist/`; dir is `lib/` not `vendor/`
because the repo root .gitignore ignores `vendor/`). The node side currently
pulls `webtorrent@3.0.0` (identical to the fork today; switch to the fork once it
carries SGC changes).

## Files

- `make-segments.sh` — ffmpeg → `media/init.mp4` + `media/seg-N.m4s` (gitignored).
- `seeder.js` — origin (Range/206 for webseed), per-chunk torrent w/ webseed,
  sliding-window `/manifest.json`, serves `.torrent` + the player.
- `consume.js` — headless verifier (webseed-only, sha256 integrity).
- `public/player.html` — browser player: WebTorrent (fork) + MediaSource append +
  P2P/origin byte stats.

## Known limits / next (see design doc P1+)

- Browser P2P needs wss trackers; public ones are flaky → self-host on the mesh.
- MSE codec string in `player.html` is pinned to the test encode (h264 Main +
  AAC); real integration uses the player's own demux (hls.js loader path).
- No real "live" tail handling (continuous ffmpeg, discontinuities), chunk-size
  slider, or metrics yet — those are P1–P3.
