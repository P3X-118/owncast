import { FC, useEffect, useState } from 'react';
import { ChatContainer, ChatContainerProps } from '../ChatContainer/ChatContainer';
import { DiscordChat, isDiscordChatConfigured } from '../DiscordChat/DiscordChat';
import { getLocalStorage, setLocalStorage } from '../../../utils/localStorage';
import styles from './ChatWithSource.module.scss';

// SGC fork: let each viewer switch their chat panel between the native local
// chat and an embedded Discord channel. The choice is per-viewer and
// remembered in localStorage. When Discord isn't configured (no WidgetBot
// server/channel at build time) this renders the local chat unchanged.
//
// The local ChatContainer is always kept mounted so its websocket/state
// persists across toggles; the Discord embed is layered on top when selected.

const SOURCE_KEY = 'cooeynet_chat_source';
type Source = 'local' | 'discord';

export const ChatWithSource: FC<ChatContainerProps> = props => {
  const discordAvailable = isDiscordChatConfigured();
  const [source, setSource] = useState<Source>('local');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (discordAvailable && getLocalStorage(SOURCE_KEY) === 'discord') {
      setSource('discord');
    }
  }, [discordAvailable]);

  const choose = (next: Source) => {
    setSource(next);
    setLocalStorage(SOURCE_KEY, next);
  };

  // No Discord configured -> behave exactly like the stock chat.
  if (!discordAvailable) {
    return <ChatContainer {...props} />;
  }

  const showDiscord = mounted && source === 'discord';

  return (
    <div className={styles.wrap}>
      <div className={styles.toggle} role="tablist" aria-label="Chat source">
        <button
          type="button"
          role="tab"
          aria-selected={source === 'local'}
          className={source === 'local' ? styles.active : undefined}
          onClick={() => choose('local')}
        >
          Chat
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={source === 'discord'}
          className={source === 'discord' ? styles.active : undefined}
          onClick={() => choose('discord')}
        >
          Discord
        </button>
      </div>

      <ChatContainer {...props} />

      {showDiscord && (
        <div className={styles.discordOverlay}>
          <DiscordChat />
        </div>
      )}
    </div>
  );
};
