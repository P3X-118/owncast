package oidc

import (
	"net/url"
	"time"
)

// Request represents a single in-flight OIDC auth request initiated by a
// chat user who wants to link their anonymous Owncast identity to a real
// account at the configured OIDC provider (e.g. Authentik).
//
// Stored in memory keyed by State for the duration of the auth flow.
type Request struct {
	Timestamp          time.Time
	Redirect           *url.URL // Outbound redirect URL to begin the flow at the OIDC provider
	Callback           *url.URL // Inbound URL where the provider sends the user back
	UserID             string
	DisplayName        string
	CurrentAccessToken string
	State              string
	Nonce              string
	CodeVerifier       string
}
