// Package oidc adds OpenID Connect Authorization Code + PKCE chat-user
// authentication to Owncast (SGC fork). It is a sibling of the existing
// auth/indieauth and auth/fediverse packages: a chat user starts the
// flow from the chat UI (the front end calls /api/auth/oidc with their
// access token), is redirected to the configured OIDC provider, signs
// in there, and on return is linked to a stable identity (the verified
// `sub` claim) so subsequent visits recognise them as authenticated.
//
// Configuration is read from environment variables baked into the
// Owncast container by the deploying playbook (see okast-ar):
//
//   OWNCAST_OIDC_ENABLED       "true" to enable
//   OWNCAST_OIDC_ISSUER        the OIDC issuer URL (no trailing slash)
//   OWNCAST_OIDC_CLIENT_ID     client ID registered with the provider
//   OWNCAST_OIDC_CLIENT_SECRET client secret (CONFIDENTIAL client)
//   OWNCAST_OIDC_SCOPES        space-separated; defaults to "openid profile email"
//
// Deriving the client secret from `sgc_pgsk` (and provisioning the same
// value at the Authentik side via a `provision-radio-oidc.py` script)
// keeps secret material out of the DB and the repo.
package oidc

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/rand"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	"unsafe"

	gooidc "github.com/coreos/go-oidc/v3/oidc"
	"github.com/owncast/owncast/persistence/configrepository"
	log "github.com/sirupsen/logrus"
	"golang.org/x/oauth2"
)

const (
	// Path inside the Owncast server that the OIDC provider redirects
	// the user back to after they sign in.
	callbackPath = "/api/auth/oidc/callback"

	// How long a pending request lives before being pruned. The OIDC
	// flow should normally complete in under a minute; ten matches
	// IndieAuth's behaviour.
	registrationTimeout = time.Minute * 10

	// Cap to make brute force / DoS less attractive.
	maxPendingRequests = 1024
)

var (
	pendingAuthRequests = make(map[string]*Request)
	pendingLock         sync.Mutex

	// Cached OIDC provider / verifier / oauth2 config. Re-resolved if
	// the underlying env vars change. Guarded by providerLock.
	providerLock sync.Mutex
	cachedKey    string
	cachedCfg    *providerConfig
)

type providerConfig struct {
	provider     *gooidc.Provider
	verifier     *gooidc.IDTokenVerifier
	oauth2Config *oauth2.Config
	scopes       []string
}

// IdentityClaims is the small subset of OIDC claims Owncast persists or
// shows to the user.
type IdentityClaims struct {
	Subject       string `json:"sub"`
	Issuer        string `json:"iss"`
	Email         string `json:"email,omitempty"`
	EmailVerified bool   `json:"email_verified,omitempty"`
	Name          string `json:"name,omitempty"`
	Picture       string `json:"picture,omitempty"`
}

// IsEnabled reports whether OIDC chat-auth is configured on this server.
// Cheap; used by the frontend bootstrap to decide whether to render the
// "link your account" option in the chat auth modal.
func IsEnabled() bool {
	return strings.EqualFold(os.Getenv("OWNCAST_OIDC_ENABLED"), "true") &&
		os.Getenv("OWNCAST_OIDC_ISSUER") != "" &&
		os.Getenv("OWNCAST_OIDC_CLIENT_ID") != "" &&
		os.Getenv("OWNCAST_OIDC_CLIENT_SECRET") != ""
}

func init() {
	go setupExpiredRequestPruner()
}

func setupExpiredRequestPruner() {
	t := time.NewTicker(registrationTimeout)
	for range t.C {
		pendingLock.Lock()
		log.Debugln("Pruning expired OIDC auth requests.")
		for k, v := range pendingAuthRequests {
			if time.Since(v.Timestamp) > registrationTimeout {
				delete(pendingAuthRequests, k)
			}
		}
		pendingLock.Unlock()
	}
}

// StartAuthFlow generates a Request, stashes it, and returns the URL the
// user should be redirected to in order to begin authentication at the
// configured OIDC provider.
func StartAuthFlow(userID, accessToken, displayName string) (*url.URL, error) {
	if !IsEnabled() {
		return nil, errors.New("OIDC chat-auth is not enabled on this server")
	}

	pendingLock.Lock()
	pending := len(pendingAuthRequests)
	pendingLock.Unlock()
	if pending >= maxPendingRequests {
		return nil, errors.New("please try again later: too many pending auth requests")
	}

	cfg, err := getProvider(context.Background())
	if err != nil {
		return nil, fmt.Errorf("OIDC provider is misconfigured: %w", err)
	}

	serverURL := configrepository.Get().GetServerURL()
	if serverURL == "" {
		return nil, errors.New("Owncast server URL must be set when using auth")
	}
	base, err := url.Parse(serverURL)
	if err != nil {
		return nil, fmt.Errorf("unable to parse Owncast server URL: %w", err)
	}
	callback := *base
	callback.Path = callbackPath

	codeVerifier := randString(64)
	codeChallenge := pkceS256(codeVerifier)
	state := randString(32)
	nonce := randString(32)

	// Build the authorize URL with a fresh oauth2.Config that has the
	// correct RedirectURL filled in (we cache the rest).
	o2 := *cfg.oauth2Config
	o2.RedirectURL = callback.String()
	authURL := o2.AuthCodeURL(
		state,
		oauth2.SetAuthURLParam("code_challenge", codeChallenge),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"),
		oauth2.SetAuthURLParam("nonce", nonce),
	)
	redirect, err := url.Parse(authURL)
	if err != nil {
		return nil, fmt.Errorf("unable to parse generated authorize URL: %w", err)
	}

	pendingLock.Lock()
	pendingAuthRequests[state] = &Request{
		Timestamp:          time.Now(),
		Redirect:           redirect,
		Callback:           &callback,
		UserID:             userID,
		DisplayName:        displayName,
		CurrentAccessToken: accessToken,
		State:              state,
		Nonce:              nonce,
		CodeVerifier:       codeVerifier,
	}
	pendingLock.Unlock()

	return redirect, nil
}

