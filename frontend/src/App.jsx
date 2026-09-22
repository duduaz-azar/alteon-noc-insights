import { useEffect, useMemo, useRef, useState } from 'react';
import { Responsive, WidthProvider } from 'react-grid-layout';
import TimeChart from './components/TimeChart.jsx';
import CategoryChart from './components/CategoryChart.jsx';
import TopListChart from './components/TopListChart.jsx';
import ServiceFlow from './components/ServiceFlow.jsx';
import ServiceFlowPrototype from './components/ServiceFlowPrototype.jsx';
import TimeRange from './components/TimeRange.jsx';
import AiAssistant from './components/AiAssistant.jsx';

import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import 'flag-icons/css/flag-icons.min.css';

const ResponsiveGridLayout = WidthProvider(Responsive);
const LAYOUT_KEY = 'alteon_dashboard_layout_v13'; // Legacy local-only layout key, cleared after profile persistence.
const THEME_KEY = 'alteon_dashboard_theme';
const THEME_VERSION_KEY = 'alteon_dashboard_theme_version';
const DASHBOARD_THEME_VERSION = 'v5.104';
const USE_SERVICE_FLOW_PROTOTYPE = true;
const DEFAULT_RANGE_MINUTES = 60;
const AI_SIDEBAR_WIDTH_KEY = 'alteon_ai_sidebar_width_v16';
const AI_SIDEBAR_MIN_WIDTH = 320;
const AI_SIDEBAR_DEFAULT_WIDTH = 450;
const AI_SIDEBAR_MAX_WIDTH = 720;
const AI_SIDEBAR_MOBILE_BREAKPOINT = 900;
const SERVICE_FLOW_COLLAPSED_H = 3;
const SERVICE_FLOW_EXPANDED_H = 9;
const FILTER_KEYWORDS = ['service', 'app', 'alteon', 'client', 'status', 'server', 'latency', 'uri', 'method', 'user-agent', 'geo'];
const FILTER_ALIAS_TO_PARAM = {
  service: 'host',
  app: 'host',
  alteon: 'dst_ip',
  client: 'client_ip',
  status: 'response_code',
  server: 'real_server',
  latency: 'latency',
  uri: 'uri',
  method: 'method',
  'user-agent': 'user_agent',
  geo: 'geo_country'
};

const FILTER_SHORTCUTS = [
  { id: 'alteon', label: 'ALTEON' },
  { id: 'service', label: 'SERVICE' },
  { id: 'client', label: 'CLIENT' },
  { id: 'status', label: 'STATUS CODES' },
  { id: 'server', label: 'REAL SERVERS' },
  { id: 'latency', label: 'LATENCY' },
  { id: 'uri', label: 'URI' },
  { id: 'method', label: 'METHOD' },
  { id: 'user-agent', label: 'USER AGENTS' },
  { id: 'geo', label: 'GEO COUNTRIES' }
];

const AUDIT_ACTIONS = [
  '',
  'login_success',
  'login_failed',
  'logout',
  'admin_user_create',
  'admin_user_delete',
  'admin_users_view',
  'admin_sessions_view',
  'admin_audit_view',
  'dashboard_layout_read',
  'dashboard_layout_update',
  'api_request'
];

const isSvgFlagCountryCode = (value) => /^[A-Z]{2}$/.test(String(value || '').trim().toUpperCase());

const GeoFlag = ({ countryCode = '', fallbackFlag = '', className = '' }) => {
  const normalized = String(countryCode || '').trim().toUpperCase();
  if (isSvgFlagCountryCode(normalized)) {
    return <span aria-hidden="true" className={`fi fi-${normalized.toLowerCase()} dashboard-geo-flag-icon ${className}`.trim()} />;
  }
  const fallback = fallbackFlag || (normalized === 'PRIVATE' ? '🏠' : normalized === 'UNKNOWN' ? '🏳️' : '');
  return fallback ? <span aria-hidden="true" className={`dashboard-geo-flag-fallback ${className}`.trim()}>{fallback}</span> : null;
};

