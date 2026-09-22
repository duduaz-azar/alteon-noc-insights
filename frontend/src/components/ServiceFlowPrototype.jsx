import { useEffect, useMemo, useState } from "react";

const safeNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const fmtInt = (v) => safeNumber(v).toLocaleString();
const fmtMs = (v) => `${safeNumber(v).toFixed(1)} ms`;
const fmtMbps = (v) => `${safeNumber(v).toFixed(2)} Mbps`;

const latencyStages = [
  { key: "client_to_alteon_ms", label: "Client Edge", hint: "Network ingress" },
  { key: "alteon_processing_ms", label: "Alteon Processing", hint: "ADC policy / LB" },
  { key: "alteon_to_server_ms", label: "Backend Connect", hint: "Server path" },
  { key: "server_process_ms", label: "Application Time", hint: "App response" },
  { key: "response_transfer_ms", label: "Response Egress", hint: "Return path" },
  { key: "end_to_end_ms", label: "End to End", hint: "User perceived" }
];

const defaultFlowData = {
  clients: {},
  service: {},
  alteon_cluster: {},
  real_servers: [],
  latency: { avg_end_to_end_ms: 0, p95_end_to_end_ms: 0, segments: {} }
};

function FlowConnector({ delay = "0s" }) {
  return (
    <div className="sfp-connector" aria-hidden="true">
      <svg viewBox="0 0 120 70" className="sfp-connector-svg">
        <defs>
          <linearGradient id="sfpFlowGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="55%" stopColor="#60a5fa" />
            <stop offset="100%" stopColor="#fbbf24" />
          </linearGradient>
        </defs>
        <path className="sfp-connector-glow" d="M 4 35 C 32 8, 78 62, 116 35" />
        <path className="sfp-connector-core" d="M 4 35 C 32 8, 78 62, 116 35" style={{ animationDelay: delay }} />
        <path className="sfp-connector-spark" d="M 4 35 C 32 8, 78 62, 116 35" style={{ animationDelay: delay }} />
      </svg>
    </div>
  );
}

function FlowNode({ title, value, children, clickable = false, open = false, onClick }) {
  const Wrapper = clickable ? "button" : "div";
  return (
    <div className="sfp-node-wrap">
      <div className="sfp-node-glow" />
      <Wrapper
        type={clickable ? "button" : undefined}
        className={`sfp-node-card ${clickable ? "sfp-node-click" : ""} ${open ? "sfp-node-open" : ""}`}
        aria-expanded={clickable ? open : undefined}
        onClick={clickable ? onClick : undefined}
      >
        <div className="sfp-node-top">
          <span className="sfp-node-title">{title}</span>
          {clickable ? <span className="sfp-node-caret">{open ? "▲" : "▼"}</span> : null}
        </div>
        <div className="sfp-node-value">{value}</div>
        <div className="sfp-node-bar"><span /></div>
        {children}
      </Wrapper>
    </div>
  );
}

