import React, { useState, useContext, useEffect } from 'react';
import { Alert, Collapse, Typography } from 'antd';
import { TEXTFIELD_TYPE_NUMBER, TEXTFIELD_TYPE_URL } from './TextField';
import { TextFieldWithSubmit } from './TextFieldWithSubmit';
import { ServerStatusContext } from '../../utils/server-status-context';
import { AlertMessageContext } from '../../utils/alert-message-context';
import {
  TEXTFIELD_PROPS_FFMPEG,
  TEXTFIELD_PROPS_RTMP_PORT,
  TEXTFIELD_PROPS_SOCKET_HOST_OVERRIDE,
  TEXTFIELD_PROPS_WEB_PORT,
  TEXTFIELD_PROPS_VIDEO_SERVING_ENDPOINT,
} from '../../utils/config-constants';
import { UpdateArgs } from '../../types/config-section';
import { ResetYP } from './ResetYP';

const { Panel } = Collapse;

// SGC fork: the admin is fronted by Authentik forward-auth, so the
// `--adminpassword` value is set by the role (derived from sgc_pgsk) and
// must not be changed from inside Owncast or the SSO Basic-injection
// would break. Users reset their LOGIN via Authentik instead.
//
// Override at build time via NEXT_PUBLIC_EXTERNAL_AUTH_PASSWORD_RESET_URL
// for different deployments.
const EXTERNAL_AUTH_PASSWORD_RESET_URL =
  process.env.NEXT_PUBLIC_EXTERNAL_AUTH_PASSWORD_RESET_URL ||
  'https://auth.bskypds.pro/if/user/#/settings;%7B%22page%22%3A%22page-settings%22%7D';

// eslint-disable-next-line react/function-component-definition
export default function EditInstanceDetails() {
  const [formDataValues, setFormDataValues] = useState(null);
  const serverStatusData = useContext(ServerStatusContext);
  const { setMessage } = useContext(AlertMessageContext);

  const { serverConfig } = serverStatusData || {};

  const {
    ffmpegPath,
    rtmpServerPort,
    webServerPort,
    yp,
    socketHostOverride,
    videoServingEndpoint,
  } = serverConfig;

  useEffect(() => {
    setFormDataValues({
      ffmpegPath,
      rtmpServerPort,
      webServerPort,
      socketHostOverride,
      videoServingEndpoint,
    });
  }, [serverConfig]);

  if (!formDataValues) {
    return null;
  }

  const handleFieldChange = ({ fieldName, value }: UpdateArgs) => {
    setFormDataValues({
      ...formDataValues,
      [fieldName]: value,
    });
  };

  const showConfigurationRestartMessage = () => {
    setMessage('Updating server settings requires a restart of your Owncast server.');
  };

  const showFfmpegChangeMessage = () => {
    if (serverStatusData.online) {
      setMessage('The updated ffmpeg path will be used when starting your next live stream.');
    }
  };

  return (
    <div className="edit-server-details-container">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Admin login is managed by Authentik"
        description={
          <>
            Admin authentication for this Owncast instance is gated by the SGC Authentik SSO; the
            in-app admin password is set automatically by the deployment and cannot be changed from
            here. To reset the password you log in with, update it in your Authentik account
            settings.{' '}
            <a href={EXTERNAL_AUTH_PASSWORD_RESET_URL} target="_blank" rel="noopener noreferrer">
              Open Authentik settings →
            </a>
          </>
        }
      />
      <TextFieldWithSubmit
        fieldName="ffmpegPath"
        {...TEXTFIELD_PROPS_FFMPEG}
        value={formDataValues.ffmpegPath}
        initialValue={ffmpegPath}
        onChange={handleFieldChange}
        onSubmit={showFfmpegChangeMessage}
      />
      <TextFieldWithSubmit
        fieldName="webServerPort"
        {...TEXTFIELD_PROPS_WEB_PORT}
        value={formDataValues.webServerPort}
        initialValue={webServerPort}
        type={TEXTFIELD_TYPE_NUMBER}
        onChange={handleFieldChange}
        onSubmit={showConfigurationRestartMessage}
      />
      <TextFieldWithSubmit
        fieldName="rtmpServerPort"
        {...TEXTFIELD_PROPS_RTMP_PORT}
        value={formDataValues.rtmpServerPort}
        initialValue={rtmpServerPort}
        type={TEXTFIELD_TYPE_NUMBER}
        onChange={handleFieldChange}
        onSubmit={showConfigurationRestartMessage}
      />
      <Collapse className="advanced-settings">
        <Panel header="Advanced Settings" key="1">
          <Typography.Paragraph>
            If you have a CDN in front of your entire Owncast instance, specify your origin server
            here for the websocket to connect to. Most people will never need to set this.
          </Typography.Paragraph>
          <TextFieldWithSubmit
            fieldName="socketHostOverride"
            {...TEXTFIELD_PROPS_SOCKET_HOST_OVERRIDE}
            value={formDataValues.socketHostOverride}
            initialValue={socketHostOverride || ''}
            type={TEXTFIELD_TYPE_URL}
            onChange={handleFieldChange}
          />

          <TextFieldWithSubmit
            fieldName="videoServingEndpoint"
            {...TEXTFIELD_PROPS_VIDEO_SERVING_ENDPOINT}
            value={formDataValues.videoServingEndpoint}
            initialValue={videoServingEndpoint || ''}
            type={TEXTFIELD_TYPE_URL}
            onChange={handleFieldChange}
          />
          {yp.enabled && <ResetYP />}
        </Panel>
      </Collapse>
    </div>
  );
}
