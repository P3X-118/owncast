// SGC fork: SSO/OIDC chat-auth modal. Mirrors IndieAuthModal in shape
// and behaviour but the flow is single-button (no host to enter): we
// POST to /api/auth/oidc with the user's access token, and follow the
// `redirect` URL the server returns (which points at the configured
// OIDC provider's authorize endpoint, e.g. Authentik).
import { Alert, Button, Space, Spin, Collapse, Typography } from 'antd';
import dynamic from 'next/dynamic';
import React, { FC, useState } from 'react';

const { Panel } = Collapse;
const { Link } = Typography;

const LoginOutlined = dynamic(() => import('@ant-design/icons/LoginOutlined'), {
  ssr: false,
});

// Optional label override so the SGC fork can show e.g. "Sign in with
// Authentik" without hardcoding the provider name in tracked source.
// Set NEXT_PUBLIC_OIDC_PROVIDER_LABEL at build time to override.
const PROVIDER_LABEL =
  process.env.NEXT_PUBLIC_OIDC_PROVIDER_LABEL || 'your account';

export type OIDCAuthModalProps = {
  authenticated: boolean;
  displayName: string;
  accessToken: string;
};

export const OIDCAuthModal: FC<OIDCAuthModalProps> = ({
  authenticated,
  displayName: username,
  accessToken,
}) => {
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const message = !authenticated ? (
    <span>
      Link <span>{username}</span> to {PROVIDER_LABEL} so other chats recognise you across
      sessions and devices. You&apos;ll be redirected to sign in.
    </span>
  ) : (
    <span>
      <b>You are already authenticated</b>. You can still link this chat user to{' '}
      {PROVIDER_LABEL} or sign in as an existing one.
    </span>
  );

  const submitButtonPressed = async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const url = `/api/auth/oidc?accessToken=${accessToken}`;
      const rawResponse = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
      });

      const content = await rawResponse.json();
      if (content.message && !content.redirect) {
        setErrorMessage(content.message);
        setLoading(false);
        return;
      }
      if (!content.redirect) {
        setErrorMessage('Auth provider did not return a redirect URL.');
        setLoading(false);
        return;
      }

      window.location = content.redirect;
    } catch (e) {
      setErrorMessage((e as Error).message);
      setLoading(false);
    }
  };

  return (
    <Spin spinning={loading}>
      <Space direction="vertical">
        {message}
        {errorMessage && (
          <Alert message="Error" description={errorMessage} type="error" showIcon />
        )}
        <Button type="primary" icon={<LoginOutlined />} onClick={submitButtonPressed}>
          Sign in with {PROVIDER_LABEL}
        </Button>

        <Collapse ghost>
          <Panel key="header" header={`Learn more about signing in with ${PROVIDER_LABEL}.`}>
            <p>
              OpenID Connect lets you link this chat user to a verified account at the
              identity provider this Owncast server trusts. After signing in there, you&apos;ll
              be brought back here as the same chat user across browsers and devices.
            </p>
            <p>
              <Link href="https://openid.net/connect/">Learn more about OpenID Connect</Link>.
            </p>
          </Panel>
        </Collapse>
        <div>
          <strong>Note</strong>: Only the stable subject identifier from the provider is
          stored. Email, name and other claims are not persisted.
        </div>
      </Space>
    </Spin>
  );
};
