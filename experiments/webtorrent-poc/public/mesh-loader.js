/*
 * mesh-loader.js -- hls.js fragment loader backed by the persistent-peer-mesh
 * (see mesh.js). For each segment hls.js wants:
 *   1. Try the mesh (mesh.fetch with a short deadline) -- if a peer in the mesh
 *      has the segment, the bytes flow over WebRTC data channels.
 *   2. Otherwise (or on deadline), fall back to plain HTTP at the origin. The
 *      bytes are then ALSO handed back to the mesh (mesh.cache) so this browser
 *      becomes a provider for the next viewer to ask.
 * This replaces the per-segment-torrent loader that couldn't drive piece
 * transfer through WebRTC inside any deadline.
 */
/* global XMLHttpRequest, performance */
window.createMeshFragmentLoader = function createMeshFragmentLoader({ mesh, getEntry, onBytes }) {
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

  return class MeshFragmentLoader {
    constructor(config) {
      this.config = config;
      this.stats = newStats();
      this._aborted = false;
      this._settled = false;
      this._xhr = null;
    }

    destroy() { this.abort(); }

    abort() {
      this._aborted = true;
      this.stats.aborted = true;
      if (this._xhr) {
        try { this._xhr.abort(); } catch (e) { /* noop */ }
        this._xhr = null;
      }
    }

    _finish(data, context, callbacks, networkDetails, split) {
      if (this._aborted || this._settled) return;
      this._settled = true;
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
          // Become a provider: tell the mesh we now have this segment so other
          // peers can fetch it from us instead of the origin.
          const name = context.url.split('?')[0].split('/').pop();
          if (mesh && mesh.cache) {
            try { mesh.cache(name, xhr.response); } catch (e) { /* noop */ }
          }
          this._finish(xhr.response, context, callbacks, xhr, {
            p2p: 0,
            origin: xhr.response.byteLength,
            reason: `origin:${reason}`,
          });
        } else if (!this._aborted) {
          callbacks.onError({ code: xhr.status, text: `mesh-loader fallback (${reason}) http ${xhr.status}` }, context, xhr, this.stats);
        }
      };
      xhr.onerror = () => {
        this._xhr = null;
        if (!this._aborted) callbacks.onError({ code: xhr.status, text: `mesh-loader fallback (${reason}) network error` }, context, xhr, this.stats);
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

      if (!mesh) {
        this._httpFallback(context, config, callbacks, 'no-mesh');
        return;
      }
      // The mesh only carries segments in the manifest; init segments and
      // anything else go straight to origin.
      const entry = getEntry ? getEntry(name) : null;
      if (!entry) {
        this._httpFallback(context, config, callbacks, 'no-entry');
        return;
      }

      mesh
        .fetch(name, 6000)
        .then(buf => {
          if (this._aborted || this._settled) return;
          this._finish(buf, context, callbacks, null, {
            p2p: buf.byteLength,
            origin: 0,
            reason: 'p2p-mesh',
          });
        })
        .catch(err => {
          if (this._aborted || this._settled) return;
          this._httpFallback(context, config, callbacks, `mesh:${err.message}`);
        });
    }
  };
};
