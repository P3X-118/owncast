import React, { FC, useContext, useEffect } from 'react';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useHotkeys } from 'react-hotkeys-hook';
import classNames from 'classnames';
import { ErrorBoundary } from 'react-error-boundary';
import { VideoJS } from '../VideoJS/VideoJS';
import ViewerPing from '../viewer-ping';
import { VideoPoster } from '../VideoPoster/VideoPoster';
import { getLocalStorage, setLocalStorage } from '../../../utils/localStorage';
import { isVideoPlayingAtom, clockSkewAtom } from '../../stores/ClientConfigStore';
import PlaybackMetrics from '../metrics/playback';
import { createVideoSettingsMenuButton } from '../settings-menu';
import LatencyCompensator from '../latencyCompensator';
import styles from './OwncastPlayer.module.scss';
import { VideoSettingsServiceContext } from '../../../services/video-settings-service';
import { ComponentError } from '../../ui/ComponentError/ComponentError';

const PLAYER_VOLUME = 'owncast_volume';
const LATENCY_COMPENSATION_ENABLED = 'latencyCompensatorEnabled';

const ping = new ViewerPing();
let playbackMetrics = null;
let latencyCompensator = null;
let latencyCompensatorEnabled = false;

// iOS suspends an inline <video> when the page is backgrounded or the phone
// is locked, so its audio stops. An <audio> element, by contrast, keeps
// playing in the background with lock-screen controls. We only need this
// companion-audio handoff on iOS; every other platform keeps the video's
// audio alive on its own.
const isIosDevice = (): boolean => {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  return /iphone|ipad|ipod/i.test(ua) || iPadOS;
};

export type OwncastPlayerProps = {
  source: string;
  online: boolean;
  initiallyMuted?: boolean;
  title: string;
  className?: string;
};

