import { useRecoilValue } from 'recoil';
import { FC } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { OIDCAuthModal } from '../OIDCAuthModal/OIDCAuthModal';

import {
  currentUserAtom,
  chatAuthenticatedAtom,
  accessTokenAtom,
} from '../../stores/ClientConfigStore';
import { ComponentError } from '../../ui/ComponentError/ComponentError';

export type AuthModalProps = {
  // Retained for backwards compatibility with callers; unused now that the
  // SGC fork offers a single SSO (OIDC) login and no tab bar.
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

  // SGC fork: the only supported login is Authentik SSO (OIDC). IndieAuth
  // and Fediverse logins are intentionally not offered.
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
        <OIDCAuthModal
          authenticated={authenticated}
          displayName={displayName}
          accessToken={accessToken}
        />
      </div>
    </ErrorBoundary>
  );
};
