import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

const safeNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const fmtInt = (v) => safeNumber(v).toLocaleString();
const fmtMs = (v) => `${safeNumber(v).toFixed(1)} ms`;
const fmtMbps = (v) => `${safeNumber(v).toFixed(2)} Mbps`;

const statusTone = (status) => {
  const s = String(status || "").toUpperCase();
  if (s === "ERROR") return "error";
  if (s === "SLOW" || s === "WARNING") return "warn";
  if (s === "UP") return "ok";
  return "unknown";
};

const latencySegments = [
  { key: "client_to_alteon_ms", label: "Client -> Alteon" },
  { key: "alteon_processing_ms", label: "Alteon Processing" },
  { key: "alteon_to_server_ms", label: "Alteon -> Server" },
  { key: "server_process_ms", label: "Server Process" },
  { key: "response_transfer_ms", label: "Response Transfer" }
];

const maxVisibleServers = 10;

const defaultFlowData = {
  clients: {},
  service: {},
  alteon_cluster: {},
  real_servers: [],
  top_clients: [],
  latency: {
    avg_latency_ms: 0,
    p95_latency_ms: 0,
    segments: {}
  }
};

const severityFromMs = (value) => {
  const ms = safeNumber(value, NaN);
  if (!Number.isFinite(ms) || ms <= 0) return "unknown";
  if (ms >= 900) return "severe";
  if (ms >= 350) return "warn";
  return "normal";
};

const toneToClass = (severity) => {
  if (severity === "severe") return "is-severe";
  if (severity === "warn") return "is-warn";
  if (severity === "normal") return "is-normal";
  return "is-unknown";
};

const toneToDynClass = (severity) => {
  if (severity === "severe") return "sf-dyn-severe";
  if (severity === "warn") return "sf-dyn-warn";
  if (severity === "normal") return "sf-dyn-normal";
  return "sf-dyn-unknown";
};

const toneToLatencyClass = (severity) => {
  if (severity === "severe") return "sf-lat-severe";
  if (severity === "warn") return "sf-lat-warn";
  if (severity === "normal") return "sf-lat-normal";
  return "sf-lat-unknown";
};

function Metric({ label, value }) {
  return (
    <div className="sf-kv">
      <span className="sf-kv-label">{label}</span>
      <span className="sf-kv-value">{value}</span>
    </div>
  );
}

function ServerCard({ row, pillRef }) {
  const tone = statusTone(row?.status);
  const border = tone === "ok" ? "border-emerald-400/45" : tone === "warn" ? "border-amber-300/60" : tone === "error" ? "border-red-400/60" : "border-zinc-400/35";
  const dot = tone === "ok" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-300" : tone === "error" ? "bg-red-400" : "bg-zinc-400";
  const statusText = tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-200" : tone === "error" ? "text-red-300" : "text-zinc-300";

  return (
    <div ref={pillRef} className={`sf-server-card sf-server-pill-v44 ${border}`}>
      <span className="sf-server-pill-ip">{row?.real_server || "N/A"}</span>
      <span className="sf-server-pill-mbps">{fmtMbps(row?.avg_mbps)}</span>
      <span className={`sf-server-status sf-server-pill-status ${statusText}`}>
        <i className={`sf-dot ${dot}`} />
        {row?.status || "UNKNOWN"}
      </span>
    </div>
  );
}