export default function ServiceFlowPrototype({ reloadKey, query, onLatencyExpandedChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [serversOpen, setServersOpen] = useState(false);
  const [latencyOpen, setLatencyOpen] = useState(false);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("resize"));
    });
    return () => window.cancelAnimationFrame(raf);
  }, [latencyOpen, serversOpen]);

  useEffect(() => {
    onLatencyExpandedChange?.(latencyOpen);
  }, [latencyOpen, onLatencyExpandedChange]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/service-flow?${query}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`Request failed with status ${res.status}`);
        const json = await res.json();
        if (active) setData(json && typeof json === "object" ? json : {});
      } catch (e) {
        if (e?.name !== "AbortError") {
          if (active) {
            setData(null);
            setError("Failed to load data.");
          }
          console.error(e);
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadKey, query]);

  const normalized = useMemo(() => {
    const source = data && typeof data === "object" ? data : defaultFlowData;
    const clients = source.clients && typeof source.clients === "object" ? source.clients : {};
    const service = source.service && typeof source.service === "object" ? source.service : {};
    const cluster = source.alteon_cluster && typeof source.alteon_cluster === "object" ? source.alteon_cluster : {};
    const latency = source.latency && typeof source.latency === "object" ? source.latency : { segments: {} };
    const segments = latency.segments && typeof latency.segments === "object" ? latency.segments : {};
    const servers = Array.isArray(source.real_servers) ? source.real_servers : [];
    return { clients, service, cluster, latency: { ...latency, segments }, servers };
  }, [data]);

  const stateMessage = loading ? "Loading service flow..." : error || (!(data && typeof data === "object") ? "No data for selected range." : "");
  if (stateMessage) {
    return (
      <div className="sf-shell sf-state-shell">
        <span className={`text-sm ${error ? "text-red-300" : "text-blue-100/80"} ${loading ? "animate-pulse" : ""}`}>{stateMessage}</span>
      </div>
    );
  }

  const { clients, service, cluster, latency, servers } = normalized;
  const visibleServers = servers.slice(0, 5);
  const hiddenCount = Math.max(0, servers.length - visibleServers.length);
  const avg = safeNumber(latency.avg_end_to_end_ms, safeNumber(latency.segments.end_to_end_ms));
  const p95 = safeNumber(latency.p95_end_to_end_ms, safeNumber(latency.segments.end_to_end_ms));

  const stageRows = latencyStages.map((s, idx) => {
    const value = safeNumber(latency.segments?.[s.key]);
    return { ...s, stage: idx + 1, value };
  });
  const total = stageRows.reduce((sum, s) => sum + Math.max(0, s.value), 0);
  const stageRowsWithPct = stageRows.map((s) => ({
    ...s,
    pct: total > 0 ? Math.max(8, (Math.max(0, s.value) / total) * 100) : 0
  }));

  const pulseRows = [
    { label: "p95 latency", value: fmtMs(p95) },
    { label: "avg latency", value: fmtMs(avg) },
    { label: "max stage", value: fmtMs(Math.max(...stageRows.map((s) => s.value), 0)) }
  ];

  return (
    <div className={`sf-shell sfp-shell ${latencyOpen ? "sfp-shell--latency-open" : "sfp-shell--latency-closed"}`}>
      <div className="sfp-topline">
        <div>
          <h3 className="sf-title">Dynamic Service Flow</h3>
          <p className="sf-subtitle">Live ADC path with animated telemetry flow</p>
        </div>
        <div className="sfp-live-pill">live flow</div>
      </div>

      <section className="sfp-flow-strip">
        <div className="sfp-flow-row">
          <FlowNode title="CLIENTS / USER TRAFFIC" value={`${fmtInt(clients.requests)} req`}>
            <div className="sfp-mini-metrics">
              <span>Distinct {fmtInt(clients.distinct_clients)}</span>
              <span>RPS {safeNumber(clients.rps).toFixed(2)}</span>
            </div>
          </FlowNode>

          <FlowConnector delay="0s" />

          <FlowNode title="SERVICE / VIP" value={service.http_host || "N/A"}>
            <div className="sfp-mini-metrics">
              <span>VIP {service.vip || "N/A"}</span>
              <span>Req {fmtInt(service.requests)}</span>
            </div>
          </FlowNode>

          <FlowConnector delay="0.15s" />

          <FlowNode title="ALTEON ADC" value={cluster.active_device_ip || "N/A"}>
            <div className="sfp-mini-metrics">
              <span>HA Pair</span>
              <span>{cluster.standby_device_ip || "visual only"}</span>
            </div>
          </FlowNode>

          <FlowConnector delay="0.3s" />

          <FlowNode
            title="REAL SERVERS"
            value={`${servers.length} active`}
            clickable
            open={serversOpen}
            onClick={() => setServersOpen((v) => !v)}
          >
            <div className="sfp-view-toggle">VIEW SERVERS</div>
          </FlowNode>
        </div>

        {serversOpen ? (
          <div className="sfp-servers-panel">
            <div className="sfp-servers-grid">
              {visibleServers.map((row, idx) => (
                <button key={row?.real_server || `s-${idx}`} type="button" className="sfp-server-card">
                  <div className="sfp-server-ip">{row?.real_server || "N/A"}</div>
                  <div className="sfp-server-mbps">{fmtMbps(row?.avg_mbps)}</div>
                  <div className="sfp-server-meta">{fmtInt(row?.requests)} req | {fmtMs(row?.avg_latency_ms)}</div>
                  <div className="sfp-server-status">{row?.status || "UNKNOWN"}</div>
                </button>
              ))}
            </div>
            {hiddenCount > 0 ? <div className="sfp-server-more">+{hiddenCount} more</div> : null}
          </div>
        ) : null}
      </section>

      <section className="sfp-latency-wrap">
        <button type="button" className="sfp-lat-head" aria-expanded={latencyOpen} onClick={() => setLatencyOpen((v) => !v)}>
          <h5>LATENCY BREAKDOWN</h5>
          <div className="sfp-lat-summary">Avg {fmtMs(avg)} | P95 {fmtMs(p95)}</div>
          <span className="sfp-lat-chevron">{latencyOpen ? "▲" : "▼"}</span>
        </button>

        {latencyOpen ? (
          <div className="sfp-lat-expanded">
            <div className="sfp-lat-pipeline">
              {stageRowsWithPct.map((stage) => (
                <div key={stage.key} className="sfp-lat-card">
                  <div className="sfp-lat-card-top">
                    <div>
                      <div className="sfp-lat-label">STAGE {stage.stage}</div>
                      <div className="sfp-lat-name">{stage.label}</div>
                      <div className="sfp-lat-hint">{stage.hint}</div>
                    </div>
                    <div className="sfp-lat-right">
                      <div className="sfp-lat-ms">{fmtMs(stage.value)}</div>
                      <div className="sfp-lat-pct">{safeNumber(stage.pct).toFixed(0)}% share</div>
                    </div>
                  </div>
                  <div className="sfp-lat-bar-wrap">
                    <div className="sfp-lat-scan" />
                    <div className="sfp-lat-bar" style={{ width: `${safeNumber(stage.pct)}%` }} />
                  </div>
                </div>
              ))}
            </div>

            <aside className="sfp-pulse-side">
              <div className="sfp-pulse-title">telemetry pulse</div>
              <div className="sfp-pulse-list">
                {pulseRows.map((row) => (
                  <div key={row.label} className="sfp-pulse-card">
                    <div className="sfp-pulse-label">{row.label}</div>
                    <div className="sfp-pulse-value">{row.value}</div>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        ) : (
          <div className="sfp-lat-collapsed">Dynamic latency pipeline ready</div>
        )}
      </section>
    </div>
  );
}
