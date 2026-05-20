package oidc

import (
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
)

func TestIsEnabledRequiresAllVars(t *testing.T) {
	// t.Setenv auto-restores prior values after the test.
	t.Setenv("OWNCAST_OIDC_ENABLED", "")
	t.Setenv("OWNCAST_OIDC_ISSUER", "")
	t.Setenv("OWNCAST_OIDC_CLIENT_ID", "")
	t.Setenv("OWNCAST_OIDC_CLIENT_SECRET", "")

	if IsEnabled() {
		t.Fatalf("IsEnabled() expected false when no env vars are set")
	}

	t.Setenv("OWNCAST_OIDC_ENABLED", "false")
	t.Setenv("OWNCAST_OIDC_ISSUER", "https://example.test/")
	t.Setenv("OWNCAST_OIDC_CLIENT_ID", "id")
	t.Setenv("OWNCAST_OIDC_CLIENT_SECRET", "secret")
	if IsEnabled() {
		t.Fatalf("IsEnabled() expected false when OWNCAST_OIDC_ENABLED is not true")
	}

	t.Setenv("OWNCAST_OIDC_ENABLED", "true")
	if !IsEnabled() {
		t.Fatalf("IsEnabled() expected true with all env vars set and ENABLED=true")
	}

	t.Setenv("OWNCAST_OIDC_ISSUER", "")
	if IsEnabled() {
		t.Fatalf("IsEnabled() expected false when issuer is empty")
	}
}

func TestPKCEDeterministicS256(t *testing.T) {
	v := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"

	got := pkceS256(v)

	// Recompute the expected base64url(sha256(v)) without padding, as a
	// black-box check independent of the implementation under test.
	sum := sha256.Sum256([]byte(v))
	want := strings.TrimRight(base64.URLEncoding.EncodeToString(sum[:]), "=")

	if got != want {
		t.Fatalf("pkceS256 mismatch:\n got=%q\nwant=%q", got, want)
	}
	if strings.Contains(got, "=") {
		t.Fatalf("pkceS256 must strip `=` padding; got %q", got)
	}
	// S256 of any input must be 43 chars after stripping padding.
	if len(got) != 43 {
		t.Fatalf("pkceS256 length=%d, want 43 (raw base64url of 32 bytes)", len(got))
	}
}

func TestRandStringLengthAndCharset(t *testing.T) {
	const n = 64
	s := randString(n)
	if len(s) != n {
		t.Fatalf("randString(%d) returned length %d", n, len(s))
	}
	for i, c := range s {
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
		if !ok {
			t.Fatalf("randString produced non-alnum char %q at index %d in %q", c, i, s)
		}
	}
}

func TestRandStringDiffersBetweenCalls(t *testing.T) {
	// Probabilistic but with n=32 from a 62-char alphabet the collision
	// probability is negligible (~62^-32). If this ever flakes, the RNG
	// is the real story.
	a := randString(32)
	b := randString(32)
	if a == b {
		t.Fatalf("randString returned identical strings twice: %q", a)
	}
}

