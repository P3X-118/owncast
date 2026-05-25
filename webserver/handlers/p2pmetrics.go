package handlers

// SGC fork (experimental, sgc-dev-webtorrent): collection endpoint for
// WebTorrent P2P livestream metrics. Viewers POST periodic samples to
// /api/p2p/report; the admin graphing report reads them from
// /api/admin/p2p/metrics. In-memory ring buffer for now (resets on restart) --
// persistence is a follow-up. See docs/experiments/webtorrent-p2p-hls.md.

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	webutils "github.com/owncast/owncast/webserver/utils"
)

// P2PSample is one viewer's point-in-time P2P playback measurement.
type P2PSample struct {
	Timestamp    time.Time `json:"timestamp"`
	ChunkSeconds int       `json:"chunkSeconds"`
	Peers        int       `json:"peers"`
	P2PBytes     int64     `json:"p2pBytes"`
	OriginBytes  int64     `json:"originBytes"`
	Rebuffers    int       `json:"rebuffers"`
	LatencyMs    int       `json:"latencyMs"`
	ClientID     string    `json:"clientId,omitempty"`
}

const p2pMaxSamples = 5000

var (
	p2pSamples []P2PSample
	p2pMu      sync.Mutex
)

// HandleP2PReport ingests one metrics sample from a viewer (public, unauthed).
func HandleP2PReport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096) // cap payload
	var s P2PSample
	if err := json.NewDecoder(r.Body).Decode(&s); err != nil {
		webutils.WriteSimpleResponse(w, false, "invalid sample")
		return
	}
	s.Timestamp = time.Now()
	// Clamp obviously-bogus values so a hostile client can't skew the report.
	if s.P2PBytes < 0 {
		s.P2PBytes = 0
	}
	if s.OriginBytes < 0 {
		s.OriginBytes = 0
	}
	if s.Peers < 0 {
		s.Peers = 0
	}

	p2pMu.Lock()
	p2pSamples = append(p2pSamples, s)
	if len(p2pSamples) > p2pMaxSamples {
		p2pSamples = p2pSamples[len(p2pSamples)-p2pMaxSamples:]
	}
	p2pMu.Unlock()

	w.WriteHeader(http.StatusNoContent)
}

// GetP2PMetrics returns all collected samples for the admin report (admin-gated
// by the route wrapper).
func GetP2PMetrics(w http.ResponseWriter, r *http.Request) {
	p2pMu.Lock()
	out := make([]P2PSample, len(p2pSamples))
	copy(out, p2pSamples)
	p2pMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(out); err != nil {
		webutils.BadRequestHandler(w, err)
	}
}
