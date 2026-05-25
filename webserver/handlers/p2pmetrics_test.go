package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestP2PReportAndMetrics(t *testing.T) {
	// reset store for a deterministic test
	p2pMu.Lock()
	p2pSamples = nil
	p2pMu.Unlock()

	// wrong method -> 405
	rec := httptest.NewRecorder()
	HandleP2PReport(rec, httptest.NewRequest(http.MethodGet, "/api/p2p/report", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET report: want 405, got %d", rec.Code)
	}

	// valid POST -> 204 and stored (negative values clamped)
	body := `{"chunkSeconds":20,"peers":3,"p2pBytes":900000,"originBytes":-5,"clientId":"t"}`
	rec = httptest.NewRecorder()
	HandleP2PReport(rec, httptest.NewRequest(http.MethodPost, "/api/p2p/report", strings.NewReader(body)))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("POST report: want 204, got %d", rec.Code)
	}

	// GET metrics -> the sample comes back, originBytes clamped to 0
	rec = httptest.NewRecorder()
	GetP2PMetrics(rec, httptest.NewRequest(http.MethodGet, "/api/admin/p2p/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET metrics: want 200, got %d", rec.Code)
	}
	var out []P2PSample
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatalf("decode metrics: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("want 1 sample, got %d", len(out))
	}
	if out[0].P2PBytes != 900000 || out[0].OriginBytes != 0 || out[0].Peers != 3 || out[0].ChunkSeconds != 20 {
		t.Fatalf("unexpected sample: %+v", out[0])
	}
	if out[0].Timestamp.IsZero() {
		t.Fatalf("timestamp not set server-side")
	}
}
