// Package oidc is the HTTP transport for the SGC-fork OIDC chat-auth
// flow. The actual flow logic (state, PKCE, discovery, token exchange,
// id_token verification) lives in auth/oidc; this package only adapts
// those functions to Owncast's chi-server-generated handler signatures
// and persists the resulting identity through the user repository.
package oidc

import (
	"fmt"
	"net/http"
	"strings"

	ao "github.com/owncast/owncast/auth/oidc"
	"github.com/owncast/owncast/config"
	"github.com/owncast/owncast/models"
	"github.com/owncast/owncast/persistence/userrepository"
	"github.com/owncast/owncast/utils"
	webutils "github.com/owncast/owncast/webserver/utils"
	log "github.com/sirupsen/logrus"
)

// applyAuthentikDisplayName renames the chat user to their verified
// Authentik display name. If that name is empty/blocked it keeps the
// current name; if it is already taken by another chat user it appends a
// generated "hacker name" (the same word list Owncast uses for anonymous
// users) and tries once more. Best-effort: never fails the auth flow.
func applyAuthentikDisplayName(repo userrepository.UserRepository, userID, currentName, desiredName string) {
	desired := utils.MakeSafeStringOfLength(strings.TrimSpace(desiredName), config.MaxChatDisplayNameLength)
	if desired == "" || desired == currentName {
		return
	}

	if available, err := repo.IsDisplayNameAvailable(desired); err == nil && available {
		if err := repo.ChangeUsername(userID, desired); err != nil {
			log.Errorln("oidc: unable to set display name:", err)
		}
		return
	}

	// Taken (or lookup failed): append a hacker name and retry once.
	suffixed := utils.MakeSafeStringOfLength(
		strings.TrimSpace(desiredName)+" "+utils.GeneratePhrase(),
		config.MaxChatDisplayNameLength,
	)
	if suffixed == "" || suffixed == currentName {
		return
	}
	if available, err := repo.IsDisplayNameAvailable(suffixed); err == nil && available {
		if err := repo.ChangeUsername(userID, suffixed); err != nil {
			log.Errorln("oidc: unable to set suffixed display name:", err)
		}
	}
}

// StartAuthFlow begins the OIDC flow for the calling chat user. The
// outer dispatcher (webserver/handlers/auth.go) wraps this in the user
// access-token middleware so `u` is always valid here.
func StartAuthFlow(u models.User, w http.ResponseWriter, r *http.Request) {
	if !ao.IsEnabled() {
		// 503 mirrors what the OpenAPI says for "not configured".
		webutils.WriteSimpleResponse(w, false, "OIDC chat-auth is not enabled on this server")
		return
	}

	accessToken := r.URL.Query().Get("accessToken")

	redirect, err := ao.StartAuthFlow(u.ID, accessToken, u.DisplayName)
	if err != nil {
		log.Debugln("OIDC start error:", err)
		webutils.WriteSimpleResponse(w, false, err.Error())
		return
	}

	type response struct {
		Redirect string `json:"redirect"`
	}
	webutils.WriteResponse(w, response{Redirect: redirect.String()})
}

// HandleLogout returns the OIDC provider's end-session URL so the front
// end can navigate the browser there and end the user's SSO session at
// the provider. The outer dispatcher wraps this in the user access-token
// middleware, so only a real chat user can request a logout URL. The
// front end clears the local chat access token alongside this so the user
// returns as a fresh anonymous identity.
func HandleLogout(u models.User, w http.ResponseWriter, r *http.Request) {
	if !ao.IsEnabled() {
		webutils.WriteSimpleResponse(w, false, "OIDC chat-auth is not enabled on this server")
		return
	}

	accessToken := r.URL.Query().Get("accessToken")

	redirect, err := ao.LogoutURL(accessToken)
	if err != nil {
		log.Debugln("OIDC logout error:", err)
		webutils.WriteSimpleResponse(w, false, err.Error())
		return
	}

	type response struct {
		Redirect string `json:"redirect"`
	}
	webutils.WriteResponse(w, response{Redirect: redirect.String()})
}

// HandleRedirect completes a flow started by StartAuthFlow. The OIDC
// provider sends the user back here with `state` and `code` (or `error`)
// in the query string. On success we link the verified identity to the
// in-progress chat user and bounce them back to the public viewer page.
func HandleRedirect(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	if errParam := q.Get("error"); errParam != "" {
		log.Debugln("OIDC callback returned error:", errParam, q.Get("error_description"))
		msg := `Authentication was cancelled or denied. <a href="/">Go back.</a><hr/>`
		_ = webutils.WriteString(w, msg, http.StatusBadRequest)
		return
	}

	state := q.Get("state")
	code := q.Get("code")
	request, claims, err := ao.HandleCallback(r.Context(), state, code)
	if err != nil {
		log.Debugln("OIDC callback error:", err)
		msg := `Unable to complete authentication. <a href="/">Go back.</a><hr/>`
		_ = webutils.WriteString(w, msg, http.StatusBadRequest)
		return
	}

	// Store the verified identity as "<issuer>|<sub>" so the same `sub`
	// value at a different IdP can never collide with this one.
	authKey := fmt.Sprintf("%s|%s", claims.Issuer, claims.Subject)
	userRepository := userrepository.Get()

	// Already linked? Switch this access token to the existing user, then
	// sync their chat display name to the current Authentik name.
	if u := userRepository.GetUserByAuth(authKey, models.OIDC); u != nil {
		log.Debugln("user with this OIDC identity already exists, signing them in")
		if err := userRepository.SetAccessTokenToOwner(request.CurrentAccessToken, u.ID); err != nil {
			webutils.WriteSimpleResponse(w, false, err.Error())
			return
		}
		applyAuthentikDisplayName(userRepository, u.ID, u.DisplayName, claims.Name)
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
		return
	}

	// First link for this identity: save it under the current chat user
	// and set their display name to the Authentik name.
	log.Debugln("OIDC identity is new, linking to current chat user")
	if err := userRepository.AddAuth(request.UserID, authKey, models.OIDC); err != nil {
		webutils.WriteSimpleResponse(w, false, err.Error())
		return
	}
	if err := userRepository.SetUserAsAuthenticated(request.UserID); err != nil {
		log.Errorln(err)
	}
	applyAuthentikDisplayName(userRepository, request.UserID, request.DisplayName, claims.Name)

	http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
}
