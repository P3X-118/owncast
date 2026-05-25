/*
 * wt-hls-loader.js — a hls.js *fragment* loader backed by WebTorrent.
 *
 * For each media segment hls.js wants, we look up that segment's torrent
 * (magnet) in the seeder manifest and fetch it over WebTorrent: peers first,
 * with the segment's WebSeed (the origin HLS URL) as automatic fallback. Bytes
 * that aren't torrented (the playlist, fMP4 init segments, or any miss) fall
 * back to a plain XHR against the origin, so playback never depends on P2P.
 *
 * hls.js demuxes whatever bytes we return (MPEG-TS or fMP4), so this works with
 * Owncast's default TS output -- no transcoder change needed.
 *
 * Register only as the FRAGMENT loader so playlists load normally:
 *   const hls = new Hls({ fLoader: createWebTorrentFragmentLoader({ wt, getEntry, trackers, onBytes }) });
 *
 *   wt        : a WebTorrent client instance
 *   getEntry  : (segmentName) => ({ magnet }) | null   (from the manifest)
 *   trackers  : wss tracker list for peer discovery
 *   onBytes   : ({ p2p, origin }) => void  (metrics hook)
 */
/* global XMLHttpRequest, performance */
window.createWebTorrentFragmentLoader = function createWebTorrentFragmentLoader({
  wt,
  getEntry,
  trackers,
  onBytes,
}) {
  function newStats() {
    return {
      aborted: false,
      loaded: 0,
      retry: 0,
      total: 0,
      chunkCount: 0,
      bwEstimate: 0,
      loading: { start: 0, first: 0, end: 0 },
      parsing: { start: 0, end: 0 },
      buffering: { start: 0, first: 0, end: 0 },
    };
  }

  return class WebTorrentFragmentLoader {
    constructor(config) {
      this.config = config;
      this.stats = newStats();
      this._aborted = false;
      this._settled = false;
      this._xhr = null;
      this._timer = null;
    }

    destroy() {
      this.abort();
    }

    abort() {
      this._aborted = true;
      this.stats.aborted = true;
      if (this._xhr) {
        try {
          this._xhr.abort();
        } catch (e) {
          /* noop */
        }
        this._xhr = null;
      }
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      // Intentionally do NOT remove the torrent: keep seeding it to other peers.
    }

    _finish(data, context, callbacks, networkDetails, split) {
      if (this._aborted || this._settled) return;
      this._settled = true;
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      const s = this.stats;
      s.loading.first = s.loading.first || performance.now();
      s.loading.end = performance.now();
      s.loaded = data.byteLength;
      s.total = data.byteLength;
      if (onBytes) onBytes(split || { p2p: 0, origin: data.byteLength });
      callbacks.onSuccess({ url: context.url, data }, s, context, networkDetails);
    }

    _httpFallback(context, config, callbacks, reason) {
      if (this._aborted || this._settled) return;
      const xhr = new XMLHttpRequest();
      this._xhr = xhr;
      xhr.open('GET', context.url, true);
      xhr.responseType = 'arraybuffer';
      xhr.timeout = (config && config.timeout) || 20000;
      xhr.onload = () => {
        this._xhr = null;
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
          this._finish(xhr.response, context, callbacks, xhr, { p2p: 0, origin: xhr.response.byteLength });
        } else if (!this._aborted) {
          callbacks.onError({ code: xhr.status, text: `wt-loader fallback (${reason}) http ${xhr.status}` }, context, xhr, this.stats);
        }
      };
      xhr.onerror = () => {
        this._xhr = null;
        if (!this._aborted) callbacks.onError({ code: xhr.status, text: `wt-loader fallback (${reason}) network error` }, context, xhr, this.stats);
      };
      xhr.ontimeout = () => {
        this._xhr = null;
        if (!this._aborted) callbacks.onTimeout(this.stats, context, xhr);
      };
      xhr.send();
    }

    load(context, config, callbacks) {
      this.stats.loading.start = performance.now();
      const name = context.url.split('?')[0].split('/').pop();
      const entry = getEntry ? getEntry(name) : null;

      // Not a torrented segment (playlist/init/miss) -> straight to origin.
      if (!entry || !entry.magnet || typeof wt === 'undefined' || !wt) {
        this._httpFallback(context, config, callbacks, 'no-magnet');
        return;
      }

      // Safety net: if WebTorrent stalls, fall back to the origin so playback
      // never blocks on peers.
      this._timer = setTimeout(() => {
        if (!this._settled && !this._aborted) this._httpFallback(context, config, callbacks, 'wt-timeout');
      }, (config && config.timeout) || 15000);

      const onTorrent = torrent => {
        const file = torrent.files && torrent.files[0];
        if (!file) {
          this._httpFallback(context, config, callbacks, 'no-file');
          return;
        }
        file
          .arrayBuffer()
          .then(data => {
            const wire = (torrent.wires || []).reduce((n, w) => n + (w.downloaded || 0), 0);
            const p2p = Math.min(data.byteLength, wire);
            this._finish(data, context, callbacks, torrent, { p2p, origin: Math.max(0, data.byteLength - p2p) });
          })
          .catch(() => this._httpFallback(context, config, callbacks, 'arraybuffer-failed'));
      };

      try {
        const existing = wt.get(entry.magnet);
        if (existing) {
          if (existing.ready) onTorrent(existing);
          else existing.once('ready', () => onTorrent(existing));
        } else {
          wt.add(entry.magnet, trackers ? { announce: trackers } : {}, onTorrent);
        }
      } catch (e) {
        this._httpFallback(context, config, callbacks, `add-threw:${e.message}`);
      }
    }
  };
};
