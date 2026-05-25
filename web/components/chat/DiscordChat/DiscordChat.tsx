import { FC } from 'react';
import { useRecoilValue } from 'recoil';
import { clientConfigStateAtom } from '../../stores/ClientConfigStore';
import { ClientConfig } from '../../../interfaces/client-config.model';
import styles from './DiscordChat.module.scss';

// SGC fork: embed a Discord channel as an alternate chat source via WidgetBot
// (https://widgetbot.io). The WidgetBot bot must be invited to the Discord
// server, and the server + channel IDs are provided by the SERVER at runtime
// via /api/config (sourced from the OWNCAST_DISCORD_WIDGETBOT_SERVER /
// OWNCAST_DISCORD_WIDGETBOT_CHANNEL env vars on the container). Runtime config
// means the IDs can be changed with a restart -- no web rebuild required.
//
// When either is unset the Discord chat option is hidden entirely (see
// useDiscordChatConfig + ChatWithSource) and the viewer only sees local chat.

// useDiscordChatConfig reads the WidgetBot server/channel from the live
// client config and reports whether the Discord option should be offered.
export const useDiscordChatConfig = (): {
  server: string;
  channel: string;
  configured: boolean;
} => {
  const config = useRecoilValue<ClientConfig>(clientConfigStateAtom);
  const server = config?.discordChat?.server || '';
  const channel = config?.discordChat?.channel || '';
  return { server, channel, configured: Boolean(server && channel) };
};

export const DiscordChat: FC = () => {
  const { server, channel, configured } = useDiscordChatConfig();

  if (!configured) {
    return (
      <div className={styles.placeholder}>
        <p>Discord chat is not configured.</p>
      </div>
    );
  }

  const src = `https://e.widgetbot.io/channels/${server}/${channel}`;
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
