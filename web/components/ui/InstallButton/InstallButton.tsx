import { FC, useEffect, useState } from 'react';
import { Button, Modal } from 'antd';
import styles from './InstallButton.module.scss';

// SGC fork: "Cooeynet Phone Home" — a PWA install affordance.
// - Android/Chromium: captures the `beforeinstallprompt` event and fires
//   the real native install prompt on click.
// - iOS/Safari: no programmatic install API exists, so we show Share ->
//   Add to Home Screen instructions instead.
// - Hidden entirely when already running as an installed PWA.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

const isStandalone = (): boolean => {
  if (typeof window === 'undefined') return false;
  // The manifest requests display "fullscreen", which falls back through
  // standalone/minimal-ui depending on platform support, so check them all.
  const installedDisplayMode = ['fullscreen', 'standalone', 'minimal-ui'].some(
    mode => window.matchMedia?.(`(display-mode: ${mode})`).matches,
  );
  // iOS Safari exposes navigator.standalone when launched from the home screen.
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone;
  return Boolean(installedDisplayMode || iosStandalone);
};

const isIos = (): boolean => {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  const iOSDevice = /iphone|ipad|ipod/i.test(ua);
  // iPadOS 13+ reports as Mac; detect via touch points.
  const iPadOS = /Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1;
  return iOSDevice || iPadOS;
};

export const InstallButton: FC = () => {
  const [mounted, setMounted] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [iosHelpOpen, setIosHelpOpen] = useState(false);
  const [genericHelpOpen, setGenericHelpOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    setStandalone(isStandalone());

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setDeferredPrompt(null);
      setStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // Render nothing on the server, during hydration, or when already installed.
  if (!mounted || standalone) {
    return null;
  }

  const handleClick = async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      return;
    }
    if (isIos()) {
      setIosHelpOpen(true);
      return;
    }
    setGenericHelpOpen(true);
  };

  return (
    <>
      <Button
        type="primary"
        size="small"
        className={`${styles.installButton} cooeynet-install-button`}
        onClick={handleClick}
      >
        Cooeynet Phone Home
      </Button>

      <Modal
        title="Cooeynet Phone Home"
        open={iosHelpOpen}
        onCancel={() => setIosHelpOpen(false)}
        footer={null}
      >
        <p>Add COOEYNET to your home screen so the signal is always one tap away:</p>
        <ol>
          <li>
            Tap the <strong>Share</strong> icon (the square with an upward arrow) in Safari&apos;s
            toolbar.
          </li>
          <li>
            Scroll down and tap <strong>Add to Home Screen</strong>.
          </li>
          <li>
            Tap <strong>Add</strong>. COOEYNET will phone home from your home screen.
          </li>
        </ol>
      </Modal>

      <Modal
        title="Cooeynet Phone Home"
        open={genericHelpOpen}
        onCancel={() => setGenericHelpOpen(false)}
        footer={null}
      >
        <p>
          To add COOEYNET to your device, open your browser menu and choose <strong>Install</strong>{' '}
          or <strong>Add to Home Screen</strong>.
        </p>
      </Modal>
    </>
  );
};
