# Experiment: WebTorrent-backed P2P livestream for okast (Owncast)

Status: **research / design** (branch `sgc-dev-webtorrent`). No runtime code yet.
Goal owner: SGC. Reference: webtorrent/webtorrent#448 (live streaming over
WebTorrent — chunk the live stream into torrents, reassemble client-side).

## Goal

Make the radio.cooey.club / okast livestream **peer-to-peer backed**: viewers
share recent video with each other so origin bandwidth scales sub-linearly with
audience. Concretely, package the live video into **~20-second torrent chunks**
and have the player pull each chunk over WebTorrent (peers first, origin as
fallback), feeding a normal media element.

## What we're starting from (analysis 2026-05-25)

### Owncast HLS pipeline (this repo)
- Transcoder (`core/transcoder/transcoder.go`) runs ffmpeg with
  `-hls_time <SecondsPerSegment>` and `-hls_list_size <SegmentCount>`, both from
  the active `models.LatencyLevel`. GOP is forced to one i-frame per segment
  (`core/transcoder/transcoder.go:418`), so **segment length == latency level**.
  → 20s chunks = a (new) high-latency level `SecondsPerSegment: 20`.
- Segments + playlists are written to `config.HLSStoragePath` and served by
  `handlers.HandleHLSRequest` at `/hls/*` (`webserver/handlers/hls.go`), or from
  S3/`videoServingEndpoint`. Standard HLS over HTTP.
- **Player is video.js 8 + VHS** (`web/package.json`), not Clappr and not hls.js.

### clappr-p2phls-plugin (BemTV) — `~/sgc/_p2p-research/clappr-p2phls-plugin`
- `p2phls@0.1.8`, ~2015 (gulp/browserify/es6ify; `clappr@latest` pinned).
- **Does NOT use webtorrent.** It rolls its own swarm: `rtc-quickconnect` for
  WebRTC signaling against a "tracker" (a signaling server), `rtc-bufferedchannel`
  data channels, and a custom BitTorrent-ish protocol in `swarm.js`/`peer.js`
  (interested / choke / contributors / satisfy). `resource_requester.js` +
  `cdn_requester.js` do buffer-aware "P2P vs HTTP origin" selection.
- Value to us = the **concepts**, not the code: HLS-segment swarm exchange,
  buffer-aware P2P/HTTP decisioning, segment cache, Clappr playback hooks.

### webtorrent fork — `~/sgc/_p2p-research/webtorrent`
- Clean `webtorrent@3.0.0` (modern, ESM, WebRTC). No SGC commits yet.
- No built-in *live* support (torrents are static), BUT two features matter:
  - **WebSeed (BEP-19)**: a torrent can list an HTTP URL as a seed. If no peers
    have a piece, WebTorrent fetches it over HTTP. → our **origin fallback is
    free**: set each chunk's webseed to its Owncast `/hls/...ts` URL.
  - Browser WebRTC peer transport + tracker/DHT discovery — replaces everything
    BemTV hand-rolled.

## Key insight that reshapes the design

WebTorrent's **webseed** subsumes most of BemTV's machinery. We do **not** need
BemTV's custom swarm or its CDN-fallback logic — WebTorrent gives peer discovery,
the BitTorrent protocol, WebRTC transport, AND HTTP-origin fallback. The work
reduces to: (1) make each 20s chunk a torrent whose webseed is the existing HLS
URL, (2) have the player fetch chunks via WebTorrent and feed them to the media
element, (3) announce per-chunk infohashes to the player.

## Proposed architecture

```
ffmpeg (20s segments) ──► HLS dir (/hls/*.ts, stream.m3u8)  [unchanged origin]
                               │
            ┌──────────────────┴───────────────────┐
            ▼                                        ▼
   [NEW] chunk seeder (sidecar)              HTTP origin (webseed target)
   - watches HLS dir for new .ts             - serves /hls/<seg>.ts as today
   - create-torrent per segment,
     webseed = https://radio.cooey.club/hls/<seg>.ts
   - seeds it (WebTorrent hybrid node)
   - writes magnet/infohash into an
     augmented manifest (p2p.m3u8 or
     sidecar p2p.json), sliding window
            │
            ▼
   player (web): WebTorrent client
   - reads augmented manifest, for each live-edge chunk:
       torrent = add(magnet)  // peers first, webseed (origin) fallback
   - on torrent 'done' (or streaming), append bytes to MediaSource
   - also seeds what it has to other viewers
   - sliding window: destroy torrents older than N
```

