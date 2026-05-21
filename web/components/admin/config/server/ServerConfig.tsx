import React from 'react';
import EditInstanceDetails from '../../EditInstanceDetails2';

// eslint-disable-next-line react/function-component-definition
export default function ConfigServerDetails() {
  return (
    <div className="config-server-details-form">
      <p className="description">
        Admin authentication is gated by the SGC Authentik SSO. Reset the password you log in with
        from your Authentik account settings. For most people it&apos;s likely the other settings on
        this page will not need to be changed.
      </p>
      <div className="form-module config-server-details-container">
        <EditInstanceDetails />
      </div>
    </div>
  );
}