// HandleCallback completes a flow started by StartAuthFlow: it exchanges
// the code, validates the returned ID token (signature, issuer, audience,
// expiry, nonce), and returns the original Request together with the
// verified identity claims so the caller can persist the link.
func HandleCallback(ctx context.Context, state, code string) (*Request, *IdentityClaims, error) {
	if state == "" || code == "" {
		return nil, nil, errors.New("missing state or code in OIDC callback")
	}

	pendingLock.Lock()
	req, exists := pendingAuthRequests[state]
	if exists {
		delete(pendingAuthRequests, state)
	}
	pendingLock.Unlock()
	if !exists {
		return nil, nil, errors.New("no pending OIDC auth request matches the returned state")
	}

	cfg, err := getProvider(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("OIDC provider unavailable for token exchange: %w", err)
	}

	o2 := *cfg.oauth2Config
	o2.RedirectURL = req.Callback.String()

	token, err := o2.Exchange(
		ctx, code,
		oauth2.SetAuthURLParam("code_verifier", req.CodeVerifier),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("OIDC token exchange failed: %w", err)
	}

	rawIDToken, ok := token.Extra("id_token").(string)
	if !ok || rawIDToken == "" {
		return nil, nil, errors.New("OIDC token response did not include id_token")
	}

	idToken, err := cfg.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return nil, nil, fmt.Errorf("OIDC id_token verification failed: %w", err)
	}
	if idToken.Nonce != req.Nonce {
		return nil, nil, errors.New("OIDC id_token nonce mismatch")
	}

	var claims IdentityClaims
	if err := idToken.Claims(&claims); err != nil {
		return nil, nil, fmt.Errorf("unable to decode OIDC id_token claims: %w", err)
	}
	if claims.Subject == "" {
		return nil, nil, errors.New("OIDC id_token has no `sub` claim")
	}
	claims.Issuer = idToken.Issuer

	return req, &claims, nil
}

// getProvider returns a cached *providerConfig, re-resolving discovery
// if the controlling env vars have changed.
func getProvider(ctx context.Context) (*providerConfig, error) {
	issuer := os.Getenv("OWNCAST_OIDC_ISSUER")
	clientID := os.Getenv("OWNCAST_OIDC_CLIENT_ID")
	clientSecret := os.Getenv("OWNCAST_OIDC_CLIENT_SECRET")
	if issuer == "" || clientID == "" || clientSecret == "" {
		return nil, errors.New("OIDC env vars not set (OWNCAST_OIDC_ISSUER/CLIENT_ID/CLIENT_SECRET)")
	}

	scopes := []string{"openid", "profile", "email"}
	if s := os.Getenv("OWNCAST_OIDC_SCOPES"); s != "" {
		scopes = strings.Fields(s)
	}

	key := issuer + "|" + clientID + "|" + strings.Join(scopes, " ")

	providerLock.Lock()
	defer providerLock.Unlock()
	if cachedCfg != nil && cachedKey == key {
		return cachedCfg, nil
	}

	// Discover, with a bounded timeout independent of caller's ctx.
	disCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	provider, err := gooidc.NewProvider(disCtx, issuer)
	if err != nil {
		return nil, fmt.Errorf("OIDC discovery at %s failed: %w", issuer, err)
	}

	cachedKey = key
	cachedCfg = &providerConfig{
		provider: provider,
		verifier: provider.Verifier(&gooidc.Config{ClientID: clientID}),
		oauth2Config: &oauth2.Config{
			ClientID:     clientID,
			ClientSecret: clientSecret,
			Endpoint:     provider.Endpoint(),
			Scopes:       scopes,
		},
		scopes: scopes,
	}
	return cachedCfg, nil
}

// pkceS256 derives a PKCE code_challenge from the given verifier as
// base64url(SHA256(verifier)) with `=` padding stripped, per RFC 7636.
func pkceS256(codeVerifier string) string {
	sum := sha256.Sum256([]byte(codeVerifier))
	return strings.TrimRight(base64.URLEncoding.EncodeToString(sum[:]), "=")
}

// randString returns a base62-ish random string of length n suitable for
// state and PKCE verifiers. Reuses the math/rand approach IndieAuth uses
// for consistency; sufficient given that PKCE+state+nonce are all
// independently checked and the values are short-lived.
func randString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	const idxBits = 6
	const idxMask = 1<<idxBits - 1
	const idxMax = 63 / idxBits

	b := make([]byte, n)
	for i, cache, remain := n-1, rand.Int63(), idxMax; i >= 0; {
		if remain == 0 {
			cache, remain = rand.Int63(), idxMax
		}
		if idx := int(cache & idxMask); idx < len(letters) {
			b[i] = letters[idx]
			i--
		}
		cache >>= idxBits
		remain--
	}
	return *(*string)(unsafe.Pointer(&b)) //nolint:gosec
}