### The 20-second decision
- Larger chunks (20s) = more time for a chunk to propagate across peers before
  it's needed → higher P2P hit-rate; fewer torrents/announces; **but ~20-40s
  added latency**. Acceptable for a radio/"broadcast" feel; not for low-latency
  interactive. This matches issue #448's "bigger chunks stream better P2P".
- Implemented as a new `LatencyLevel{ SecondsPerSegment: 20, SegmentCount: ~6 }`
  (≈120s live window = the P2P sharing window).

### Player integration — decision needed (see below)
- **Path A — hls.js + custom loader (recommended).** Swap the web player to
  hls.js (or hls.js-inside-video.js) and implement a WebTorrent-backed
  `loader`/`fLoader`. hls.js's loader API is purpose-built for exactly this; MSE,
  init segments, codec handling, ABR, and live playlist refresh are handled by
  hls.js. This is the modern, proven pattern (cf. `p2p-media-loader-hlsjs`).
  WebTorrent + webseed gives transport + fallback. Cleanest, least bespoke MSE.
- **Path B — Clappr + port BemTV (the literally-named tools).** Replace video.js
  with Clappr, take BemTV's Clappr/HLS hooks, replace its swarm with WebTorrent.
  Closest to the named repos but: BemTV needs heavy modernization, and swapping
  Owncast's player loses video.js/VHS features. More surface area.
- **Path C — keep video.js/VHS + xhr hooks.** VHS's custom-loader story is weaker
  than hls.js; harder to fully intercept segment fetches. Not recommended.

## Components to build (regardless of path)

1. **20s latency level** — config + `models.LatencyLevel` entry; expose it.
2. **Chunk seeder sidecar** (Node, using the P3X-118/webtorrent fork): watch HLS
   dir, create-torrent-per-segment with webseed, seed, publish magnets in a
   sliding-window manifest. Ships as a second process in the okast image (or a
   companion container in `okast-ar`).
3. **Augmented manifest** — `p2p.json` (or extended m3u8 tags) mapping live-edge
   segment → magnet/infohash, refreshed like the HLS playlist.
4. **Player P2P layer** — WebTorrent client + chosen integration (Path A loader),
   append to MSE, seed-back, sliding-window cleanup, graceful fallback to plain
   HLS when WebRTC/peers unavailable.
5. **Signaling/discovery infra** — WebTorrent trackers (wss). Either run our own
   `bittorrent-tracker` (wss) on the SGC mesh or use public wss trackers.
   (Plus TURN for NAT-restricted peers — reuse/extend existing infra.)

## Phased plan

- **P0 — PoC (off to the side):** static 20s .ts files → seeder makes torrents w/
  webseed → a bare WebTorrent web client fetches a chunk P2P and MSE-appends it.
  Proves the core loop without touching Owncast.
- **P1 — origin integration:** 20s latency level in Owncast; seeder sidecar wired
  to the live HLS dir; augmented manifest served at `/hls/p2p.json`.
- **P2 — player integration:** Path A loader in the okast web app behind a flag
  (`OWNCAST_P2P_ENABLED` runtime config via /api/config, like the Discord work);
  falls back to normal HLS when disabled/unsupported.
- **P3 — hardening:** sliding-window correctness, peer caps, metrics (P2P vs
  origin bytes), TURN, security review, bundle + image + deploy.

## Risks / open questions

- **Latency:** 20s chunks push live latency to ~30-60s. Confirm acceptable.
- **MSE correctness:** init segment handling, discontinuities, codec strings,
  fMP4 vs MPEG-TS. (hls.js handles this; a bespoke MSE path is the risky part of
  Path B.) Consider switching HLS output to fMP4/CMAF for cleaner MSE.
- **Server seeding language split:** Owncast is Go; webtorrent is Node. The
  seeder is a Node sidecar (or evaluate a Go torrent lib + JS webseed). Adds a
  process to the image.
- **Discovery infra:** need wss tracker(s); public ones are flaky — plan to self
  host on the SGC mesh.
- **Browser support / fallback:** must degrade to plain HLS cleanly (Safari/iOS
  WebRTC quirks; corporate NAT). P2P is an enhancement, never a hard dependency.
- **Security:** content integrity is fine (BitTorrent piece hashes), but validate
  we don't let peers poison segments; rate-limit; same-origin/CSP for the worker.

## Decisions needed before implementation

1. Player path: **A (hls.js loader, recommended)** vs **B (Clappr + BemTV port)**?
2. Acceptable live-latency budget (drives chunk size; 20s assumed).
3. Self-host wss tracker on the SGC mesh (recommended) vs public trackers?
4. Seeder as a sidecar process inside the okast image, or a separate companion
   container in `okast-ar`?
5. Scope of "pick apart" BemTV: reuse as conceptual reference (Path A) vs port its
   code (Path B)?
