// Framework-agnostic P2P-HLS player core.
//
// Lifted from the proven test page (experiments/webtorrent-poc/public/player-hls.html)
// that runs in production at radio.cooey.club /p2p/. The full reasoning behind
// each tuning value lives in the commit history on branch sgc-dev-webtorrent;
// only the load-bearing rationale is kept here.
//
// Usage:
//   const handle = await attachP2PHls(videoEl, { source: '/hls/stream.m3u8' });
//   // ... later
//   handle.destroy();
//
// SSR-safe: this module loads hls.js and p2p-media-loader dynamically, so
// `import` at the top of a React component is fine -- the libraries only touch
// the DOM inside attachP2PHls(), which the caller invokes from useEffect.

import type HlsType from 'hls.js';

export interface P2PStats {
  peersConnected: number;
  p2pBytes: number;
  httpBytes: number;
  // simple per-source chunk tally (e.g. http:42, p2p:-PM020:17)
  chunks: Record<string, number>;
}

export interface P2PPlayerOptions {
  source: string;
  // POST every ~10s with byte deltas; default '/api/p2p/report'. Tolerates 404
  // silently (okast versions without the endpoint just ignore it).
  reportEndpoint?: string | null;
  // Polled by the host for live UI; not used internally.
  onStats?: (stats: P2PStats) => void;
}

export interface P2PPlayerHandle {
  destroy: () => void;
  getStats: () => P2PStats;
  // Exposed for diagnostics (admin / `?debug`).
  hls: HlsType | null;
}

export async function attachP2PHls(
  video: HTMLVideoElement,
  opts: P2PPlayerOptions,
): Promise<P2PPlayerHandle> {
  // Dynamic imports so this module is SSR-safe.
  const [{ default: Hls }, { HlsJsP2PEngine }] = await Promise.all([
    import('hls.js'),
    // eslint-disable-next-line import/no-unresolved -- resolver config issue; package is installed
    import('p2p-media-loader-hlsjs'),
  ]);

  const stats: P2PStats = { peersConnected: 0, p2pBytes: 0, httpBytes: 0, chunks: {} };
  const peers = new Set<string>();

  if (!Hls.isSupported()) {
    // Safari on iOS uses native HLS in <video src=...>. We deliberately do not
    // fall back here -- p2p-media-loader needs MSE/hls.js, and Safari without
    // MSE simply runs as a plain HLS viewer with no P2P. The caller may set
    // video.src directly for that path.
    return {
      destroy: () => {},
      getStats: () => stats,
      hls: null,
    };
  }

  const HlsWithP2P = HlsJsP2PEngine.injectMixin(Hls);
  const hls: HlsType = new HlsWithP2P({
    lowLatencyMode: false,
    backBufferLength: 30,
    // Defaults around live-edge handling are kept. liveSyncDurationCount=2 was
    // tried and broke bootstrap on okast's 6-segment playlist (hls.js raced the
    // playlist rotation -> stream-controller "Frag error: t is null" loops).
    // The bufferStalledError handler below is what recovers from drift.
    p2p: {
      core: {
        // Single tracker on purpose: multi-tracker SDP signaling broke Firefox
        // and (per library docs) Safari. Novage's own deployment is the
        // library author's reference tracker.
        announceTrackers: ['wss://tracker.novage.com.ua'],
        // Tighter than the 15s default so live-edge segments are P2P-eligible
        // (with 15s, every segment within reach of the playhead was forced to
        // HTTP-priority and P2P never engaged).
        highDemandTimeWindow: 10,
        // Short startup grace so a fresh viewer can always bootstrap via HTTP
        // when no peer has any segment yet. Larger values starved
        // Firefox/Vivaldi on first load.
        httpDownloadInitialTimeoutMs: 3000,
        // Generous cache so this peer remains a provider after the playhead
        // moves past a segment.
        cachedSegmentsCount: 50,
      },
    },
  } as any);

  const { p2pEngine } = hls as any;
  p2pEngine.addEventListener(
    'onChunkDownloaded',
    (bytes: number, source: string, peerId?: string) => {
      if (source === 'p2p') {
        stats.p2pBytes += bytes;
        const r = peerId ? `p2p:${peerId.slice(0, 6)}` : 'p2p';
        stats.chunks[r] = (stats.chunks[r] || 0) + 1;
      } else {
        stats.httpBytes += bytes;
        stats.chunks.http = (stats.chunks.http || 0) + 1;
      }
    },
  );
  p2pEngine.addEventListener('onPeerConnect', (d: { peerId: string }) => {
    peers.add(d.peerId);
    stats.peersConnected = peers.size;
  });
  p2pEngine.addEventListener('onPeerClose', (d: { peerId: string }) => {
    peers.delete(d.peerId);
    stats.peersConnected = peers.size;
  });

  // Live-edge stall recovery: when buffer is depleted on a live stream,
  // hls.js's default nudgeOnStall can't recover (nothing to nudge into).
  // Force-seek to liveSyncPosition so playback resumes from a segment that
  // actually exists in the current playlist. PeerTube uses the same recipe.
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data.fatal && data.details === 'bufferStalledError') {
      const target = (hls as any).liveSyncPosition;
      if (target != null && Math.abs(target - video.currentTime) > 1) {
        // eslint-disable-next-line no-param-reassign -- intentional: seek the host's <video> to live edge
        video.currentTime = target;
      }
    }
  });

  hls.loadSource(opts.source);
  hls.attachMedia(video);

  // Optional periodic report to okast for the admin /api/p2p dashboard. Quiet
  // 404 fallback for okast images that don't have the endpoint.
  const reportEndpoint =
    opts.reportEndpoint === undefined ? '/api/p2p/report' : opts.reportEndpoint;
  let reportTimer: number | null = null;
  let lastP2p = 0;
  let lastHttp = 0;
  const clientId = Math.random().toString(36).slice(2, 10);
  if (reportEndpoint) {
    reportTimer = window.setInterval(() => {
      const dP = stats.p2pBytes - lastP2p;
      const dO = stats.httpBytes - lastHttp;
      lastP2p = stats.p2pBytes;
      lastHttp = stats.httpBytes;
      fetch(reportEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          chunkSeconds: 20,
          peers: stats.peersConnected,
          p2pBytes: dP,
          originBytes: dO,
          clientId,
        }),
      }).catch(() => {});
    }, 10000);
  }

  let statsTimer: number | null = null;
  if (opts.onStats) {
    statsTimer = window.setInterval(() => opts.onStats!(stats), 1000);
  }

  return {
    destroy: () => {
      if (reportTimer != null) clearInterval(reportTimer);
      if (statsTimer != null) clearInterval(statsTimer);
      try {
        hls.destroy();
      } catch {
        /* noop */
      }
    },
    getStats: () => stats,
    hls,
  };
}