const normalizeChip = (field, value, meta = {}) => {
  const key = String(field || '').trim().toLowerCase();
  const mapped = FILTER_ALIAS_TO_PARAM[key] || '';
  const normalized = String(value || '').trim();
  if (!mapped || !normalized) return null;
  const normalizedValue = mapped === 'method' ? normalized.toUpperCase() : mapped === 'geo_country' ? normalized.toUpperCase() : normalized;
  const operator = (mapped === 'client_ip' || mapped === 'uri' || mapped === 'user_agent') ? 'contains' : 'in';
  return {
    id: `${mapped}:${normalizedValue}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
    field: mapped,
    sourceField: key,
    operator,
    value: normalizedValue,
    displayValue: meta.displayValue || normalizedValue,
    titleValue: meta.titleValue || normalizedValue,
    countryCode: meta.countryCode || (mapped === 'geo_country' ? normalizedValue : ''),
    fallbackFlag: meta.fallbackFlag || '',
    displayText: meta.displayText || meta.displayValue || normalizedValue
  };
};

const parseChipText = (text) => {
  const raw = String(text || '').trim();
  if (!raw.includes(':')) return null;
  const idx = raw.indexOf(':');
  const field = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  return normalizeChip(field, value);
};

const isPositiveMinutes = (minutes) => Number.isFinite(minutes) && minutes > 0;
const isValidDateTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isValidCustomRange = (range) => (
  range?.mode === 'custom' &&
  isValidDateTime(range.frm) &&
  isValidDateTime(range.to) &&
  Date.parse(range.frm) < Date.parse(range.to)
);

const normalizeRange = (nextRange, previousRange = {}) => {
  const nextMinutes = Number(nextRange?.minutes);

  if (nextRange?.mode === 'custom') {
    if (isValidCustomRange(nextRange)) return nextRange;
    return previousRange;
  }

  if (isPositiveMinutes(nextMinutes)) return nextRange;

  return { mode: 'preset', minutes: DEFAULT_RANGE_MINUTES };
};

const getAiSidebarMaxWidth = () => {
  if (typeof window === 'undefined') return AI_SIDEBAR_DEFAULT_WIDTH;
  return Math.min(AI_SIDEBAR_MAX_WIDTH, Math.floor(window.innerWidth * 0.5));
};

const clampAiSidebarWidth = (width) => {
  const nextWidth = Number(width);
  if (!Number.isFinite(nextWidth)) return AI_SIDEBAR_DEFAULT_WIDTH;
  const maxWidth = Math.max(AI_SIDEBAR_MIN_WIDTH, getAiSidebarMaxWidth());
  return Math.min(Math.max(Math.round(nextWidth), AI_SIDEBAR_MIN_WIDTH), maxWidth);
};

const getInitialAiSidebarWidth = () => {
  const storedWidth = Number(localStorage.getItem(AI_SIDEBAR_WIDTH_KEY));
  return clampAiSidebarWidth(Number.isFinite(storedWidth) ? storedWidth : AI_SIDEBAR_DEFAULT_WIDTH);
};

const KpiCard = ({ title, value, unit, color, theme, icon }) => (
  <div className={`dashboard-kpi p-5 rounded-2xl border transition-all duration-300 flex flex-col gap-1 ${
    theme === 'dark'
    ? 'bg-blue-950/35 border-yellow-300/20 shadow-[0_18px_50px_rgba(0,0,0,0.38)] backdrop-blur-xl'
    : 'bg-white border-zinc-200 shadow-sm'
  }`}>
    <div className="flex items-center justify-between">
      <div className="dashboard-kpi-label">
        {icon ? <img src={icon} alt="" className="dashboard-kpi-icon" /> : null}
        <span className={`text-[10px] font-black uppercase tracking-widest ${theme === 'dark' ? 'text-blue-100/55' : 'text-zinc-400'}`}>
          {title}
        </span>
      </div>
      <div className="w-1.5 h-1.5 rounded-full animate-pulse shadow-[0_0_14px_currentColor]" style={{ backgroundColor: color, color }}></div>
    </div>
    <div className="flex items-baseline gap-2">
      <span className={`text-2xl font-black font-mono ${theme === 'dark' ? 'text-zinc-100' : 'text-zinc-900'}`}>{value}</span>
      <span className={`text-xs font-bold ${theme === 'dark' ? 'text-yellow-100/70' : 'text-zinc-500'}`}>{unit}</span>
    </div>
  </div>
);

const formatDuration = (seconds) => {
  const value = Number(seconds || 0);
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

const formatZonedTime = (value, timeZone) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
};

const formatDualTime = (value) => {
  if (!value) return '-';
  return `Israel ${formatZonedTime(value, 'Asia/Jerusalem')} | UTC ${formatZonedTime(value, 'UTC')}`;
};

const formatAuditAction = (action) => String(action || '').replace(/_/g, ' ');

const formatAuditDetail = (detail) => {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' | ');
};

const formatBytes = (value) => {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const scaled = bytes / (1024 ** exponent);
  const precision = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return scaled.toFixed(precision) + " " + units[exponent];
};

const formatPercent = (value) => `${Number(value || 0).toFixed(2)}%`;

const AdminPanel = ({ theme, onClose }) => {
  const [users, setUsers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [error, setError] = useState('');

  const isDark = theme === 'dark';

  const loadAdminData = () => {
    setError('');
    Promise.all([
      fetch('/api/admin/users').then(r => {
        if (!r.ok) throw new Error(`Users request failed with status ${r.status}`);
        return r.json();
      }),
      fetch('/api/admin/sessions').then(r => {
        if (!r.ok) throw new Error(`Sessions request failed with status ${r.status}`);
        return r.json();
      })
    ])
      .then(([userData, sessionData]) => {
        setUsers(userData.users || []);
        setSessions(sessionData.sessions || []);
      })
      .catch(e => setError(e.message));
  };

  useEffect(() => {
    loadAdminData();
  }, []);

  const addUser = (e) => {
    e.preventDefault();
    setError('');
    fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    })
      .then(r => {
        if (!r.ok) throw new Error(`Add user failed with status ${r.status}`);
        return r.json();
      })
      .then(() => {
        setUsername('');
        setPassword('');
        setRole('user');
        loadAdminData();
      })
      .catch(e => setError(e.message));
  };

  const deleteUser = (id) => {
    setError('');
    fetch(`/api/admin/users/${id}`, { method: 'DELETE' })
      .then(r => {
        if (!r.ok) throw new Error(`Delete user failed with status ${r.status}`);
        loadAdminData();
      })
      .catch(e => setError(e.message));
  };

  return (
    <div className="admin-modal-overlay fixed inset-0 flex items-center justify-center bg-black/75 p-4 sm:p-6 backdrop-blur-sm">
      <div className={`admin-panel admin-panel-shell w-[820px] max-w-[min(96vw,820px)] rounded-2xl border shadow-2xl ${
        isDark ? 'bg-blue-950/80 border-yellow-300/25 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-900'
      }`}>
        <div className="admin-panel-header flex items-center justify-between gap-3 p-5 sm:p-6">
          <h2 className={`text-sm font-black uppercase tracking-[0.2em] ${isDark ? 'text-yellow-200' : 'text-blue-700'}`}>User Administration</h2>
          <button onClick={onClose} className="toolbar-element uppercase tracking-tighter">Close</button>
        </div>

        <div className="admin-panel-body px-5 pb-5 sm:px-6 sm:pb-6">
          {error && <div className="mb-4 text-sm font-bold text-red-500">{error}</div>}

          <form onSubmit={addUser} className="grid grid-cols-[1fr_1fr_120px_auto] gap-3 mb-6">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" className="toolbar-element justify-start" />
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="password" className="toolbar-element justify-start" />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="toolbar-element">
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button type="submit" disabled={username.length === 0 || password.length < 4} className="toolbar-element uppercase tracking-tighter disabled:opacity-40">Add</button>
        </form>

        <div className="grid gap-2 mb-8">
          {users.map(user => (
            <div key={user.id} className={`grid grid-cols-[1fr_90px_170px_90px_auto] gap-3 items-center rounded-xl border p-3 text-sm ${
              isDark ? 'border-blue-300/10 bg-blue-950/45' : 'border-zinc-200 bg-zinc-50'
            }`}>
              <span className="font-black">{user.username}</span>
              <span className="font-mono text-xs text-zinc-500">{user.role}</span>
              <span className="font-mono text-xs text-zinc-500">{user.created_at}</span>
              <span className={`text-xs font-black uppercase ${user.online ? (isDark ? 'text-yellow-200' : 'text-emerald-500') : 'text-zinc-500'}`}>{user.online ? 'online' : 'offline'}</span>
              <button onClick={() => deleteUser(user.id)} className="text-xs font-black uppercase text-red-500 hover:text-red-400">Delete</button>
            </div>
          ))}
        </div>

          <h3 className={`text-xs font-black uppercase tracking-[0.2em] mb-3 ${isDark ? 'text-yellow-200' : 'text-blue-700'}`}>Connected Sessions</h3>
          <div className="grid gap-2">
            {sessions.map((session, index) => (
              <div key={`${session.username}-${index}`} className={`grid grid-cols-[1fr_90px_120px_120px_120px] gap-3 rounded-xl border p-3 text-xs ${
                isDark ? 'border-blue-300/10 bg-blue-950/45' : 'border-zinc-200 bg-zinc-50'
              }`}>
                <span className="font-black">{session.username}</span>
                <span className="font-mono text-zinc-500">{session.role}</span>
                <span className={session.online ? `font-black uppercase ${isDark ? 'text-yellow-200' : 'text-emerald-500'}` : 'font-black text-zinc-500 uppercase'}>{session.online ? 'online' : 'offline'}</span>
                <span className="font-mono text-zinc-500">login {formatDuration(session.login_seconds)}</span>
                <span className="font-mono text-zinc-500">idle {formatDuration(session.idle_seconds)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const AuditDashboard = ({ theme, onClose }) => {
  const [auditEvents, setAuditEvents] = useState([]);
  const [error, setError] = useState('');
  const isDark = theme === 'dark';

  const loadAuditData = () => {
    setError('');
    fetch('/api/admin/audit?limit=250')
      .then(r => {
        if (!r.ok) throw new Error(`Audit request failed with status ${r.status}`);
        return r.json();
      })
      .then(data => setAuditEvents(data.events || []))
      .catch(e => setError(e.message));
  };

  useEffect(() => {
    loadAuditData();
  }, []);

  return (
    <div className="admin-modal-overlay fixed inset-0 flex items-center justify-center bg-black/75 p-4 sm:p-6 backdrop-blur-sm">
      <div className={`admin-panel admin-panel-shell w-[1180px] max-w-[min(96vw,1180px)] rounded-2xl border shadow-2xl ${
        isDark ? 'bg-blue-950/80 border-yellow-300/25 text-zinc-100' : 'bg-white border-zinc-200 text-zinc-900'
      }`}>
        <div className="admin-panel-header flex items-center justify-between gap-3 p-5 sm:p-6">
          <div>
            <h2 className={`text-sm font-black uppercase tracking-[0.2em] ${isDark ? 'text-yellow-200' : 'text-blue-700'}`}>Audit Dashboard</h2>
            <span className={`mt-1 block text-xs font-bold ${isDark ? 'text-blue-100/55' : 'text-zinc-500'}`}>Recent tracked portal activity</span>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={loadAuditData} className="toolbar-element uppercase tracking-tighter">Refresh</button>
            <button onClick={onClose} className="toolbar-element uppercase tracking-tighter">Close</button>
          </div>
        </div>

        <div className="admin-panel-body px-5 pb-5 sm:px-6 sm:pb-6">
          {error && <div className="mb-4 text-sm font-bold text-red-500">{error}</div>}

          <div className="grid gap-2">
            {auditEvents.map((event) => {
              const detailText = formatAuditDetail(event.detail);
              return (
                <div key={event.id} className={`grid grid-cols-[155px_140px_100px_1fr_70px_135px] gap-3 rounded-xl border p-3 text-xs ${
                  isDark ? 'border-blue-300/10 bg-blue-950/45' : 'border-zinc-200 bg-zinc-50'
                }`}>
                  <span className="font-mono text-zinc-500">{event.created_at}</span>
                  <span className="font-black uppercase">{formatAuditAction(event.action)}</span>
                  <span className="font-mono text-zinc-500">{event.username || 'system'}</span>
                  <span className="min-w-0 truncate font-mono text-zinc-500" title={`${event.method} ${event.path} ${detailText}`.trim()}>
                    {event.method} {event.path} {detailText}
                  </span>
                  <span className={`font-mono ${Number(event.status_code || 0) >= 400 ? 'text-red-500' : 'text-zinc-500'}`}>{event.status_code || '-'}</span>
                  <span className="font-mono text-zinc-500">{event.ip_address || '-'}</span>
                </div>
              );
            })}
            {auditEvents.length === 0 && (
              <div className={`rounded-xl border p-4 text-sm font-bold ${isDark ? 'border-blue-300/10 bg-blue-950/45 text-blue-100/60' : 'border-zinc-200 bg-zinc-50 text-zinc-500'}`}>
                No activity recorded yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const AdminPage = ({ theme, authUser, onLogout }) => {
  const [users, setUsers] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('user');
  const [filters, setFilters] = useState({ username: '', action: '', status: '', q: '', limit: '250' });
  const [sessionVisibleCount, setSessionVisibleCount] = useState(10);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const isDark = theme === 'dark';

  const adminPanelClass = isDark
    ? 'border-blue-300/10 bg-blue-950/45 text-zinc-100'
    : 'border-zinc-200 bg-white text-zinc-900';

  const loadUsersAndSessions = () => {
    return Promise.all([
      fetch('/api/admin/users').then(r => {
        if (!r.ok) throw new Error(`Users request failed with status ${r.status}`);
        return r.json();
      }),
      fetch('/api/admin/sessions').then(r => {
        if (!r.ok) throw new Error(`Sessions request failed with status ${r.status}`);
        return r.json();
      })
    ]).then(([userData, sessionData]) => {
      setUsers(userData.users || []);
      setSessions(sessionData.sessions || []);
      setSessionVisibleCount(10);
    });
  };

  const loadAuditData = () => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      const normalized = String(value || '').trim();
      if (normalized) params.set(key, normalized);
    });
    return fetch(`/api/admin/audit?${params.toString()}`)
      .then(r => {
        if (!r.ok) throw new Error(`Audit request failed with status ${r.status}`);
        return r.json();
      })
      .then(data => setAuditEvents(data.events || []));
  };

  const loadAdminData = () => {
    setBusy(true);
    setError('');
    Promise.all([loadUsersAndSessions(), loadAuditData()])
      .catch(e => setError(e.message))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    loadAdminData();
  }, []);

  const addUser = (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, role })
    })
      .then(r => {
        if (!r.ok) throw new Error(`Add user failed with status ${r.status}`);
        return r.json();
      })
      .then(() => {
        setUsername('');
        setPassword('');
        setRole('user');
        return loadAdminData();
      })
      .catch(e => setError(e.message))
      .finally(() => setBusy(false));
  };

  const deleteUser = (id) => {
    setBusy(true);
    setError('');
    fetch(`/api/admin/users/${id}`, { method: 'DELETE' })
      .then(r => {
        if (!r.ok) throw new Error(`Delete user failed with status ${r.status}`);
        return loadAdminData();
      })
      .catch(e => setError(e.message))
      .finally(() => setBusy(false));
  };

  const applyAuditFilters = (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    loadAuditData()
      .catch(e => setError(e.message))
      .finally(() => setBusy(false));
  };

  const clearAuditFilters = () => {
    setFilters({ username: '', action: '', status: '', q: '', limit: '250' });
  };

  const onlineCount = users.filter((user) => user.online).length;
  const lastAudit = auditEvents[0]?.created_at || '-';
  const visibleSessions = sessions.slice(0, sessionVisibleCount);
  const hasMoreSessions = sessionVisibleCount < sessions.length;

  return (
    <div className={`dashboard-root min-h-screen ${isDark ? 'dashboard-shell text-zinc-100' : 'dashboard-shell dashboard-shell-light text-zinc-900'}`}>
      <main className="dashboard-main min-h-screen overflow-y-auto p-6 sm:p-8">
        <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6">
          <header className={`dashboard-sticky-controls rounded-2xl border p-5 ${isDark ? 'border-yellow-300/15 bg-[#071429]/95' : 'border-zinc-200 bg-white/95'}`}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="dashboard-brand-lockup flex items-center gap-5">
                <div className="dashboard-radware-logo-wrap" aria-label="Radware">
                  <img
                    src={theme === 'dark' ? '/brand/radware-logo-white.png' : '/brand/radware-logo-dark.png'}
                    alt="Radware"
                    className="dashboard-radware-logo"
                  />
                  <span className="radware-logo-pulse-dot radware-logo-pulse-dot--red" aria-hidden="true"></span>
                  <span className="radware-logo-pulse-dot radware-logo-pulse-dot--yellow" aria-hidden="true"></span>
                  <span className="radware-logo-pulse-dot radware-logo-pulse-dot--green" aria-hidden="true"></span>
                </div>
                <div className={`dashboard-brand-divider ${theme === 'dark' ? 'is-dark' : 'is-light'}`}></div>
                <div className="flex flex-col">
                  <h1 className={`dashboard-title text-3xl ${theme === 'dark' ? 'text-white' : 'text-black'}`}>admin</h1>
                  <span className={`font-bold text-sm tracking-widest uppercase mt-1 ${theme === 'dark' ? 'text-yellow-100' : 'text-blue-700'}`}>alteon ai noc v5.104</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <span className={`font-mono text-xs ${isDark ? 'text-blue-100/60' : 'text-zinc-500'}`}>{authUser?.username}</span>
                <a href="/" className="toolbar-element uppercase tracking-tighter">NOC</a>
                <button onClick={loadAdminData} disabled={busy} className="toolbar-element uppercase tracking-tighter disabled:opacity-40">Refresh</button>
                <button onClick={onLogout} className="toolbar-element uppercase tracking-tighter">Logout</button>
              </div>
            </div>
          </header>

          {error && <div className="rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-400">{error}</div>}

          <section className="grid gap-4 md:grid-cols-4">
            <KpiCard title="Users" value={users.length.toLocaleString()} unit="total" color="#5ACBF0" theme={theme} />
            <KpiCard title="Online" value={onlineCount.toLocaleString()} unit="active" color="#41AAC1" theme={theme} />
            <KpiCard title="Sessions" value={sessions.length.toLocaleString()} unit="recent" color="#ED1C24" theme={theme} />
            <KpiCard title="Audit" value={auditEvents.length.toLocaleString()} unit={lastAudit === '-' ? '-' : 'last event'} color="#F26B43" theme={theme} />
          </section>

          <section>
            <div className={`rounded-2xl border p-5 shadow-xl ${adminPanelClass}`}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className={`text-sm font-black uppercase tracking-[0.2em] ${isDark ? 'text-yellow-200' : 'text-blue-700'}`}>Users</h2>
                <span className="font-mono text-xs text-zinc-500">{onlineCount} online</span>
              </div>

              <form onSubmit={addUser} className="mb-5 grid gap-3 sm:grid-cols-[1fr_1fr_110px_auto]">
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="username" className="toolbar-element justify-start" />
                <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password" type="password" className="toolbar-element justify-start" />
                <select value={role} onChange={(e) => setRole(e.target.value)} className="toolbar-element">
                  <option value="user">user</option>
                  <option value="admin">admin</option>
                </select>
                <button type="submit" disabled={busy || username.length === 0 || password.length < 4} className="toolbar-element uppercase tracking-tighter disabled:opacity-40">Add</button>
              </form>

              <div className="grid gap-2">
                {users.map(user => (
                  <div key={user.id} className={`grid grid-cols-[1fr_78px_72px_auto] items-center gap-3 rounded-xl border p-3 text-sm ${
                    isDark ? 'border-blue-300/10 bg-blue-950/45' : 'border-zinc-200 bg-zinc-50'
                  }`}>
                    <div className="min-w-0">
                      <div className="truncate font-black">{user.username}</div>
                      <div className="truncate font-mono text-[11px] text-zinc-500" title={formatDualTime(user.last_login_at)}>last login {formatDualTime(user.last_login_at)}</div>
                    </div>
                    <span className="font-mono text-xs text-zinc-500">{user.role}</span>
                    <span className={`text-xs font-black uppercase ${user.online ? (isDark ? 'text-yellow-200' : 'text-emerald-500') : 'text-zinc-500'}`}>{user.online ? 'online' : 'offline'}</span>
                    <button onClick={() => deleteUser(user.id)} disabled={busy || user.id === authUser?.id} className="text-xs font-black uppercase text-red-500 hover:text-red-400 disabled:opacity-30">Delete</button>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className={`rounded-2xl border p-5 shadow-xl ${adminPanelClass}`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className={`text-sm font-black uppercase tracking-[0.2em] ${isDark ? 'text-yellow-200' : 'text-blue-700'}`}>Audit Logs</h2>
              <span className="font-mono text-xs text-zinc-500">{auditEvents.length} rows</span>
            </div>

            <form onSubmit={applyAuditFilters} className="mb-5 grid gap-3 lg:grid-cols-[150px_180px_130px_1fr_100px_auto_auto]">
              <input value={filters.username} onChange={(e) => setFilters(prev => ({ ...prev, username: e.target.value }))} placeholder="username" className="toolbar-element justify-start" />
              <select value={filters.action} onChange={(e) => setFilters(prev => ({ ...prev, action: e.target.value }))} className="toolbar-element">
                {AUDIT_ACTIONS.map(action => <option key={action || 'all'} value={action}>{action || 'all actions'}</option>)}
              </select>
              <select value={filters.status} onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))} className="toolbar-element">
                <option value="">all status</option>
                <option value="2xx">2xx</option>
                <option value="3xx">3xx</option>
                <option value="4xx">4xx</option>
                <option value="5xx">5xx</option>
                <option value="200">200</option>
                <option value="401">401</option>
                <option value="403">403</option>
                <option value="500">500</option>
              </select>
              <input value={filters.q} onChange={(e) => setFilters(prev => ({ ...prev, q: e.target.value }))} placeholder="path, IP, detail" className="toolbar-element justify-start" />
              <select value={filters.limit} onChange={(e) => setFilters(prev => ({ ...prev, limit: e.target.value }))} className="toolbar-element">
                <option value="100">100</option>
                <option value="250">250</option>
                <option value="500">500</option>
              </select>
              <button type="submit" disabled={busy} className="toolbar-element uppercase tracking-tighter disabled:opacity-40">Filter</button>
              <button type="button" onClick={clearAuditFilters} className="toolbar-element uppercase tracking-tighter">Clear</button>
            </form>

            <div className="overflow-x-auto">
              <div className="grid min-w-[1180px] gap-2">
                {auditEvents.map((event) => {
                  const detailText = formatAuditDetail(event.detail);
                  return (
                    <div key={event.id} className={`grid grid-cols-[310px_150px_105px_1fr_70px_135px] gap-3 rounded-xl border p-3 text-xs ${
                      isDark ? 'border-blue-300/10 bg-blue-950/45' : 'border-zinc-200 bg-zinc-50'
                    }`}>
                      <span className="font-mono text-zinc-500" title={formatDualTime(event.created_at)}>{formatDualTime(event.created_at)}</span>
                      <span className="font-black uppercase">{formatAuditAction(event.action)}</span>
                      <span className="font-mono text-zinc-500">{event.username || 'system'}</span>
                      <span className="min-w-0 truncate font-mono text-zinc-500" title={`${event.method} ${event.path} ${detailText}`.trim()}>
                        {event.method} {event.path} {detailText}
                      </span>
                      <span className={`font-mono ${Number(event.status_code || 0) >= 400 ? 'text-red-500' : 'text-zinc-500'}`}>{event.status_code || '-'}</span>
                      <span className="font-mono text-zinc-500">{event.ip_address || '-'}</span>
                    </div>
                  );
                })}
                {auditEvents.length === 0 && (
                  <div className={`rounded-xl border p-4 text-sm font-bold ${isDark ? 'border-blue-300/10 bg-blue-950/45 text-blue-100/60' : 'border-zinc-200 bg-zinc-50 text-zinc-500'}`}>
                    No activity recorded.
                  </div>
                )}
              </div>
            </div>
          </section>

          <section className={`rounded-2xl border p-5 shadow-xl ${adminPanelClass}`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className={`text-sm font-black uppercase tracking-[0.2em] ${isDark ? 'text-yellow-200' : 'text-blue-700'}`}>Connected Sessions</h2>
              <span className="font-mono text-xs text-zinc-500">showing {visibleSessions.length} of {sessions.length}</span>
            </div>
            <div className="overflow-x-auto">
              <div className="grid min-w-[1160px] gap-2">
                {visibleSessions.map((session, index) => (
                  <div key={`${session.username}-${index}-${session.created_at}`} className={`grid grid-cols-[1fr_80px_90px_minmax(260px,1fr)_minmax(260px,1fr)_110px_110px] gap-3 rounded-xl border p-3 text-xs ${
                    isDark ? 'border-blue-300/10 bg-blue-950/45' : 'border-zinc-200 bg-zinc-50'
                  }`}>
                    <span className="font-black">{session.username}</span>
                    <span className="font-mono text-zinc-500">{session.role}</span>
                    <span className={session.online ? `font-black uppercase ${isDark ? 'text-yellow-200' : 'text-emerald-500'}` : 'font-black text-zinc-500 uppercase'}>{session.online ? 'online' : 'offline'}</span>
                    <span className="font-mono text-zinc-500" title={formatDualTime(session.created_at)}>login at {formatDualTime(session.created_at)}</span>
                    <span className="font-mono text-zinc-500" title={formatDualTime(session.last_seen_at)}>last seen {formatDualTime(session.last_seen_at)}</span>
                    <span className="font-mono text-zinc-500">login {formatDuration(session.login_seconds)}</span>
                    <span className="font-mono text-zinc-500">idle {formatDuration(session.idle_seconds)}</span>
                  </div>
                ))}
              </div>
            </div>
            {hasMoreSessions && (
              <button
                type="button"
                onClick={() => setSessionVisibleCount((count) => Math.min(count + 10, sessions.length))}
                className="toolbar-element mt-4 uppercase tracking-tighter"
              >
                + 10 more
              </button>
            )}
          </section>
        </div>
      </main>
    </div>
  );
};

const AdminForbiddenPage = ({ theme, onLogout }) => {
  const isDark = theme === 'dark';
  return (
    <div className={`dashboard-root min-h-screen ${isDark ? 'dashboard-shell text-zinc-100' : 'dashboard-shell dashboard-shell-light text-zinc-900'}`}>
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className={`w-full max-w-[520px] rounded-2xl border p-6 text-center shadow-xl ${isDark ? 'border-yellow-300/20 bg-blue-950/60' : 'border-zinc-200 bg-white'}`}>
          <h1 className={`dashboard-title mb-3 text-3xl ${isDark ? 'text-white' : 'text-black'}`}>admin</h1>
          <p className={`mb-5 text-sm font-bold ${isDark ? 'text-blue-100/70' : 'text-zinc-500'}`}>Admin role required.</p>
          <div className="flex justify-center gap-3">
            <a href="/" className="toolbar-element uppercase tracking-tighter">NOC</a>
            <button onClick={onLogout} className="toolbar-element uppercase tracking-tighter">Logout</button>
          </div>
        </div>
      </main>
    </div>
  );
};

// v5.71 keeps the priority rows intact and appends telemetry enrichment widgets after the existing operational section.
const initialLayout = [
  { i: 'transaction', x: 0, y: 0, w: 12, h: 4 },
  { i: 'bandwidthApps', x: 0, y: 4, w: 12, h: 3 },
  { i: 'serviceFlow', x: 0, y: 7, w: 12, h: SERVICE_FLOW_COLLAPSED_H },

  { i: 'rs', x: 0, y: 10, w: 4, h: 3 },
  { i: 'clients', x: 4, y: 10, w: 4, h: 3 },
  { i: 'urls', x: 8, y: 10, w: 4, h: 3 },

  { i: 'methods', x: 0, y: 13, w: 6, h: 3 },
  { i: 'codes', x: 6, y: 13, w: 6, h: 3 },

  { i: 'traffic', x: 0, y: 16, w: 6, h: 3 },
  { i: 'bandwidth', x: 6, y: 16, w: 6, h: 3 },
  { i: 'timeline', x: 0, y: 19, w: 4, h: 3 },
  { i: 'latency', x: 4, y: 19, w: 4, h: 3 },
  { i: 'rps', x: 8, y: 19, w: 4, h: 3 },

  { i: 'serviceErrors', x: 0, y: 22, w: 6, h: 3 },
  { i: 'realServerBandwidth', x: 6, y: 22, w: 6, h: 3 },
  { i: 'virtualServices', x: 0, y: 25, w: 6, h: 3 },
  { i: 'geoCountries', x: 6, y: 25, w: 6, h: 3 },
  { i: 'userAgents', x: 0, y: 28, w: 6, h: 3 },
  { i: 'contentTypes', x: 6, y: 28, w: 6, h: 3 },
  { i: 'forwardedClients', x: 0, y: 31, w: 6, h: 3 },
  { i: 'httpVersions', x: 6, y: 31, w: 6, h: 3 },

  { i: 'serverRtt', x: 0, y: 34, w: 6, h: 3 },
  { i: 'eventSeverity', x: 6, y: 34, w: 6, h: 3 },
  { i: 'egressPaths', x: 0, y: 37, w: 6, h: 3 },
  { i: 'alteonObjects', x: 6, y: 37, w: 6, h: 3 },
  { i: 'appOutcomes', x: 0, y: 40, w: 12, h: 3 }
];

const layoutIds = new Set(initialLayout.map((item) => item.i));

const cloneInitialLayout = () => initialLayout.map((item) => ({ ...item }));

const normalizeLayout = (candidate) => {
  if (!Array.isArray(candidate)) return cloneInitialLayout();

  const byId = new Map();
  candidate.forEach((item) => {
    if (!item || typeof item !== 'object' || !layoutIds.has(item.i)) return;

    const x = Number(item.x);
    const y = Number(item.y);
    const w = Number(item.w);
    const h = Number(item.h);
    if (![x, y, w, h].every(Number.isFinite)) return;

    const safeX = Math.min(Math.max(Math.trunc(x), 0), 11);
    const safeY = Math.min(Math.max(Math.trunc(y), 0), 200);
    const maxWidth = Math.max(1, 12 - safeX);
    const safeW = Math.min(Math.max(Math.trunc(w), 1), maxWidth);
    const safeH = Math.min(Math.max(Math.trunc(h), 1), 20);
    byId.set(item.i, { i: item.i, x: safeX, y: safeY, w: safeW, h: safeH });
  });

  return initialLayout.map((item) => byId.get(item.i) || { ...item });
};

const withServiceFlowHeight = (items, targetH) => {
  const safeTarget = Math.max(1, Math.trunc(targetH));
  let changed = false;
  const next = items.map((item) => {
    if (item.i !== 'serviceFlow') return item;
    if (item.h === safeTarget) return item;
    changed = true;
    return { ...item, h: safeTarget };
  });
  return { next, changed };
};

export default function App() {
  const isAdminRoute = typeof window !== 'undefined' && window.location.pathname.replace(/\/+$/, '') === '/admin';
  const [now, setNow] = useState(new Date());
  const [range, setRange] = useState({ mode: 'preset', minutes: DEFAULT_RANGE_MINUTES });
  const [reloadKey, setReloadKey] = useState(0);
  const [isDraggable, setIsDraggable] = useState(false);
  const [layout, setLayout] = useState(() => cloneInitialLayout());
  const [pendingLayout, setPendingLayout] = useState(() => cloneInitialLayout());
  const [layoutReady, setLayoutReady] = useState(false);
  const [serviceFlowLatencyOpen, setServiceFlowLatencyOpen] = useState(false);

  const setServiceFlowHeight = (targetH) => {
    setLayout((prev) => {
      const { next, changed } = withServiceFlowHeight(prev, targetH);
      return changed ? next : prev;
    });
    setPendingLayout((prev) => {
      const { next, changed } = withServiceFlowHeight(prev, targetH);
      return changed ? next : prev;
    });
  };

  const handleServiceFlowLatencyExpandedChange = (isOpen) => {
    setServiceFlowLatencyOpen(isOpen);
    setServiceFlowHeight(isOpen ? SERVICE_FLOW_EXPANDED_H : SERVICE_FLOW_COLLAPSED_H);
    window.requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };
  const [filterChips, setFilterChips] = useState([]);
  const [filterInput, setFilterInput] = useState('');
  const [filterOptions, setFilterOptions] = useState({ services: [], alteons: [], client_ips: [], uris: [], response_codes: [], response_code_groups: [], methods: [], real_servers: [], latency_ranges: [], user_agents: [], geo_countries: [], geo_status: 'disabled', geo_message: '' });
  const [filterSuggestions, setFilterSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeFilterType, setActiveFilterType] = useState('');
  const [theme, setTheme] = useState(() => {
    if (localStorage.getItem(THEME_VERSION_KEY) !== DASHBOARD_THEME_VERSION) return 'dark';
    return localStorage.getItem(THEME_KEY) || 'dark';
  });
  const [kpis, setKpis] = useState({ throughput: '0.00', rps: '0', errorRate: '0.00', latency: '0' });
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [isAuditOpen, setIsAuditOpen] = useState(false);
  const [aiSidebarWidth, setAiSidebarWidth] = useState(getInitialAiSidebarWidth);
  const aiSidebarWidthRef = useRef(aiSidebarWidth);
  const aiSidebarFrameRef = useRef(null);
  const layoutHydrationFrameRef = useRef(null);
  const isHydratingLayoutRef = useRef(true);
  const dashboardMainRef = useRef(null);
  const filterInputRef = useRef(null);

  useEffect(() => {
    aiSidebarWidthRef.current = aiSidebarWidth;
    localStorage.setItem(AI_SIDEBAR_WIDTH_KEY, String(aiSidebarWidth));
  }, [aiSidebarWidth]);

  useEffect(() => {
    const handleResize = () => {
      setAiSidebarWidth((currentWidth) => clampAiSidebarWidth(currentWidth));
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (aiSidebarFrameRef.current) cancelAnimationFrame(aiSidebarFrameRef.current);
      if (layoutHydrationFrameRef.current) cancelAnimationFrame(layoutHydrationFrameRef.current);
    };
  }, []);


  const applyResolvedLayout = (nextLayout) => {
    const normalized = normalizeLayout(nextLayout);
    const targetH = serviceFlowLatencyOpen ? SERVICE_FLOW_EXPANDED_H : SERVICE_FLOW_COLLAPSED_H;
    const { next } = withServiceFlowHeight(normalized, targetH);

    isHydratingLayoutRef.current = true;
    if (layoutHydrationFrameRef.current) cancelAnimationFrame(layoutHydrationFrameRef.current);

    setLayout(next);
    setPendingLayout(next);
    setLayoutReady(true);

    if (typeof window !== 'undefined') {
      layoutHydrationFrameRef.current = window.requestAnimationFrame(() => {
        isHydratingLayoutRef.current = false;
        layoutHydrationFrameRef.current = null;
      });
    } else {
      isHydratingLayoutRef.current = false;
    }
  };

  const saveDashboardLayout = async (nextLayout) => {
    const safeLayout = normalizeLayout(nextLayout);
    setLayout(safeLayout);
    setPendingLayout(safeLayout);
    localStorage.removeItem(LAYOUT_KEY);

    if (!authUser) return;

    const res = await fetch('/api/user/preferences/dashboard-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: safeLayout })
    });
    if (!res.ok) throw new Error(`Layout save failed with status ${res.status}`);
  };

  const resetLayout = () => {
    saveDashboardLayout(cloneInitialLayout()).catch((err) => console.error('Failed to save default layout:', err));
  };

  const handleRangeChange = (nextRange) => {
    setRange(prevRange => normalizeRange(nextRange, prevRange));
  };

  const activeRange = normalizeRange(range, { mode: 'preset', minutes: DEFAULT_RANGE_MINUTES });

  const buildDashboardParams = () => {
    const params = new URLSearchParams();

    if (activeRange.mode === 'custom') {
      params.append('frm', activeRange.frm);
      params.append('to', activeRange.to);
    } else {
      params.append('minutes', activeRange.minutes || DEFAULT_RANGE_MINUTES);
    }
    const grouped = filterChips.reduce((acc, chip) => {
      if (!acc[chip.field]) acc[chip.field] = [];
      if (!acc[chip.field].includes(chip.value)) acc[chip.field].push(chip.value);
      return acc;
    }, {});
    Object.entries(grouped).forEach(([field, values]) => {
      if (values.length > 0) params.append(field, values.join(','));
    });

    return params;
  };

  const dashboardQuery = useMemo(() => buildDashboardParams().toString(), [
    activeRange.mode,
    activeRange.minutes,
    activeRange.frm,
    activeRange.to,
    filterChips
  ]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(THEME_VERSION_KEY, DASHBOARD_THEME_VERSION);
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [theme]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(r => r.json())
      .then(data => setAuthUser(data.user || null))
      .catch(() => setAuthUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  useEffect(() => {
    if (authLoading) return undefined;

    if (isAdminRoute) return undefined;

    if (!authUser) {
      applyResolvedLayout(cloneInitialLayout());
      return undefined;
    }

    setLayoutReady(false);
    const controller = new AbortController();
    localStorage.removeItem(LAYOUT_KEY);

    fetch('/api/user/preferences/dashboard-layout', { signal: controller.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (controller.signal.aborted) return;
        applyResolvedLayout(data?.layout);
      })
      .catch(e => {
        if (e.name === 'AbortError') return;
        console.error('Failed to load dashboard layout:', e);
        applyResolvedLayout(cloneInitialLayout());
      });

    return () => controller.abort();
  }, [authLoading, authUser?.id, isAdminRoute]);

  useEffect(() => {
    if (!authUser) return undefined;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [authUser]);

  useEffect(() => {
    if (!authUser || isAdminRoute) return undefined;
    const controller = new AbortController();
    fetch(`/api/summary?${dashboardQuery}`, { signal: controller.signal })
      .then(r => {
        if (!r.ok) throw new Error(`Request failed with status ${r.status}`);
        return r.json();
      })
      .then(data => {
        setKpis({
          throughput: Number(data.throughput_mbps || 0).toFixed(2),
          rps: Number(data.requests_total || 0).toLocaleString(),
          errorRate: Number(data.errors_percent || 0).toFixed(2),
          latency: Math.round(Number(data.latency_ms || 0)).toLocaleString()
        });
      })
      .catch(e => {
        if (e.name !== 'AbortError') console.error(e);
      });

    return () => controller.abort();
  }, [dashboardQuery, reloadKey, authUser, isAdminRoute]);

  useEffect(() => {
    if (!authUser || isAdminRoute) return undefined;
    const controller = new AbortController();
    fetch(`/api/filter-options?${dashboardQuery}`, { signal: controller.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (!data || controller.signal.aborted) return;
        setFilterOptions({
          services: Array.isArray(data.services) ? data.services : [],
          alteons: Array.isArray(data.alteons) ? data.alteons : [],
          client_ips: Array.isArray(data.client_ips) ? data.client_ips : [],
          uris: Array.isArray(data.uris) ? data.uris : [],
          response_codes: Array.isArray(data.response_codes) ? data.response_codes : [],
          response_code_groups: Array.isArray(data.response_code_groups) ? data.response_code_groups : [],
          methods: Array.isArray(data.methods) ? data.methods : [],
          real_servers: Array.isArray(data.real_servers) ? data.real_servers : [],
          latency_ranges: Array.isArray(data.latency_ranges) ? data.latency_ranges : [],
          user_agents: Array.isArray(data.user_agents) ? data.user_agents : [],
          geo_countries: Array.isArray(data.geo_countries) ? data.geo_countries : [],
          geo_status: String(data.geo_status || 'disabled'),
          geo_message: String(data.geo_message || '')
        });
      })
      .catch(e => {
        if (e.name !== 'AbortError') console.error('Failed to load filter options:', e);
      });

    return () => controller.abort();
  }, [dashboardQuery, reloadKey, authUser, isAdminRoute]);

  useEffect(() => {
    const q = filterInput.trim().toLowerCase();
    if (!q) {
      setFilterSuggestions([]);
      return;
    }
    let next = [];
    if (!q.includes(':')) {
      next = FILTER_KEYWORDS
        .filter((item) => item.startsWith(q))
        .map((item) => ({ type: 'keyword', label: `${item}:`, value: `${item}:` }));
    } else {
      const [rawField, rawValue] = q.split(':', 2);
      const field = FILTER_ALIAS_TO_PARAM[rawField] ? rawField : '';
      if (field) setActiveFilterType(field);
      const valueQuery = (rawValue || '').trim();
      const source = (() => {
        if (field === 'service' || field === 'app') return filterOptions.services;
        if (field === 'alteon') return filterOptions.alteons;
        if (field === 'client') return filterOptions.client_ips;
        if (field === 'uri') return filterOptions.uris;
        if (field === 'status') return [...filterOptions.response_code_groups, ...filterOptions.response_codes];
        if (field === 'server') return filterOptions.real_servers;
        if (field === 'latency') return filterOptions.latency_ranges;
        if (field === 'method') return filterOptions.methods;
        if (field === 'user-agent') return filterOptions.user_agents;
        if (field === 'geo') return filterOptions.geo_countries;
        return [];
      })();
      next = source
        .map((item) => (typeof item === 'string' ? { value: item, count: 0 } : item))
        .filter((item) => {
          const label = String(item.label || item.country_name || item.value || '').toLowerCase();
          const value = String(item.value || '').toLowerCase();
          return label.includes(valueQuery) || value.includes(valueQuery);
        })
        .sort((a, b) => Number(b.count || b.requests || 0) - Number(a.count || a.requests || 0))
        .slice(0, 12)
        .map((item) => ({
          type: 'value',
          label: field === 'geo' ? `${rawField}:${item.label || item.value}` : `${rawField}:${item.value}`,
          value: `${rawField}:${item.value}`,
          chip: normalizeChip(rawField, item.value, {
            displayValue: field === 'geo' ? (item.country_name || item.label || item.value) : item.value,
            titleValue: field === 'geo' ? (item.label || item.value) : item.value,
            displayText: field === 'geo' ? (item.country_name || item.value) : item.value,
            countryCode: field === 'geo' ? (item.country_code || item.value) : '',
            fallbackFlag: field === 'geo' ? (item.flag || '') : ''
          }),
          countryCode: field === 'geo' ? (item.country_code || item.value) : '',
          fallbackFlag: field === 'geo' ? (item.flag || '') : '',
          displayText: field === 'geo' ? (item.country_name || item.value) : ''
        }));
    }
    setFilterSuggestions(next.slice(0, 12));
  }, [filterInput, filterOptions]);

  const handleFilterTypeShortcut = (type) => {
    setActiveFilterType(type);
    setFilterInput(`${type}:`);
    setShowSuggestions(true);
    if (filterInputRef.current) filterInputRef.current.focus();
  };

  const login = (e) => {
    e.preventDefault();
    setLoginError('');
    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: loginUsername, password: loginPassword })
    })
      .then(r => {
        if (!r.ok) throw new Error('Login failed');
        return r.json();
      })
      .then(data => {
        setLayoutReady(false);
        setAuthUser(data.user);
        setLoginPassword('');
      })
      .catch(() => setLoginError('Invalid username or password.'));
  };

  const logout = () => {
    fetch('/api/auth/logout', { method: 'POST' })
      .finally(() => {
        if (layoutHydrationFrameRef.current) cancelAnimationFrame(layoutHydrationFrameRef.current);
        isHydratingLayoutRef.current = true;
        setLayoutReady(false);
        setAuthUser(null);
        setIsAdminOpen(false);
        setIsAuditOpen(false);
        setLayout(cloneInitialLayout());
        setPendingLayout(cloneInitialLayout());
      });
  };

  const addFilterChip = (rawText) => {
    const parsed = typeof rawText === 'object' && rawText?.field ? rawText : parseChipText(rawText);
    if (!parsed) return;
    setFilterChips((prev) => {
      if (prev.some((chip) => chip.field === parsed.field && chip.value === parsed.value)) return prev;
      return [...prev, parsed];
    });
    setFilterInput('');
    setShowSuggestions(false);
  };

  const removeFilterChip = (id) => {
    setFilterChips((prev) => prev.filter((chip) => chip.id !== id));
  };

  const clearSmartFilters = () => {
    setFilterChips([]);
    setFilterInput('');
    setFilterSuggestions([]);
    setShowSuggestions(false);
    setActiveFilterType('');
    if (filterInputRef.current) filterInputRef.current.focus();
  };

  const onFilterInputKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (filterSuggestions.length > 0) {
        e.preventDefault();
        addFilterChip(filterSuggestions[0].value);
        return;
      }
      if (filterInput.includes(':')) {
        e.preventDefault();
        addFilterChip(filterInput);
      }
    }
    if (e.key === 'Backspace' && !filterInput && filterChips.length > 0) {
      removeFilterChip(filterChips[filterChips.length - 1].id);
    }
  };

  const toggleLayoutLock = () => {
    if (isDraggable) {
      setIsDraggable(false);
      saveDashboardLayout(pendingLayout).catch((err) => console.error('Failed to save dashboard layout:', err));
      return;
    }

    setIsDraggable(true);
  };

  const scheduleAiSidebarWidth = (nextWidth) => {
    const clampedWidth = clampAiSidebarWidth(nextWidth);
    if (aiSidebarFrameRef.current) cancelAnimationFrame(aiSidebarFrameRef.current);
    aiSidebarFrameRef.current = requestAnimationFrame(() => {
      aiSidebarWidthRef.current = clampedWidth;
      setAiSidebarWidth(clampedWidth);
      aiSidebarFrameRef.current = null;
    });
  };

  const beginAiSidebarResize = (event) => {
    if (window.innerWidth <= AI_SIDEBAR_MOBILE_BREAKPOINT) return;

    event.preventDefault();
    document.body.classList.add('ai-sidebar-resizing');

    const updateWidth = (clientX) => {
      scheduleAiSidebarWidth(window.innerWidth - clientX);
    };

    const handlePointerMove = (moveEvent) => {
      moveEvent.preventDefault();
      updateWidth(moveEvent.clientX);
    };

    const stopResize = () => {
      document.body.classList.remove('ai-sidebar-resizing');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
      localStorage.setItem(AI_SIDEBAR_WIDTH_KEY, String(aiSidebarWidthRef.current));
    };

    updateWidth(event.clientX);
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  };

  const resetAiSidebarWidth = () => {
    setAiSidebarWidth(clampAiSidebarWidth(AI_SIDEBAR_DEFAULT_WIDTH));
  };

  if (authLoading || (authUser && !isAdminRoute && !layoutReady)) {
    return (
      <div className={`flex h-screen items-center justify-center ${theme === 'dark' ? 'bg-black text-zinc-100' : 'bg-white text-zinc-900'}`}>
        <span className="text-sm font-black uppercase tracking-[0.2em] text-emerald-500">Loading</span>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="login-shell min-h-screen overflow-hidden bg-[#020712] text-zinc-100">
        <div className="login-grid-overlay"></div>
        <div className="login-scanline"></div>
        <div className="login-orbit login-orbit-one"></div>
        <div className="login-orbit login-orbit-two"></div>
        <div className="login-streak login-streak-one"></div>
        <div className="login-streak login-streak-two"></div>

        <div className="relative z-10 flex min-h-screen items-center justify-center px-5 py-10">
          <div className="login-panel-wrap w-full max-w-[460px]">
            <div className="mb-6 flex items-center justify-between px-1">
              <div className="flex items-center gap-3">
                <div className="login-status-dot"></div>
                <span className="text-[11px] font-black uppercase tracking-[0.34em] text-blue-100/80">Elite NOC Access</span>
              </div>
              <span className="rounded-full border border-yellow-300/30 bg-yellow-300/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.22em] text-yellow-100">Secure</span>
            </div>

            <form onSubmit={login} className="login-card rounded-[28px] border border-yellow-300/25 bg-blue-950/45 p-7 shadow-2xl backdrop-blur-xl sm:p-8">
              <div className="mb-8">
                <div className="mb-5 h-px w-full bg-gradient-to-r from-transparent via-yellow-300/60 to-transparent"></div>
                <h1 className="login-title whitespace-nowrap text-[clamp(1.55rem,6vw,2rem)] leading-none text-white">
                  alteon ai noc <span className="login-version">v5.104</span>
                </h1>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span className="text-xs font-black uppercase tracking-[0.28em] text-yellow-100">Secure Operations Portal</span>
                  <span className="h-1 w-1 rounded-full bg-yellow-300 shadow-[0_0_14px_rgba(250,204,21,0.85)]"></span>
                  <span className="text-[10px] font-bold uppercase tracking-[0.24em] text-blue-200/55">Authenticated NOC Access</span>
                </div>
              </div>

              <div className="grid gap-4">
                <label className="grid gap-2">
                  <span className="text-[10px] font-black uppercase tracking-[0.24em] text-blue-200/55">Username</span>
                  <input
                    value={loginUsername}
                    onChange={(e) => setLoginUsername(e.target.value)}
                    placeholder="Enter username"
                    className="login-input h-12 rounded-2xl border border-blue-100/10 bg-blue-950/55 px-4 text-sm font-bold text-zinc-100 outline-none transition-all placeholder:text-blue-200/35 focus:border-yellow-300/75 focus:shadow-[0_0_0_3px_rgba(250,204,21,0.13),0_0_30px_rgba(37,99,235,0.26)]"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-[10px] font-black uppercase tracking-[0.24em] text-blue-200/55">Password</span>
                  <input
                    value={loginPassword}
                    onChange={(e) => setLoginPassword(e.target.value)}
                    placeholder="Enter password"
                    type="password"
                    className="login-input h-12 rounded-2xl border border-blue-100/10 bg-blue-950/55 px-4 text-sm font-bold text-zinc-100 outline-none transition-all placeholder:text-blue-200/35 focus:border-yellow-300/75 focus:shadow-[0_0_0_3px_rgba(250,204,21,0.13),0_0_30px_rgba(37,99,235,0.26)]"
                  />
                </label>

                {loginError && <div className="rounded-2xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-200">{loginError}</div>}

                <button type="submit" className="login-button mt-2 h-12 rounded-2xl px-6 text-sm font-black uppercase tracking-[0.22em] text-slate-950 shadow-lg transition-all active:translate-y-px">
                  Login
                </button>
              </div>

              <div className="mt-7 grid grid-cols-3 gap-3 border-t border-yellow-300/15 pt-5 text-[10px] font-black uppercase tracking-[0.2em] text-blue-200/45">
                <span>Encrypted</span>
                <span className="text-center text-blue-200/75">Monitored</span>
                <span className="text-right text-yellow-200/80">Controlled</span>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (isAdminRoute) {
    if (authUser.role !== 'admin') {
      return <AdminForbiddenPage theme={theme} onLogout={logout} />;
    }
    return <AdminPage theme={theme} authUser={authUser} onLogout={logout} />;
  }

  return (
    <div
      className={`dashboard-root flex h-screen overflow-hidden ${theme === 'dark' ? 'dashboard-shell bg-[#020616] text-zinc-100' : 'dashboard-shell-light bg-slate-50 text-zinc-900'}`}
      style={{ '--ai-sidebar-width': `${aiSidebarWidth}px` }}
    >

      <style>{`
        .grid-card {
          background: ${theme === 'dark' ? 'rgba(7, 25, 69, 0.46)' : 'white'};
          border: 1px solid ${theme === 'dark' ? 'rgba(250, 204, 21, 0.18)' : '#e4e4e7'};
          border-radius: 20px;
          overflow: hidden;
          backdrop-filter: blur(16px);
          box-shadow: ${theme === 'dark' ? '0 22px 70px rgba(0,0,0,0.42), 0 0 36px rgba(37,99,235,0.12)' : '0 12px 32px rgba(15,23,42,0.08)'};
        }
        .digital-clock { font-family: 'JetBrains Mono', monospace; }
        .custom-scrollbar {
          scrollbar-width: thin;
          scrollbar-color: ${theme === 'dark' ? 'rgba(250,204,21,0.55)' : '#d4d4d8'} transparent;
        }
        .custom-scrollbar::-webkit-scrollbar {
          width: 2px;
          height: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: ${theme === 'dark' ? 'rgba(96,165,250,0.08)' : 'rgba(228, 228, 231, 0.08)'};
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: ${theme === 'dark' ? 'rgba(250,204,21,0.55)' : '#d4d4d8'};
          border-radius: 10px;
        }

        .toolbar-element {
          background: ${theme === 'dark' ? 'linear-gradient(135deg, rgba(7,25,69,0.78), rgba(11,42,120,0.48))' : 'white'};
          border: 1px solid ${theme === 'dark' ? 'rgba(250,204,21,0.22)' : '#d4d4d8'};
          color: ${theme === 'dark' ? '#f8fafc' : '#18181b'};
          border-radius: 12px;
          height: 42px;
          font-size: 14px;
          font-weight: 400;
          outline: none;
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0 16px;
          box-shadow: ${theme === 'dark' ? '0 10px 28px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.08)' : 'none'};
        }
        .toolbar-element:hover {
          border-color: ${theme === 'dark' ? 'rgba(250,204,21,0.5)' : '#a1a1aa'};
          background: ${theme === 'dark' ? 'linear-gradient(135deg, rgba(29,78,216,0.55), rgba(250,204,21,0.14))' : '#f4f4f5'};
        }
      `}</style>

      <main ref={dashboardMainRef} className="dashboard-main min-w-0 flex-1 overflow-y-auto relative custom-scrollbar px-10 pb-10 pt-10">

        <div className="dashboard-sticky-controls" data-sticky-compact="0">
        {/* BRANDING (v4.2) & CLOCK */}
        <div className="dashboard-header flex justify-between items-center mb-10">
          <div className="dashboard-brand-lockup flex items-center gap-5">
            <div className="dashboard-radware-logo-wrap" aria-label="Radware">
              <img
                src={theme === 'dark' ? '/brand/radware-logo-white.png' : '/brand/radware-logo-dark.png'}
                alt="Radware"
                className="dashboard-radware-logo"
              />
              <span className="radware-logo-pulse-dot radware-logo-pulse-dot--red" aria-hidden="true"></span>
              <span className="radware-logo-pulse-dot radware-logo-pulse-dot--yellow" aria-hidden="true"></span>
              <span className="radware-logo-pulse-dot radware-logo-pulse-dot--green" aria-hidden="true"></span>
            </div>
            <div className={`dashboard-brand-divider ${theme === 'dark' ? 'is-dark' : 'is-light'}`}></div>
            <div className="flex flex-col">
              <h1 className={`dashboard-title text-3xl ${theme === 'dark' ? 'text-white' : 'text-black'}`}>alteon ai noc v5.104</h1>
              <span className={`font-bold text-sm tracking-widest uppercase mt-1 ${theme === 'dark' ? 'text-yellow-100' : 'text-blue-700'}`}>Network Performance & Intelligence</span>
            </div>
          </div>

          <div className="flex flex-col items-end">
            <span className={`digital-clock text-3xl font-black ${theme === 'dark' ? 'text-zinc-100' : 'text-zinc-900'}`}>
              {now.getHours().toString().padStart(2, '0')}:{now.getMinutes().toString().padStart(2, '0')}:
              <span className={theme === 'dark' ? 'text-yellow-200' : 'text-blue-700'}>{now.getSeconds().toString().padStart(2, '0')}</span>
            </span>
            <span className={`text-[10px] font-black uppercase tracking-widest ${theme === 'dark' ? 'text-blue-100/55' : 'text-zinc-500'}`}>System Time</span>
          </div>
        </div>

        {/* DASHBOARD CONTROLS */}
        <div className="flex justify-center mb-12">
          <div className="dashboard-toolbar grid w-full max-w-[1480px] gap-4 bg-transparent">
            <div className="flex flex-wrap items-center justify-center gap-4">
              <button
                onClick={toggleLayoutLock}
                className={`toolbar-element whitespace-nowrap uppercase tracking-tighter ${
                  isDraggable ? 'layout-editing' : ''
                }`}
              >
                <img src="/brand/icons/lock-network.png" alt="" className="toolbar-icon" />
                {isDraggable ? 'Unlock' : 'Lock'}
              </button>

              <button onClick={resetLayout} className="toolbar-element whitespace-nowrap uppercase tracking-tighter">
                <img src="/brand/icons/refresh.png" alt="" className="toolbar-icon" />
                Reset
              </button>

              <div className="h-[42px] flex items-center">
                <TimeRange value={activeRange} onChange={handleRangeChange} onRefresh={() => setReloadKey(k => k + 1)} theme={theme} />
              </div>

              <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} className={`theme-toggle h-[42px] px-4 rounded-xl border transition-all text-xl ${theme === 'dark' ? 'bg-blue-950/70 border-yellow-300/25 text-yellow-100 hover:border-yellow-300/60' : 'bg-white border-zinc-300 text-zinc-900 hover:bg-zinc-100'}`} title="Toggle theme">
                <img src="/brand/icons/status-dot.png" alt="" className="toolbar-icon toolbar-icon-only" />
              </button>

              {authUser.role === 'admin' && (
                <a href="/admin" className="toolbar-element whitespace-nowrap uppercase tracking-tighter">
                  <img src="/brand/icons/settings-window.png" alt="" className="toolbar-icon" />
                  Admin
                </a>
              )}

              <button onClick={logout} className="toolbar-element whitespace-nowrap uppercase tracking-tighter">
                <img src="/brand/icons/shield-server.png" alt="" className="toolbar-icon" />
                Logout
              </button>
            </div>

            <div className={`dashboard-smart-filter border-t pt-4 ${theme === 'dark' ? 'border-yellow-300/15' : 'border-zinc-300'}`}>
              <span className="dashboard-smart-filter-title">Smart Filters</span>
              <div className={`dashboard-smart-filter-input-wrap ${theme === 'dark' ? 'is-dark' : 'is-light'}`}>
                {filterChips.map((chip) => (
                  <button
                    type="button"
                    key={chip.id}
                    onClick={() => removeFilterChip(chip.id)}
                    className={`dashboard-filter-chip ${chip.field === 'geo_country' ? 'dashboard-filter-chip--geo' : ''}`}
                    title={String(chip.titleValue || chip.value || 'Remove filter')}
                  >
                    <strong>{chip.sourceField}</strong>
                    <span>{chip.operator}</span>
                    <em title={String(chip.titleValue || chip.value || '')}>
                      {chip.field === 'geo_country' ? (
                        <span className="dashboard-geo-chip-content">
                          <GeoFlag countryCode={chip.countryCode} fallbackFlag={chip.fallbackFlag} />
                          <span className="dashboard-geo-chip-text">{chip.displayText || chip.displayValue || chip.value}</span>
                        </span>
                      ) : (chip.displayValue || chip.value)}
                    </em>
                    <i>×</i>
                  </button>
                ))}
                <input
                  value={filterInput}
                  onChange={(e) => {
                    const value = e.target.value;
                    setFilterInput(value);
                    const key = String(value || '').trim().toLowerCase();
                    if (!key.includes(':')) {
                      const inferred = FILTER_KEYWORDS.find((item) => item.startsWith(key)) || '';
                      setActiveFilterType(inferred || '');
                    }
                    setShowSuggestions(true);
                  }}
                  ref={filterInputRef}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
                  onKeyDown={onFilterInputKeyDown}
                  placeholder="Type filters: service:, alteon:, client:, status:, server:, latency:, uri:, method:, user-agent:, geo:"
                  className="dashboard-smart-filter-input"
                />
              </div>
              <div className="dashboard-filter-actions">
                <div className="dashboard-filter-shortcuts">
                  {FILTER_SHORTCUTS.map((shortcut) => (
                    <button
                      key={shortcut.id}
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); handleFilterTypeShortcut(shortcut.id); }}
                      className={`dashboard-filter-shortcut ${activeFilterType === shortcut.id ? 'is-active' : ''} ${theme === 'dark' ? 'is-dark' : 'is-light'}`}
                    >
                      {shortcut.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className={`dashboard-filter-clear ${theme === 'dark' ? 'is-dark' : 'is-light'}`}
                  onClick={clearSmartFilters}
                >
                  CLEAR
                </button>
              </div>

              {showSuggestions && filterSuggestions.length > 0 && (
                <div className={`dashboard-filter-suggestions ${theme === 'dark' ? 'is-dark' : 'is-light'}`}>
                  {filterSuggestions.map((item) => (
                    <button
                      key={`${item.type}:${item.value}`}
                      type="button"
                      className={`dashboard-filter-suggestion-item ${activeFilterType === 'geo' ? 'dashboard-filter-suggestion-item--geo' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (item.value.endsWith(':')) {
                          setFilterInput(item.value);
                          setShowSuggestions(true);
                        } else {
                          addFilterChip(item.chip || item.value);
                        }
                      }}
                    >
                      {activeFilterType === 'geo' ? (
                        <span className="dashboard-geo-suggestion-content">
                          <GeoFlag countryCode={item.countryCode} fallbackFlag={item.fallbackFlag} />
                          <span className="dashboard-geo-suggestion-text">{item.displayText || item.label}</span>
                        </span>
                      ) : item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        </div>

        {/* KPI CARDS */}
        <div className="grid grid-cols-4 gap-8 mb-10">
          <KpiCard title="Throughput" value={kpis.throughput} unit="Mbps" color={theme === 'dark' ? '#81ebf3' : '#017a97'} theme={theme} icon="/brand/icons/network-globe.png" />
          <KpiCard title="Requests" value={kpis.rps} unit="Total" color={theme === 'dark' ? '#f26b43' : '#c5192e'} theme={theme} icon="/brand/icons/target.png" />
          <KpiCard title="Errors" value={kpis.errorRate} unit="%" color="#ed1c24" theme={theme} icon="/brand/icons/shield-server.png" />
          <KpiCard title="Latency" value={kpis.latency} unit="ms" color={theme === 'dark' ? '#5acbf0' : '#328096'} theme={theme} icon="/brand/icons/settings-window.png" />
        </div>

        <ResponsiveGridLayout
          key={isDraggable ? 'layout-edit' : 'layout-locked'}
          className={isDraggable ? 'layout layout-edit' : 'layout layout-locked'}
          layouts={{ lg: layout }}
          breakpoints={{ lg: 1200, md: 996 }}
          cols={{ lg: 12, md: 10 }}
          rowHeight={80}
          draggableHandle=".drag-handle"
          draggableCancel=".react-resizable-handle"
          isDraggable={isDraggable}
          isResizable={isDraggable}
          resizeHandles={['se']}
          onLayoutChange={(current) => {
            if (!layoutReady || isHydratingLayoutRef.current) return;
            const nextLayout = normalizeLayout(current);
            setPendingLayout(nextLayout);
            if (isDraggable) setLayout(nextLayout);
          }}
          margin={[25, 25]}
        >
          <div key="traffic" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TimeChart title="Traffic Flow" endpoint="/api/traffic" reloadKey={reloadKey} query={dashboardQuery} yLabel="Mbps" series={[{ key: 'inbound_mbps', label: 'inbound', color: '#81EBF3' }, { key: 'outbound_mbps', label: 'outbound', color: '#ED1C24' }]} /></div>
          <div key="transaction" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TimeChart title="Performance Metrics" endpoint="/api/transaction-time" reloadKey={reloadKey} query={dashboardQuery} yLabel="ms" series={[{ key: 'end_to_end_ms', label: 'total', color: '#ED1C24' }, { key: 'client_to_alteon_ms', color: '#5ACBF0' }, { key: 'alteon_processing_ms', color: '#203A49' }, { key: 'alteon_to_server_ms', color: '#41AAC1' }, { key: 'server_process_ms', color: '#F26B43' }, { key: 'response_transfer_ms', color: '#017A97' }]} /></div>
          <div key="timeline" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TimeChart title="Health Timeline" endpoint="/api/status-codes-time" reloadKey={reloadKey} query={dashboardQuery} yLabel="Count" series={[{ key: 's2xx', label: '2xx', color: '#81EBF3' }, { key: 's3xx', label: '3xx', color: '#41AAC1' }, { key: 's4xx', label: '4xx', color: '#ED1C24' }, { key: 's5xx', label: '5xx', color: '#C5192E' }]} /></div>
          <div key="latency" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TimeChart title="Client Latency" endpoint="/api/latency-time" reloadKey={reloadKey} query={dashboardQuery} yLabel="ms" series={[{ key: 'avg_ms', label: 'avg', color: '#5ACBF0' }]} /></div>
          <div key="rps" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TimeChart title="HTTP Requests / Sec" endpoint="/api/rps-time" reloadKey={reloadKey} query={dashboardQuery} yLabel="RPS" series={[{ key: 'rps', label: 'RPS', color: '#ED1C24' }]} /></div>
          <div key="rs" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Top Real Servers" endpoint="/api/top-rs" reloadKey={reloadKey} query={dashboardQuery} nameKey="rs" valueKey="count" /></div>
          <div key="methods" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><CategoryChart title="HTTP Methods" endpoint="/api/categories" reloadKey={reloadKey} query={dashboardQuery} nameKey="method" valueKey="count" /></div>
          <div key="codes" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><CategoryChart title="Status Codes" endpoint="/api/response-codes" reloadKey={reloadKey} query={dashboardQuery} nameKey="code" valueKey="count" /></div>
          <div key="clients" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Top Clients" endpoint="/api/top-clients" reloadKey={reloadKey} query={dashboardQuery} nameKey="ip" valueKey="count" /></div>
          <div key="urls" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Top Endpoints" endpoint="/api/top-endpoints" reloadKey={reloadKey} query={dashboardQuery} nameKey="url" valueKey="count" /></div>
          <div key="bandwidth" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Top Bandwidth Consumers" endpoint="/api/top-bandwidth-consumers" reloadKey={reloadKey} query={dashboardQuery} nameKey="ip" valueKey="requests" secondaryKey="total_bytes" secondaryLabel="Bandwidth" valueLabel="Requests" formatSecondary={(value) => formatBytes(value)} hideSecondarySeverity /></div>
          <div key="bandwidthApps" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="TOP SERVICES" endpoint="/api/top-bandwidth-applications" reloadKey={reloadKey} query={dashboardQuery} nameKey="application" valueKey="requests" secondaryKey="total_bytes" secondaryLabel="BANDWIDTH" tertiaryKey="avg_mbps" tertiaryLabel="AVG SPEED" quaternaryKey="rps" quaternaryLabel="RPS" quinaryKey="avg_latency_ms" quinaryLabel="AVG LATENCY" formatSecondary={(value) => formatBytes(value)} formatTertiary={(value) => `${Number(value || 0).toFixed(2)} Mbps`} formatQuaternary={(value) => `${Number(value || 0).toFixed(2)} req/s`} formatQuinary={(value) => `${Number(value || 0).toFixed(1)} ms`} primaryValueClassName="text-zinc-600 font-mono font-normal w-20 text-right" valueLabel="REQUESTS" hideSecondarySeverity hideTertiarySeverity hideQuaternarySeverity hideQuinarySeverity /></div>
          <div key="serviceFlow" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div>{USE_SERVICE_FLOW_PROTOTYPE ? <ServiceFlowPrototype reloadKey={reloadKey} query={dashboardQuery} onLatencyExpandedChange={handleServiceFlowLatencyExpandedChange} /> : <ServiceFlow reloadKey={reloadKey} query={dashboardQuery} />}</div>
          <div key="serviceErrors" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Service Error Rate" endpoint="/api/top-service-errors" reloadKey={reloadKey} query={dashboardQuery} nameKey="service" valueKey="requests" secondaryKey="error_rate" secondaryLabel="ERROR %" tertiaryKey="s5xx" tertiaryLabel="5XX" quaternaryKey="s4xx" quaternaryLabel="4XX" formatSecondary={formatPercent} valueLabel="REQUESTS" secondaryHighThreshold={5} hideTertiarySeverity hideQuaternarySeverity /></div>
          <div key="realServerBandwidth" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Real Server Bandwidth" endpoint="/api/top-real-servers-bandwidth" reloadKey={reloadKey} query={dashboardQuery} nameKey="real_server" valueKey="requests" secondaryKey="total_bytes" secondaryLabel="BANDWIDTH" tertiaryKey="avg_mbps" tertiaryLabel="AVG SPEED" quaternaryKey="avg_latency_ms" quaternaryLabel="AVG LATENCY" formatSecondary={(value) => formatBytes(value)} formatTertiary={(value) => `${Number(value || 0).toFixed(2)} Mbps`} formatQuaternary={(value) => `${Number(value || 0).toFixed(1)} ms`} valueLabel="REQUESTS" hideSecondarySeverity hideTertiarySeverity hideQuaternarySeverity /></div>
          <div key="virtualServices" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Top Virtual Services" endpoint="/api/top-virtual-services" reloadKey={reloadKey} query={dashboardQuery} nameKey="virtual_service" valueKey="requests" secondaryKey="avg_latency_ms" secondaryLabel="AVG LATENCY" tertiaryKey="total_bytes" tertiaryLabel="BANDWIDTH" formatSecondary={(value) => `${Number(value || 0).toFixed(1)} ms`} formatTertiary={(value) => formatBytes(value)} valueLabel="REQUESTS" hideSecondarySeverity hideTertiarySeverity /></div>
          <div key="geoCountries" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Geo Countries" endpoint="/api/geo-countries" reloadKey={reloadKey} query={dashboardQuery} nameKey="country_name" valueKey="requests" secondaryKey="total_bytes" secondaryLabel="BANDWIDTH" tertiaryKey="unique_clients" tertiaryLabel="CLIENTS" formatSecondary={(value) => formatBytes(value)} valueLabel="REQUESTS" hideSecondarySeverity hideTertiarySeverity renderName={(item) => (<span className="top-list-geo-label"><GeoFlag countryCode={item.country_code} fallbackFlag={item.flag} className="top-list-geo-flag" /><span className="top-list-geo-country-name">{item.country_name || item.country_label || item.country_code}</span></span>)} /></div>
          <div key="userAgents" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Top User Agents" endpoint="/api/top-user-agents" reloadKey={reloadKey} query={dashboardQuery} nameKey="user_agent" valueKey="requests" secondaryKey="avg_latency_ms" secondaryLabel="AVG LATENCY" tertiaryKey="error_rate_pct" tertiaryLabel="ERROR %" formatSecondary={(value) => `${Number(value || 0).toFixed(1)} ms`} formatTertiary={formatPercent} valueLabel="REQUESTS" secondaryHighThreshold={500} hideTertiarySeverity /></div>
          <div key="contentTypes" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><CategoryChart title="Content Types" endpoint="/api/content-types" reloadKey={reloadKey} query={dashboardQuery} nameKey="content_type" valueKey="count" /></div>
          <div key="forwardedClients" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Forwarded Clients" endpoint="/api/top-forwarded-clients" reloadKey={reloadKey} query={dashboardQuery} nameKey="xff" valueKey="requests" secondaryKey="unique_clients" secondaryLabel="CLIENTS" tertiaryKey="avg_latency_ms" tertiaryLabel="AVG LATENCY" formatTertiary={(value) => `${Number(value || 0).toFixed(1)} ms`} valueLabel="REQUESTS" hideSecondarySeverity hideTertiarySeverity /></div>
          <div key="httpVersions" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><CategoryChart title="HTTP Versions" endpoint="/api/http-versions" reloadKey={reloadKey} query={dashboardQuery} nameKey="version" valueKey="count" /></div>
          <div key="serverRtt" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Server RTT" endpoint="/api/server-rtt" reloadKey={reloadKey} query={dashboardQuery} nameKey="server_target" valueKey="requests" secondaryKey="avg_rtt_ms" secondaryLabel="AVG RTT" tertiaryKey="p95_rtt_ms" tertiaryLabel="P95 RTT" quaternaryKey="max_rtt_ms" quaternaryLabel="MAX RTT" formatSecondary={(value) => `${Number(value || 0).toFixed(1)} ms`} formatTertiary={(value) => `${Number(value || 0).toFixed(1)} ms`} formatQuaternary={(value) => `${Number(value || 0).toFixed(1)} ms`} valueLabel="REQUESTS" hideSecondarySeverity hideTertiarySeverity hideQuaternarySeverity /></div>
          <div key="eventSeverity" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><CategoryChart title="Event Severity" endpoint="/api/event-severity" reloadKey={reloadKey} query={dashboardQuery} nameKey="severity" valueKey="count" /></div>
          <div key="egressPaths" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Egress Paths" endpoint="/api/egress-paths" reloadKey={reloadKey} query={dashboardQuery} nameKey="path" valueKey="requests" secondaryKey="avg_rtt_ms" secondaryLabel="AVG RTT" formatSecondary={(value) => `${Number(value || 0).toFixed(1)} ms`} valueLabel="REQUESTS" hideSecondarySeverity /></div>
          <div key="alteonObjects" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><TopListChart title="Alteon Objects" endpoint="/api/alteon-objects" reloadKey={reloadKey} query={dashboardQuery} nameKey="object_name" valueKey="requests" secondaryKey="unique_servers" secondaryLabel="UNIQ SERVERS" valueLabel="REQUESTS" hideSecondarySeverity renderName={(item) => (<span className="truncate" title={[item.object_id, item.app_id, item.group_id].filter(Boolean).join(' · ') || item.object_name}>{item.object_name || item.object_id || item.app_id || item.group_id || 'Unknown object'}</span>)} /></div>
          <div key="appOutcomes" className="grid-card shadow-2xl"><div className={`drag-handle h-4 w-full ${isDraggable ? 'bg-yellow-300/25 cursor-grab' : ''}`}></div><CategoryChart title="App Outcomes" endpoint="/api/app-outcomes" reloadKey={reloadKey} query={dashboardQuery} nameKey="label" valueKey="count" /></div>
        </ResponsiveGridLayout>
      </main>

      <aside className="dashboard-ai-panel flex-shrink-0 z-20 shadow-2xl">
        <button
          type="button"
          className="ai-sidebar-resize-handle"
          aria-label="Resize AI sidebar"
          title="Drag to resize. Double-click to reset."
          onPointerDown={beginAiSidebarResize}
          onDoubleClick={resetAiSidebarWidth}
        />
        <AiAssistant theme={theme} />
      </aside>

    </div>
  );
}