export const OwncastPlayer: FC<OwncastPlayerProps> = ({
  source,
  online,
  initiallyMuted = false,
  title,
  className,
}) => {
  const VideoSettingsService = useContext(VideoSettingsServiceContext);
  const playerRef = React.useRef(null);
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [videoPlaying, setVideoPlaying] = useRecoilState<boolean>(isVideoPlayingAtom);
  const clockSkew = useRecoilValue<Number>(clockSkewAtom);

  const setSavedVolume = () => {
    try {
      playerRef.current.volume(getLocalStorage(PLAYER_VOLUME) || 1);
    } catch (err) {
      console.warn(err);
    }
  };

  const handleVolume = () => {
    setLocalStorage(PLAYER_VOLUME, playerRef.current.muted() ? 0 : playerRef.current.volume());
  };

  const togglePlayback = () => {
    if (playerRef.current.paused()) {
      playerRef.current.play();
    } else {
      playerRef.current.pause();
    }
  };

  const toggleMute = () => {
    if (playerRef.current.muted() || playerRef.current.volume() === 0) {
      playerRef.current.volume(0.7);
    } else {
      playerRef.current.volume(0);
    }
  };

  const toggleFullScreen = () => {
    if (playerRef.current.isFullscreen()) {
      playerRef.current.exitFullscreen();
    } else {
      playerRef.current.requestFullscreen();
    }
  };

  const startLatencyCompensator = () => {
    if (latencyCompensator) {
      latencyCompensator.stop();
    }

    latencyCompensatorEnabled = true;

    latencyCompensator = new LatencyCompensator(playerRef.current);
    latencyCompensator.setClockSkew(clockSkew);
    latencyCompensator.enable();
    setLocalStorage(LATENCY_COMPENSATION_ENABLED, true);
  };

  const stopLatencyCompensator = () => {
    if (latencyCompensator) {
      latencyCompensator.disable();
    }
    latencyCompensator = null;
    latencyCompensatorEnabled = false;
    setLocalStorage(LATENCY_COMPENSATION_ENABLED, false);
  };

  // Toggle minimized latency mode. Return the new state.
  const toggleLatencyCompensator = () => {
    if (latencyCompensatorEnabled) {
      stopLatencyCompensator();
    } else {
      startLatencyCompensator();
    }
    return latencyCompensatorEnabled;
  };

  const setupLatencyCompensator = player => {
    const tech = player.tech({ IWillNotUseThisInPlugins: true });

    // VHS is required.
    if (!tech || !tech.vhs) {
      return;
    }

    const latencyCompensatorEnabledSaved = getLocalStorage(LATENCY_COMPENSATION_ENABLED);

    if (latencyCompensatorEnabledSaved === 'true' && tech && tech.vhs) {
      startLatencyCompensator();
    } else {
      stopLatencyCompensator();
    }
  };

  const createSettings = async (player, videojs) => {
    const videoQualities = await VideoSettingsService.getVideoQualities();
    const menuButton = createVideoSettingsMenuButton(
      player,
      videojs,
      videoQualities,
      toggleLatencyCompensator,
    );
    player.controlBar.addChild(
      menuButton,
      {},
      // eslint-disable-next-line no-underscore-dangle
      player.controlBar.children_.length - 2,
    );
    setupLatencyCompensator(player);
  };

  const setupAirplay = (player, videojs) => {
    // eslint-disable-next-line no-prototype-builtins
    if (window.hasOwnProperty('WebKitPlaybackTargetAvailabilityEvent')) {
      const VJSButtonClass = videojs.getComponent('Button');

      class ConcreteButtonClass extends VJSButtonClass {
        constructor() {
          super(player);
        }

        // eslint-disable-next-line class-methods-use-this
        handleClick() {
          try {
            const videoElement = document.getElementsByTagName('video')[0];
            (videoElement as any).webkitShowPlaybackTargetPicker();
          } catch (e) {
            console.error(e);
          }
        }
      }

      const ccbc = new ConcreteButtonClass();
      const concreteButtonInstance = player.controlBar.addChild(ccbc);
      concreteButtonInstance.addClass('vjs-airplay');
    }
  };

  // Disable Picture-in-Picture on the underlying <video> element so the
  // browser-native PiP affordance (shown on hover in some browsers) is gone.
  const disablePictureInPicture = player => {
    try {
      const videoEl = player.tech({ IWillNotUseThisInPlugins: true })?.el();
      if (videoEl) {
        videoEl.disablePictureInPicture = true;
        videoEl.setAttribute('disablePictureInPicture', '');
      }
    } catch (e) {
      console.warn(e);
    }
  };

  // If unmuted autoplay was blocked by the browser, the player starts muted.
  // Unmute on the first user gesture anywhere on the page so the radio gets
  // sound with minimal friction (no need to hunt for the unmute button).
  const setupSoundOnGesture = player => {
    // On iOS the companion <audio> element is the audible source (the video
    // stays muted so it can be suspended in the background without silencing
    // the radio); see setupBackgroundAudio. Don't unmute the video there.
    if (isIosDevice()) {
      return;
    }
    const events = ['pointerdown', 'keydown', 'touchend'];
    const unmute = () => {
      try {
        if (player.muted()) {
          player.muted(false);
          if (player.volume() === 0) {
            player.volume(getLocalStorage(PLAYER_VOLUME) || 0.7);
          }
          const p = player.play();
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) {
        console.warn(e);
      }
      events.forEach(ev => document.removeEventListener(ev, unmute));
    };
    events.forEach(ev => document.addEventListener(ev, unmute, { once: true }));
  };

  // Wire up the Media Session API so audio keeps playing when the page is
  // backgrounded or the phone is locked, and so OS lock-screen media controls
  // appear and work.
  const setupMediaSession = player => {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
      return;
    }
    try {
      // eslint-disable-next-line no-undef
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title || 'Live Stream',
        artwork: [
          { src: '/logo', sizes: '512x512' },
          { src: '/logo', sizes: '256x256' },
          { src: '/logo', sizes: '128x128' },
        ],
      });
      navigator.mediaSession.setActionHandler('play', () => player.play());
      navigator.mediaSession.setActionHandler('pause', () => player.pause());
      // A live stream cannot seek, so clear those handlers to avoid showing
      // non-functional scrubbing controls on the lock screen.
      navigator.mediaSession.setActionHandler('seekbackward', null);
      navigator.mediaSession.setActionHandler('seekforward', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
    } catch (e) {
      console.warn(e);
    }
  };

  // iOS-only: keep the radio audible when the page is backgrounded or the
  // phone is locked. iOS suspends an inline <video> in the background, but an
  // <audio> element that is actively producing sound keeps its background
  // audio session alive. So on iOS we make a hidden companion <audio> element
  // (same HLS source) the AUDIBLE source and keep the video muted -- the
  // muted video can be suspended in the background without silencing anything.
  //
  // A muted element does NOT hold a background session, which is why warming
  // it muted and unmuting on background dropped audio with an initial pause.
  // Here the companion plays UNMUTED from the first user gesture (iOS will not
  // start playback without a gesture), so the session is continuous across
  // the background transition with no handoff to drop.
  const setupBackgroundAudio = player => {
    if (!isIosDevice()) {
      return;
    }
    const audioEl = audioRef.current;
    if (!audioEl) {
      return;
    }
    // Keep the video silent so it never echoes the companion audio. (iOS
    // ignores media-element volume -- only `muted` matters -- so the saved
    // volume is irrelevant here.)
    try {
      player.muted(true);
      audioEl.src = source;
      audioEl.preload = 'auto';
      audioEl.muted = false;
    } catch (e) {
      console.warn(e);
    }

    // Start the audible companion on the first user gesture.
    const events = ['pointerdown', 'keydown', 'touchend'];
    const start = () => {
      try {
        const p = audioEl.play();
        if (p && p.catch) p.catch(() => {});
      } catch (e) {
        console.warn(e);
      }
      events.forEach(ev => document.removeEventListener(ev, start));
    };
    events.forEach(ev => document.addEventListener(ev, start, { once: true }));

    // Route the OS lock-screen / Control Center controls to the companion
    // audio (the element that owns the active session on iOS).
    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', () => {
          audioEl.play();
          player.play();
        });
        navigator.mediaSession.setActionHandler('pause', () => {
          audioEl.pause();
          player.pause();
        });
      } catch (e) {
        console.warn(e);
      }
    }

    // When returning to the foreground, nudge the (muted) video picture back
    // to life and make sure audio is still going. Nothing on hide -- the
    // audio element keeps playing on its own.
    const onVisibility = () => {
      if (document.hidden) {
        return;
      }
      try {
        const pa = audioEl.play();
        if (pa && pa.catch) pa.catch(() => {});
        const pv = player.play();
        if (pv && pv.catch) pv.catch(() => {});
      } catch (e) {
        console.warn(e);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    player.on('dispose', () => {
      document.removeEventListener('visibilitychange', onVisibility);
      events.forEach(ev => document.removeEventListener(ev, start));
      try {
        audioEl.pause();
      } catch {
        /* noop */
      }
    });
  };

  // Register keyboard shortcut for the space bar to toggle playback
  useHotkeys('space', e => {
    e.preventDefault();
    togglePlayback();
  });

  // Register keyboard shortcut for f to toggle full screen
  useHotkeys('f', toggleFullScreen, {
    enableOnContentEditable: false,
  });

  // Register keyboard shortcut for the "m" key to toggle mute
  useHotkeys('m', toggleMute, {
    enableOnContentEditable: false,
  });

  useHotkeys('0', () => playerRef.current.volume(playerRef.current.volume() + 0.1), {
    enableOnContentEditable: false,
  });
  useHotkeys('9', () => playerRef.current.volume(playerRef.current.volume() - 0.1), {
    enableOnContentEditable: false,
  });

  const videoJsOptions = {
    // 'any' = try to autoplay WITH sound; if the browser blocks unmuted
    // autoplay, fall back to muted playback (then unmute on first gesture,
    // see setupSoundOnGesture).
    autoplay: 'any',
    controls: true,
    responsive: true,
    fluid: false,
    fill: true,
    playsinline: true,
    liveui: true,
    preload: 'auto',
    muted: initiallyMuted,
    controlBar: {
      pictureInPictureToggle: false,
      progressControl: {
        seekBar: false,
      },
    },
    html5: {
      vhs: {
        // used to select the lowest bitrate playlist initially. This helps to decrease playback start time. This setting is false by default.
        enableLowInitialPlaylist: true,
        experimentalBufferBasedABR: true,
        useNetworkInformationApi: true,
        maxPlaylistRetries: 30,
      },
    },
    liveTracker: {
      trackingThreshold: 0,
      liveTolerance: 15,
    },
    sources: [
      {
        src: source,
        type: 'application/x-mpegURL',
      },
    ],
  };

  const handlePlayerReady = (player, videojs) => {
    playerRef.current = player;
    setSavedVolume();
    setupAirplay(player, videojs);
    disablePictureInPicture(player);
    setupMediaSession(player);
    setupSoundOnGesture(player);
    setupBackgroundAudio(player);

    // You can handle player events here, for example:
    player.on('waiting', () => {
      console.debug('player is waiting');
    });

    player.on('dispose', () => {
      console.debug('player will dispose');
      ping.stop();
    });

    player.on('playing', () => {
      console.debug('player is playing');
      ping.start();
      setVideoPlaying(true);
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'playing';
      }
    });

    player.on('pause', () => {
      console.debug('player is paused');
      ping.stop();
      setVideoPlaying(false);
      if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    });

    player.on('ended', () => {
      console.debug('player is ended');
      ping.stop();
      setVideoPlaying(false);
    });

    videojs.hookOnce();

    player.on('volumechange', handleVolume);

    playbackMetrics = new PlaybackMetrics(player, videojs);
    playbackMetrics.setClockSkew(clockSkew);

    createSettings(player, videojs);
  };

  useEffect(() => {
    if (playbackMetrics) {
      playbackMetrics.setClockSkew(clockSkew);
    }
  }, [clockSkew]);

  useEffect(
    () => () => {
      stopLatencyCompensator();
      playbackMetrics?.stop();
    },
    [],
  );

  return (
    <ErrorBoundary
      // eslint-disable-next-line react/no-unstable-nested-components
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ComponentError
          componentName="OwncastPlayer"
          message={error.message}
          retryFunction={resetErrorBoundary}
        />
      )}
    >
      <div className={classNames(styles.container, className)} id="player">
        {online && (
          <div className={styles.player}>
            <VideoJS options={videoJsOptions} onReady={handlePlayerReady} aria-label={title} />
          </div>
        )}
        <div className={styles.poster}>
          {!videoPlaying && (
            <VideoPoster online={online} initialSrc="/thumbnail.jpg" src="/thumbnail.jpg" />
          )}
        </div>
        {/* iOS-only companion audio for lock-screen / background playback.
            Inert (no src) on every other platform; see setupBackgroundAudio.
            A live radio stream carries no caption track. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        {online && <audio ref={audioRef} aria-hidden="true" style={{ display: 'none' }} />}
      </div>
    </ErrorBoundary>
  );
};
