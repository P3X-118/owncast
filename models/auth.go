package models

// Type represents a form of authentication.
type AuthType string

// The different auth types we support.
const (
	// IndieAuth https://indieauth.spec.indieweb.org/.
	IndieAuth AuthType = "indieauth"
	Fediverse AuthType = "fediverse"
	// OIDC is the SGC-fork chat-auth provider that links an anonymous
	// chat user to a verified identity at an OpenID Connect provider
	// (e.g. Authentik). The stored auth_token is "<issuer>|<sub>".
	OIDC AuthType = "oidc"
)
