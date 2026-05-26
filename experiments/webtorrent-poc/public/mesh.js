/*
 * mesh.js -- persistent-peer-mesh client for the okast P2P livestream.
 *
 * Replaces the per-segment-torrent approach (where each segment was its own
 * webtorrent swarm, requiring fresh WebRTC handshake per segment, which never
 * actually drove piece transfer in time). Here we keep ONE long-lived WebRTC
 * data-channel mesh between all viewers + signal via the seeder's /ws and
 * exchange segments BY NAME over the mesh with a small protocol.
 *
 * Protocol over the data channel:
 *   string  {type:"have", segs:["name1","name2",...]}
 *   string  {type:"want", seg:"name"}
 *   string  {type:"data-start", seg:"name", size:N}
 *   binary  ArrayBuffer chunk
 *   binary  ArrayBuffer chunk
 *   ...
 *   string  {type:"data-end", seg:"name"}
 *   string  {type:"nope", seg:"name"}
 *
 * Usage:
 *   const mesh = createMesh({ wsUrl, onPeerCount, onBytes, cacheSize: 20 });
 *   mesh.fetch(name, deadlineMs) -> Promise<ArrayBuffer>
 *   mesh.cache(name, buf)       // make this peer a provider
 *   mesh.stats()                // { peers, cached, knownProviders }
 */
