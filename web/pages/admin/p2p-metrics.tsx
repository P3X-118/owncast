import React, { useState, useEffect, ReactElement } from 'react';
import { Row, Col, Typography, Spin, Alert } from 'antd';
import { Chart } from '../../components/admin/Chart';
import { StatisticItem } from '../../components/admin/StatisticItem';
import { AdminLayout } from '../../components/layouts/AdminLayout';
import { P2P_METRICS, fetchData } from '../../utils/apis';

const { Title } = Typography;
const FETCH_INTERVAL = 30 * 1000;

// SGC fork (experimental): admin report for the WebTorrent P2P livestream.
// Reads viewer-submitted samples from /api/admin/p2p/metrics and graphs how much
// traffic is served peer-to-peer vs from the origin, to tune chunk size.
// See docs/experiments/webtorrent-p2p-hls.md.

interface Sample {
  timestamp: string;
  chunkSeconds: number;
  peers: number;
  p2pBytes: number;
  originBytes: number;
  rebuffers: number;
  latencyMs: number;
}

interface Bucket {
  time: Date;
  p2p: number;
  origin: number;
  peers: number;
  n: number;
}

const fmtBytes = (n: number) => {
  if (n > 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e3).toFixed(0)} kB`;
};

export default function P2PMetrics() {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>(null);

  const load = async () => {
    try {
      const data = await fetchData(P2P_METRICS);
      setSamples(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e) {
      setError(e?.message || 'Failed to load P2P metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, FETCH_INTERVAL);
    return () => clearInterval(id);
  }, []);

  const totalP2P = samples.reduce((n, s) => n + (s.p2pBytes || 0), 0);
  const totalOrigin = samples.reduce((n, s) => n + (s.originBytes || 0), 0);
  const offloadPct =
    totalP2P + totalOrigin ? Math.round((totalP2P / (totalP2P + totalOrigin)) * 100) : 0;
  const chunkSeconds = samples.length ? samples[samples.length - 1].chunkSeconds : 0;

  // Aggregate per-minute across all reporting viewers.
  const buckets = new Map<number, Bucket>();
  samples.forEach(s => {
    const t = new Date(s.timestamp);
    t.setSeconds(0, 0);
    const key = t.getTime();
    const b = buckets.get(key) || { time: t, p2p: 0, origin: 0, peers: 0, n: 0 };
    b.p2p += s.p2pBytes || 0;
    b.origin += s.originBytes || 0;
    b.peers += s.peers || 0;
    b.n += 1;
    buckets.set(key, b);
  });
  const ordered = Array.from(buckets.values()).sort((a, b) => a.time.getTime() - b.time.getTime());
  const offloadSeries = ordered.map(b => ({
    time: b.time,
    value: b.p2p + b.origin ? Math.round((b.p2p / (b.p2p + b.origin)) * 100) : 0,
  }));
  const peersSeries = ordered.map(b => ({
    time: b.time,
    value: b.n ? Math.round(b.peers / b.n) : 0,
  }));

  return (
    <div>
      <Title>WebTorrent P2P Metrics</Title>
      <p className="description">
        Experimental. How much livestream traffic viewers serve to each other (P2P) vs fetch from
        the origin, plus peer counts &mdash; use this to tune the chunk-size (latency) level. Data
        is in-memory and resets when the server restarts.
      </p>
      {error && <Alert type="warning" showIcon message={error} style={{ marginBottom: 16 }} />}
      {loading ? (
        <Spin />
      ) : (
        <>
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <StatisticItem title="P2P offload" value={`${offloadPct}%`} />
            </Col>
            <Col xs={12} md={6}>
              <StatisticItem title="P2P bytes" value={fmtBytes(totalP2P)} />
            </Col>
            <Col xs={12} md={6}>
              <StatisticItem title="Origin bytes" value={fmtBytes(totalOrigin)} />
            </Col>
            <Col xs={12} md={6}>
              <StatisticItem title="Chunk seconds" value={String(chunkSeconds)} />
            </Col>
          </Row>
          <div style={{ marginTop: 24 }}>
            <Chart title="P2P offload %" data={offloadSeries} color="#6544e9" unit="%" />
          </div>
          <div style={{ marginTop: 24 }}>
            <Chart title="Avg peers per viewer" data={peersSeries} color="#82c91e" unit="peers" />
          </div>
          {samples.length === 0 && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 16 }}
              message="No samples yet"
              description="Viewers report metrics once the P2P player is active and POSTing to /api/p2p/report."
            />
          )}
        </>
      )}
    </div>
  );
}

P2PMetrics.getLayout = function getLayout(page: ReactElement) {
  return <AdminLayout page={page} />;
};