export default function ServiceFlow({ reloadKey, query }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [serverConnectors, setServerConnectors] = useState([]);

  const shellRef = useRef(null);
  const alteonRef = useRef(null);
  const serverPillRefs = useRef([]);

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

  const normalizedData = useMemo(() => {
    const source = data && typeof data === "object" ? data : defaultFlowData;
    const clients = source.clients && typeof source.clients === "object" ? source.clients : {};
    const service = source.service && typeof source.service === "object" ? source.service : {};
    const cluster = source.alteon_cluster && typeof source.alteon_cluster === "object" ? source.alteon_cluster : {};
    const rawLatency = source.latency && typeof source.latency === "object" ? source.latency : {};
    const latency = {
      ...rawLatency,
      segments: rawLatency.segments && typeof rawLatency.segments === "object" ? rawLatency.segments : {}
    };
    const serviceStatus = service.status && typeof service.status === "object" ? service.status : {};
    const servers = Array.isArray(source.real_servers) ? source.real_servers.slice(0, maxVisibleServers) : [];

    return {
      clients,
      service,
      serviceStatus,
      cluster,
      latency,
      servers
    };
  }, [data]);

  const segments = useMemo(
    () => latencySegments.map((s) => ({
      ...s,
      value: safeNumber(normalizedData.latency.segments?.[s.key]),
      severity: severityFromMs(normalizedData.latency.segments?.[s.key])
    })),
    [normalizedData.latency.segments]
  );

  const latencyCards = useMemo(() => {
    const endToEnd = safeNumber(normalizedData.latency.segments?.end_to_end_ms);
    return [
      ...segments,
      {
        key: "end_to_end_ms",
        label: "End to End",
        value: endToEnd,
        severity: severityFromMs(endToEnd)
      }
    ];
  }, [segments, normalizedData.latency.segments]);

  const recomputeServerConnectors = useCallback(() => {
    const shellEl = shellRef.current;
    const alteonEl = alteonRef.current;
    if (!shellEl || !alteonEl) {
      setServerConnectors([]);
      return;
    }

    const shellRect = shellEl.getBoundingClientRect();
    const alteonRect = alteonEl.getBoundingClientRect();

    const startX = alteonRect.right - shellRect.left;
    const startY = alteonRect.top + alteonRect.height / 2 - shellRect.top;

    const next = normalizedData.servers.map((row, idx) => {
      const pillEl = serverPillRefs.current[idx];
      if (!pillEl) return null;

      const pillRect = pillEl.getBoundingClientRect();
      const endX = pillRect.left - shellRect.left;
      const endY = pillRect.top + pillRect.height / 2 - shellRect.top;
      const dx = endX - startX;
      const c1x = startX + dx * 0.35;
      const c2x = endX - dx * 0.35;

      const tone = statusTone(row?.status);
      const severity = tone === "error" ? "severe" : tone === "warn" ? "warn" : severityFromMs(row?.avg_latency_ms);

      return {
        key: idx,
        severity,
        startX,
        startY,
        endX,
        endY,
        d: `M${startX},${startY} C${c1x},${startY} ${c2x},${endY} ${endX},${endY}`
      };
    }).filter(Boolean);

    setServerConnectors(next);
  }, [normalizedData.servers]);

  useLayoutEffect(() => {
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recomputeServerConnectors);
    };

    schedule();

    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (observer) {
      if (shellRef.current) observer.observe(shellRef.current);
      if (alteonRef.current) observer.observe(alteonRef.current);
      serverPillRefs.current.forEach((el) => {
        if (el) observer.observe(el);
      });
    }

    window.addEventListener("resize", schedule);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", schedule);
      if (observer) observer.disconnect();
    };
  }, [recomputeServerConnectors, normalizedData.servers.length]);

  const hasRenderableData = data && typeof data === "object" && !error;
  const stateMessage = loading ? "Loading service flow..." : error || (!hasRenderableData ? "No data for selected range." : "");

  if (stateMessage) {
    return (
      <div className="sf-shell sf-state-shell">
        <span className={`text-sm ${error ? "text-red-300" : "text-blue-100/80"} ${loading ? "animate-pulse" : ""}`}>{stateMessage}</span>
      </div>
    );
  }

  const { clients, service, serviceStatus, cluster, latency, servers } = normalizedData;
  const summaryAvgMs = safeNumber(latency.avg_end_to_end_ms, safeNumber(latency.segments?.end_to_end_ms));
  const summaryP95Ms = safeNumber(latency.p95_end_to_end_ms, safeNumber(latency.segments?.end_to_end_ms));

  return (
    <div ref={shellRef} className="sf-shell sf-shell-v39 sf-shell-v46">
      <svg className="sf-dyn-svg sf-dyn-svg-v46" aria-hidden="true">
        <defs>
          <radialGradient id="sfDynHub" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#67e8f9" stopOpacity="1" />
            <stop offset="100%" stopColor="#22d3ee" stopOpacity="0.12" />
          </radialGradient>
        </defs>
        {serverConnectors.length > 0 && (
          <circle className="sf-dyn-hub" cx={serverConnectors[0].startX} cy={serverConnectors[0].startY} r="2.6" fill="url(#sfDynHub)" />
        )}
        {serverConnectors.map((line) => (
          <g key={`dyn-${line.key}`} className={`${toneToDynClass(line.severity)}`}>
            <path className="sf-dyn-path-base" d={line.d} />
            <path className="sf-dyn-path-core" d={line.d} />
            <path className="sf-dyn-path-trail" d={line.d} />
            <path className="sf-dyn-path-pulse" d={line.d} />
            <circle className="sf-dyn-endpoint" cx={line.endX} cy={line.endY} r="1.45" />
          </g>
        ))}
      </svg>

      <div className="sf-topline">
        <div>
          <h3 className="sf-title">Dynamic Service Flow</h3>
          <p className="sf-subtitle">Live telemetry path under active dashboard filters</p>
        </div>
        <div className="sf-live-pill">
          <i className="sf-live-dot" /> LIVE
        </div>
      </div>

      <div className="sf-main-grid sf-main-grid-v39">
        <svg className="sf-main-links sf-main-links-v39" viewBox="0 0 1000 210" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="sfMainBlueV39" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#22d3ee" />
              <stop offset="100%" stopColor="#60a5fa" />
            </linearGradient>
          </defs>
          <path className="sf-line sf-anim" d="M140,105 C190,105 220,105 268,105" stroke="url(#sfMainBlueV39)" />
          <path className="sf-line sf-anim" d="M392,105 C442,105 472,105 530,105" stroke="url(#sfMainBlueV39)" />
        </svg>

        <div className="sf-stage sf-float-wrap-v39">
          <div className="sf-float-card sf-stage-centered sf-clients sf-compact-v39">
            <h4>CLIENTS / USER TRAFFIC</h4>
            <div className="sf-clients-core">
              <div className="sf-client-cloud sf-client-cloud-v39" aria-hidden="true">
                {Array.from({ length: 4 }).map((_, i) => <span key={i} className="sf-client-node" />)}
              </div>
              <div className="sf-client-metrics-v39">
                <Metric label="Distinct" value={fmtInt(clients.distinct_clients)} />
                <Metric label="Req" value={fmtInt(clients.requests)} />
                <Metric label="RPS" value={safeNumber(clients.rps).toFixed(2)} />
              </div>
            </div>
          </div>
        </div>

        <div className="sf-stage sf-float-wrap-v39">
          <div className="sf-float-card sf-stage-centered sf-service sf-compact-v39">
            <h4>SERVICE</h4>
            <div className="sf-service-core">
              <div className="sf-service-badges"><span>TLS</span><span>HTTP</span></div>
              <Metric label="Host" value={service.http_host || "N/A"} />
              <Metric label="VIP" value={service.vip || "N/A"} />
              <Metric label="Req" value={fmtInt(service.requests)} />
              <Metric label="2xx / 5xx" value={`${fmtInt(serviceStatus.s2xx)} / ${fmtInt(serviceStatus.s5xx)}`} />
            </div>
          </div>
        </div>

        <div className="sf-stage sf-float-wrap-v39">
          <div ref={alteonRef} className="sf-float-card sf-stage-centered sf-cluster sf-compact-v39">
            <h4>ALTEON ADC CLUSTER</h4>
            <div className="sf-cluster-core">
              <div className="sf-appliance-wrap sf-appliance-wrap-v39">
                <div className="sf-appliance sf-appliance-v39">
                  <span className="sf-appliance-name">ALTEON</span>
                  <span className="sf-appliance-state text-emerald-300">Active</span>
                  <span className="sf-appliance-ip">{cluster.active_device_ip || "N/A"}</span>
                </div>
                <div className="sf-ha-link">HA Pair</div>
                <div className="sf-appliance sf-appliance-v39">
                  <span className="sf-appliance-name">ALTEON</span>
                  <span className="sf-appliance-state text-blue-200">Standby</span>
                  <span className="sf-appliance-ip">{cluster.standby_device_ip || "visual only"}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="sf-servers-outer-v45">
          <div className="sf-stage sf-servers sf-servers-v45">
            <h4>REAL SERVERS</h4>
            <div className="sf-server-list sf-server-list-v45">
              {servers.length === 0 ? (
                <div className="sf-empty">Real server mapping unavailable.</div>
              ) : servers.map((row, idx) => (
                <ServerCard
                  key={row?.real_server || `server-${idx}`}
                  row={row || {}}
                  pillRef={(el) => {
                    serverPillRefs.current[idx] = el;
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="sf-latency-panel sf-latency-panel-v47">
        <div className="sf-lat-head sf-lat-head-v47">
          <h5>LATENCY BREAKDOWN</h5>
          <div className="sf-lat-total">Avg {fmtMs(summaryAvgMs)} | P95 {fmtMs(summaryP95Ms)}</div>
        </div>

        {latency.segments && typeof latency.segments === "object" && Object.keys(latency.segments).length > 0 ? (
          <div className="sf-latency-flow-v47">
            <div className="sf-latency-cards-v47">
              {latencyCards.map((seg, idx) => (
                <div key={seg.key} className={`sf-lat-card-v47 ${toneToLatencyClass(seg.severity)}`}>
                  <span className="sf-seg-name">{seg.label}</span>
                  <span className="sf-seg-value">{fmtMs(seg.value)}</span>
                  {idx < latencyCards.length - 1 && (
                    <div className={`sf-latency-connectors-v47 ${toneToLatencyClass(seg.severity)}`} aria-hidden="true">
                      <svg className="sf-lat-link-v47" viewBox="0 0 100 16" preserveAspectRatio="none">
                        <path className="sf-lat-link-path-v47" d="M0,8 C32,8 68,8 100,8" />
                        <path className="sf-lat-pulse-v47" d="M0,8 C32,8 68,8 100,8" />
                      </svg>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="sf-empty">Segment breakdown unavailable from current telemetry.</div>
        )}
      </div>
    </div>
  );
}
