import { Tabs } from 'antd';
import { useRecoilValue } from 'recoil';
import { FC } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { IndieAuthModal } from '../IndieAuthModal/IndieAuthModal';
import { FediAuthModal } from '../FediAuthModal/FediAuthModal';
import { OIDCAuthModal } from '../OIDCAuthModal/OIDCAuthModal';

import styles from './AuthModal.module.scss';
import {
  currentUserAtom,
  chatAuthenticatedAtom,
  accessTokenAtom,
} from '../../stores/ClientConfigStore';
import { ComponentError } from '../../ui/ComponentError/ComponentError';

export type AuthModalProps = {
  // Retained for backwards compatibility; the tab bar is now always
  // visible because the SGC fork adds a third (SSO) tab.
  forceTabs?: boolean;
};

export const AuthModal: FC<AuthModalProps> = () => {
  const authenticated = useRecoilValue<boolean>(chatAuthenticatedAtom);
  const accessToken = useRecoilValue<string>(accessTokenAtom);
  const currentUser = useRecoilValue(currentUserAtom);

  if (!currentUser) {
    return null;
  }
  const { displayName } = currentUser;

  const indieAuthTabTitle = (
    <span className={styles.tabContent}>
      <img className={styles.icon} src="/img/indieauth.png" alt="IndieAuth" />
      IndieAuth
    </span>
  );

  const indieAuthTab = (
    <IndieAuthModal
      authenticated={authenticated}
      displayName={displayName}
      accessToken={accessToken}
    />
  );

  const fediAuthTabTitle = (
    <span className={styles.tabContent}>
      <img className={styles.icon} src="/img/fediverse-black.png" alt="Fediverse auth" />
      FediAuth
    </span>
  );

  const fediAuthTab = (
    <FediAuthModal
      authenticated={authenticated}
      displayName={displayName}
      accessToken={accessToken}
    />
  );

  // SGC fork: SSO/OIDC tab. Renders unconditionally; if the server has
  // not configured OIDC, the click surfaces the "not enabled" error
  // (symmetric with how IndieAuth/Fediverse surface their own errors).
  const oidcAuthTabTitle = (
    <span className={styles.tabContent}>
      <img className={styles.icon} src="/img/owncast-logo.svg" alt="SSO" />
      SSO
    </span>
  );

  const oidcAuthTab = (
    <OIDCAuthModal
      authenticated={authenticated}
      displayName={displayName}
      accessToken={accessToken}
    />
  );

  const items = [
    { label: indieAuthTabTitle, key: '1', children: indieAuthTab },
    { label: fediAuthTabTitle, key: '2', children: fediAuthTab },
    { label: oidcAuthTabTitle, key: '3', children: oidcAuthTab },
  ];

  return (
    <ErrorBoundary
      // eslint-disable-next-line react/no-unstable-nested-components
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ComponentError
          componentName="AuthModal"
          message={error.message}
          retryFunction={resetErrorBoundary}
        />
      )}
    >
      <div>
        <Tabs defaultActiveKey="1" items={items} type="card" size="small" />
      </div>
    </ErrorBoundary>
  );
};