/* global RTCPeerConnection, WebSocket */
window.createMesh = function createMesh({ wsUrl, onPeerCount, onBytes, cacheSize = 20 } = {}) {
  const ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const CHUNK = 16 * 1024;        // safe DataChannel chunk size
  const HIGH_WATER = 1024 * 1024; // pause sending if buffered > 1MB

  const peers = new Map(); // peerId -> { pc, dc, has:Set, recv:{seg,size,chunks,received}|null }
  const cache = new Map(); // segName -> ArrayBuffer
  const cacheOrder = [];
  const wants = new Map(); // segName -> { resolve, reject, timer }
  const haveWaiters = new Map(); // segName -> () => void (called when any peer broadcasts HAVE for it)
  let myId = null;

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleSignaling(msg);
  };
  ws.onclose = () => console.warn('[mesh] ws closed');
  ws.onerror = e => console.warn('[mesh] ws error:', e?.message || e?.type || e);

  function send(target, obj) {
    try { ws.send(JSON.stringify({ ...obj, to: target })); }
    catch (e) { console.warn('[mesh] ws send:', e); }
  }

  function handleSignaling(msg) {
    if (msg.type === 'hello') {
      myId = msg.peerId;
      msg.peers.forEach(initiateConnection);
    } else if (msg.type === 'newpeer') {
      // existing peer; wait for incoming offer
    } else if (msg.type === 'offer') {
      handleOffer(msg.from, msg.offer);
    } else if (msg.type === 'answer') {
      const p = peers.get(msg.from);
      if (p) p.pc.setRemoteDescription(msg.answer).catch(e => console.warn('[mesh] setRemoteDescription:', e));
    } else if (msg.type === 'ice') {
      const p = peers.get(msg.from);
      if (p && msg.candidate) p.pc.addIceCandidate(msg.candidate).catch(() => {});
    } else if (msg.type === 'leave') {
      removePeer(msg.peerId);
    }
  }

  function newPC(peerId) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    pc.onicecandidate = ev => {
      if (ev.candidate) send(peerId, { type: 'ice', candidate: ev.candidate });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed' || s === 'disconnected') removePeer(peerId);
    };
    return pc;
  }

  function initiateConnection(peerId) {
    if (peers.has(peerId)) return;
    const pc = newPC(peerId);
    const dc = pc.createDataChannel('mesh', { ordered: true });
    const peer = { pc, dc: null, has: new Set(), recv: null };
    peers.set(peerId, peer);
    setupDataChannel(peerId, dc);
    pc.createOffer()
      .then(o => pc.setLocalDescription(o).then(() => o))
      .then(o => send(peerId, { type: 'offer', offer: o }))
      .catch(e => console.warn('[mesh] createOffer:', e));
    notifyPeerCount();
  }

  function handleOffer(peerId, offer) {
    if (peers.has(peerId)) removePeer(peerId);
    const pc = newPC(peerId);
    const peer = { pc, dc: null, has: new Set(), recv: null };
    peers.set(peerId, peer);
    pc.ondatachannel = ev => setupDataChannel(peerId, ev.channel);
    pc.setRemoteDescription(offer)
      .then(() => pc.createAnswer())
      .then(a => pc.setLocalDescription(a).then(() => a))
      .then(a => send(peerId, { type: 'answer', answer: a }))
      .catch(e => console.warn('[mesh] handleOffer:', e));
    notifyPeerCount();
  }

  function setupDataChannel(peerId, dc) {
    const peer = peers.get(peerId);
    if (!peer) return;
    peer.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = HIGH_WATER / 2;
    dc.onopen = () => {
      // Announce what I have
      try { dc.send(JSON.stringify({ type: 'have', segs: Array.from(cache.keys()) })); } catch {}
      notifyPeerCount();
    };
    dc.onclose = () => removePeer(peerId);
    dc.onerror = () => removePeer(peerId);
    dc.onmessage = ev => handleMeshMessage(peerId, ev.data);
  }

  function removePeer(peerId) {
    const p = peers.get(peerId);
    if (!p) return;
    try { p.dc?.close(); } catch {}
    try { p.pc.close(); } catch {}
    peers.delete(peerId);
    notifyPeerCount();
  }

  async function sendChunks(peer, buf) {
    const bytes = new Uint8Array(buf);
    for (let off = 0; off < bytes.byteLength; off += CHUNK) {
      // Backpressure: pause if too much buffered
      while (peer.dc && peer.dc.bufferedAmount > HIGH_WATER) {
        await new Promise(r => {
          const onLow = () => { peer.dc.removeEventListener('bufferedamountlow', onLow); r(); };
          peer.dc.addEventListener('bufferedamountlow', onLow);
        });
      }
      if (!peer.dc || peer.dc.readyState !== 'open') return;
      const end = Math.min(off + CHUNK, bytes.byteLength);
      peer.dc.send(bytes.slice(off, end).buffer);
    }
  }

  async function handleMeshMessage(peerId, raw) {
    const peer = peers.get(peerId);
    if (!peer) return;
    if (typeof raw === 'string') {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'have') {
        msg.segs.forEach(s => {
          peer.has.add(s);
          const w = haveWaiters.get(s);
          if (w) w();
        });
      } else if (msg.type === 'want') {
        const data = cache.get(msg.seg);
        if (!data) {
          try { peer.dc.send(JSON.stringify({ type: 'nope', seg: msg.seg })); } catch {}
          return;
        }
        try {
          peer.dc.send(JSON.stringify({ type: 'data-start', seg: msg.seg, size: data.byteLength }));
          await sendChunks(peer, data);
          peer.dc.send(JSON.stringify({ type: 'data-end', seg: msg.seg }));
        } catch (e) { console.warn('[mesh] send segment:', e); }
      } else if (msg.type === 'data-start') {
        peer.recv = { seg: msg.seg, size: msg.size, chunks: [], received: 0 };
      } else if (msg.type === 'data-end') {
        const r = peer.recv;
        peer.recv = null;
        if (!r || r.seg !== msg.seg) return;
        const buf = concat(r.chunks, r.received);
        if (buf.byteLength !== r.size) {
          rejectWant(r.seg, new Error('size-mismatch'));
          return;
        }
        cacheSet(r.seg, buf);
        const w = wants.get(r.seg);
        if (w) { clearTimeout(w.timer); wants.delete(r.seg); w.resolve(buf); }
        if (onBytes) onBytes({ p2p: buf.byteLength, origin: 0, reason: `mesh:${peerId.slice(0, 4)}` });
        broadcast({ type: 'have', segs: [r.seg] }, peerId);
      } else if (msg.type === 'nope') {
        // try another peer
        tryAnotherPeer(msg.seg, peerId);
      }
    } else if (raw instanceof ArrayBuffer) {
      if (peer.recv) {
        peer.recv.chunks.push(new Uint8Array(raw));
        peer.recv.received += raw.byteLength;
      }
    }
  }

  function concat(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
  }

  function broadcast(msg, exceptId) {
    const raw = JSON.stringify(msg);
    for (const [id, p] of peers) {
      if (id === exceptId) continue;
      if (p.dc && p.dc.readyState === 'open') {
        try { p.dc.send(raw); } catch {}
      }
    }
  }

  function cacheSet(name, buf) {
    if (cache.has(name)) return;
    cache.set(name, buf);
    cacheOrder.push(name);
    while (cacheOrder.length > cacheSize) {
      const old = cacheOrder.shift();
      cache.delete(old);
    }
  }

  function notifyPeerCount() {
    if (!onPeerCount) return;
    const open = Array.from(peers.values()).filter(p => p.dc && p.dc.readyState === 'open').length;
    onPeerCount(open);
  }

  function rejectWant(name, err) {
    const w = wants.get(name);
    if (w) { clearTimeout(w.timer); wants.delete(name); w.reject(err); }
  }

  function findProvider(name, exceptId) {
    for (const [id, p] of peers) {
      if (id === exceptId) continue;
      if (p.has.has(name) && p.dc && p.dc.readyState === 'open') return [id, p];
    }
    return null;
  }

  function tryAnotherPeer(name, exceptId) {
    const w = wants.get(name);
    if (!w) return; // no longer wanted
    const next = findProvider(name, exceptId);
    if (!next) {
      rejectWant(name, new Error('no-provider'));
      return;
    }
    try { next[1].dc.send(JSON.stringify({ type: 'want', seg: name })); } catch {}
  }

  function requestFromPeer(name, providerEntry, deadline) {
    const [, peer] = providerEntry;
    try { peer.dc.send(JSON.stringify({ type: 'want', seg: name })); }
    catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        wants.delete(name);
        reject(new Error('mesh-deadline'));
      }, deadline);
      wants.set(name, { resolve, reject, timer });
    });
  }

  // Wait briefly for any peer to broadcast HAVE for `name`. Returns the
  // provider entry or null on timeout. This is what lets P2P engage at the
  // synchronized live edge: when multiple peers want the same fresh segment,
  // a random yield staggers them so whoever wins races to origin first,
  // caches, broadcasts HAVE -- and the others receive that HAVE and pull
  // from them over the mesh instead of also hitting the origin.
  function waitForProvider(name, maxWaitMs) {
    const immediate = findProvider(name);
    if (immediate) return Promise.resolve(immediate);
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        haveWaiters.delete(name);
        resolve(findProvider(name));
      }, maxWaitMs);
      haveWaiters.set(name, () => {
        clearTimeout(timer);
        haveWaiters.delete(name);
        resolve(findProvider(name));
      });
    });
  }

  return {
    fetch(name, deadline = 6000) {
      if (cache.has(name)) return Promise.resolve(cache.get(name));
      // Random yield (2.5-4.5s) lets the synchronized live-edge race resolve:
      // one peer's yield ends first, fetches origin, caches, broadcasts HAVE
      // -- our HAVE waiter resolves before the timeout and we pull via mesh.
      const yieldMs = 2500 + Math.random() * 2000;
      return waitForProvider(name, yieldMs).then(found => {
        if (!found) throw new Error('no-peer-has-it');
        return requestFromPeer(name, found, deadline);
      });
    },
    cache(name, buf) {
      cacheSet(name, buf);
      broadcast({ type: 'have', segs: [name] });
    },
    stats() {
      const open = Array.from(peers.values()).filter(p => p.dc && p.dc.readyState === 'open').length;
      let knownProviders = 0;
      for (const p of peers.values()) knownProviders += p.has.size;
      return { peers: open, cached: cache.size, knownProviders };
    },
  };
};
