// Package oidc is the HTTP transport for the SGC-fork OIDC chat-auth
// flow. The actual flow logic (state, PKCE, discovery, token exchange,
// id_token verification) lives in auth/oidc; this package only adapts
// those functions to Owncast's chi-server-generated handler signatures
// and persists the resulting identity through the user repository.
package oidc

import (
	"fmt"
	"net/http"

	ao "github.com/owncast/owncast/auth/oidc"
	"github.com/owncast/owncast/core/chat"
	"github.com/owncast/owncast/models"
	"github.com/owncast/owncast/persistence/userrepository"
	webutils "github.com/owncast/owncast/webserver/utils"
	log "github.com/sirupsen/logrus"
)

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

	// Already linked? Switch this access token to the existing user.
	if u := userRepository.GetUserByAuth(authKey, models.OIDC); u != nil {
		log.Debugln("user with this OIDC identity already exists, signing them in")
		if err := userRepository.SetAccessTokenToOwner(request.CurrentAccessToken, u.ID); err != nil {
			webutils.WriteSimpleResponse(w, false, err.Error())
			return
		}
		if request.DisplayName != u.DisplayName {
			loginMessage := fmt.Sprintf("**%s** is now authenticated as **%s**", request.DisplayName, u.DisplayName)
			if err := chat.SendSystemAction(loginMessage, true); err != nil {
				log.Errorln(err)
			}
		}
		http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
		return
	}

	// First link for this identity: save it under the current chat user.
	log.Debugln("OIDC identity is new, linking to current chat user")
	if err := userRepository.AddAuth(request.UserID, authKey, models.OIDC); err != nil {
		webutils.WriteSimpleResponse(w, false, err.Error())
		return
	}
	if err := userRepository.SetUserAsAuthenticated(request.UserID); err != nil {
		log.Errorln(err)
	}

	http.Redirect(w, r, "/", http.StatusTemporaryRedirect)
}
