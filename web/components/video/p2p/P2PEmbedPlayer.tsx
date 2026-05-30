// P2P-HLS embed player. Wraps the framework-agnostic core (p2pPlayer.ts) in a
// minimal React component for the /embed/video page. Two presentation modes
// share the SAME muxed HLS stream (so audio-only viewers still download full
// TS segments and seed video to peers):
//
//   mode='video+audio' (default) : video element visible with native controls
//   mode='audio'                 : video element rendered off-screen; audio
//                                  plays from the same element; tiny play
//                                  affordance is shown if autoplay was blocked
//
// "video-only" is intentionally not offered -- product decision per the embed
// goals.
import React, { FC, useEffect, useRef, useState } from 'react';
import type { P2PPlayerHandle, P2PStats } from './p2pPlayer';

export type P2PEmbedMode = 'video+audio' | 'audio';

export type P2PEmbedPlayerProps = {
  source: string;
  online: boolean;
  mode: P2PEmbedMode;
  initiallyMuted?: boolean;
  // If true, surfaces a small overlay with live stats (peers, P2P/HTTP bytes,
  // buffer ranges, last hls.js events). Useful for the admin /api/p2p path
  // and for debugging in the browser via `?debug=1`.
  debug?: boolean;
};

const hiddenStyle: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  opacity: 0,
  pointerEvents: 'none',
};

const visibleStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  background: '#000',
};

const fmt = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${(n / 1e3).toFixed(0)}kB`);

export const P2PEmbedPlayer: FC<P2PEmbedPlayerProps> = ({
  source,
  online,
  mode,
  initiallyMuted = false,
  debug = false,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const handleRef = useRef<P2PPlayerHandle | null>(null);
  const [stats, setStats] = useState<P2PStats | null>(null);
  const [needsGesture, setNeedsGesture] = useState(false);

  const audioOnly = mode === 'audio';

  // Bring up the P2P-HLS player. The core is dynamically imported so the
  // ~200KB of hls.js + p2p-media-loader doesn't ship to SSR or to non-embed
  // pages.
  useEffect(() => {
    if (!online || !videoRef.current) return undefined;
    const video = videoRef.current;
    let cancelled = false;

    (async () => {
      const { attachP2PHls } = await import('./p2pPlayer');
      if (cancelled) return;
      handleRef.current = await attachP2PHls(video, {
        source,
        onStats: debug ? setStats : undefined,
      });
    })();

    return () => {
      cancelled = true;
      handleRef.current?.destroy();
      handleRef.current = null;
    };
  }, [source, online, debug]);

  // Autoplay typically requires either muted or a prior user gesture. We
  // start muted; if even that is blocked (rare), surface a tap-to-play.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !online) return undefined;
    const tryPlay = () => {
      const p = video.play();
      if (p && p.catch) {
        p.catch(() => setNeedsGesture(true));
      }
    };
    tryPlay();
    return undefined;
  }, [online]);

  // On the first user gesture anywhere, unmute (mirrors OwncastPlayer's
  // setupSoundOnGesture but simpler -- the embed has no settings panel).
  useEffect(() => {
    if (!online) return undefined;
    const events: Array<'pointerdown' | 'keydown' | 'touchend'> = [
      'pointerdown',
      'keydown',
      'touchend',
    ];
    const unmute = () => {
      const video = videoRef.current;
      if (video) {
        try {
          if (video.muted) {
            video.muted = false;
            if (video.volume === 0) video.volume = 0.7;
          }
          const p = video.play();
          if (p && p.catch) p.catch(() => {});
          setNeedsGesture(false);
        } catch {
          /* noop */
        }
      }
      events.forEach(ev => document.removeEventListener(ev, unmute));
    };
    events.forEach(ev => document.addEventListener(ev, unmute, { once: true }));
    return () => {
      events.forEach(ev => document.removeEventListener(ev, unmute));
    };
  }, [online]);

  if (!online) return null;

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        autoPlay
        muted={initiallyMuted || audioOnly}
        playsInline
        controls={!audioOnly}
        style={audioOnly ? hiddenStyle : visibleStyle}
      />
      {needsGesture && (
        <button
          type="button"
          onClick={() => {
            const v = videoRef.current;
            if (v) {
              v.muted = false;
              v.play().catch(() => {});
              setNeedsGesture(false);
            }
          }}
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            border: 'none',
            fontSize: '1rem',
            cursor: 'pointer',
          }}
        >
          Tap to play
        </button>
      )}
      {debug && stats && (
        <pre
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            margin: 0,
            padding: '0.5rem',
            background: 'rgba(0,0,0,0.75)',
            color: '#e8e6f0',
            font: '12px/1.4 ui-monospace, monospace',
            whiteSpace: 'pre-wrap',
          }}
        >
          {`peers : ${stats.peersConnected}\n` +
            `p2p   : ${fmt(stats.p2pBytes)}\n` +
            `http  : ${fmt(stats.httpBytes)}\n` +
            `chunks: ${Object.entries(stats.chunks)
              .map(([k, v]) => `${k}:${v}`)
              .join('  ')}`}
        </pre>
      )}
    </div>
  );
};
