import { FC } from 'react';
import styles from './DiscordChat.module.scss';

// SGC fork: embed a Discord channel as an alternate chat source via WidgetBot
// (https://widgetbot.io). The WidgetBot bot must be invited to the Discord
// server, and the server + channel IDs are provided at build time:
//
//   NEXT_PUBLIC_DISCORD_WIDGETBOT_SERVER  = Discord server (guild) ID
//   NEXT_PUBLIC_DISCORD_WIDGETBOT_CHANNEL = channel ID to show
//
// When unset, the Discord chat option is hidden entirely (see
// isDiscordChatConfigured) and the viewer only sees the native local chat.
const SERVER = process.env.NEXT_PUBLIC_DISCORD_WIDGETBOT_SERVER || '';
const CHANNEL = process.env.NEXT_PUBLIC_DISCORD_WIDGETBOT_CHANNEL || '';

export const isDiscordChatConfigured = (): boolean => Boolean(SERVER && CHANNEL);

export const DiscordChat: FC = () => {
  if (!isDiscordChatConfigured()) {
    return (
      <div className={styles.placeholder}>
        <p>Discord chat is not configured.</p>
      </div>
    );
  }

  const src = `https://e.widgetbot.io/channels/${SERVER}/${CHANNEL}`;
  return (
    <div className={styles.discordChat}>
      <iframe
        title="Discord chat"
        src={src}
        className={styles.frame}
        allow="clipboard-write; clipboard-read; fullscreen"
      />
    </div>
  );
};
