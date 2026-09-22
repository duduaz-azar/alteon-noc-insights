import { useState, useEffect } from 'react';

export default function TopListChart({
  title,
  endpoint,
  reloadKey,
  nameKey,
  valueKey,
  query,
  secondaryKey = 'avg_ms',
  secondaryLabel = 'Latency',
  valueLabel = 'Requests',
  formatSecondary = null,
  formatValue = null,
  primaryValueClassName = 'text-zinc-600 font-mono font-bold w-20 text-right',
  secondaryHighThreshold = 500,
  hideSecondarySeverity = false,
  tertiaryKey = null,
  tertiaryLabel = '',
  formatTertiary = null,
  hideTertiarySeverity = true,
  quaternaryKey = null,
  quaternaryLabel = '',
  formatQuaternary = null,
  hideQuaternarySeverity = true,
  quinaryKey = null,
  quinaryLabel = '',
  formatQuinary = null,
  hideQuinarySeverity = true,
  renderName = null,
}) {
  const [data, setData] = useState([]);
  const [hiddenKeys, setHiddenKeys] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);
      setError('');
      setMessage('');
      try {
        const response = await fetch(`${endpoint}?${query}`);
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const result = await response.json();
        if (active) {
          if (Array.isArray(result)) {
            setData(result);
            setMessage('');
          } else {
            setData(Array.isArray(result?.items) ? result.items : []);
            setMessage(String(result?.message || result?.geo_message || '').trim());
          }
        }
      } catch (e) {
        if (active) {
          setData([]);
          setMessage('');
          setError('Failed to load data.');
        }
        console.error(e);
      } finally {
        if (active) setLoading(false);
      }
    };

    load();
    return () => {
      active = false;
    };
  }, [endpoint, reloadKey, query]);

  const toggleKey = (key) => setHiddenKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);

  const formatLatency = (ms) => {
    const numeric = Number(ms || 0);
    return numeric >= 1000 ? `${(numeric / 1000).toFixed(2)}s` : `${Math.round(numeric)}ms`;
  };

  const defaultFormatValue = (value) => Number(value || 0).toLocaleString();
  const formatSecondaryValue = (value) => {
    if (typeof formatSecondary === 'function') return formatSecondary(value);
    return formatLatency(value);
  };

  const formatPrimaryValue = (value) => {
    if (typeof formatValue === 'function') return formatValue(value);
    return defaultFormatValue(value);
  };

  const formatTertiaryValue = (value) => {
    if (typeof formatTertiary === 'function') return formatTertiary(value);
    return defaultFormatValue(value);
  };

  const formatQuaternaryValue = (value) => {
    if (typeof formatQuaternary === 'function') return formatQuaternary(value);
    return defaultFormatValue(value);
  };

  const formatQuinaryValue = (value) => {
    if (typeof formatQuinary === 'function') return formatQuinary(value);
    return defaultFormatValue(value);
  };

  const maxValue = data.length > 0 ? Math.max(...data.map((d) => Number(d[valueKey] || 0))) : 1;
  const stateMessage = loading
    ? 'Loading...'
    : error
      ? error
      : data.length === 0
        ? (message || 'No data for selected range.')
        : '';

  return (
    <div className="bg-transparent border border-zinc-200 rounded-xl p-4 h-full min-h-0 shadow-sm flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-zinc-800 font-normal text-sm">{title}</h3>
        <div className="flex gap-4 text-[10px] uppercase tracking-wider text-zinc-400 font-normal">
          <span className="w-24 text-center">{secondaryLabel}</span>
          {tertiaryKey ? <span className="w-24 text-center">{tertiaryLabel}</span> : null}
          {quaternaryKey ? <span className="w-24 text-center">{quaternaryLabel}</span> : null}
          {quinaryKey ? <span className="w-24 text-center">{quinaryLabel}</span> : null}
          <span className="w-20 text-center">{valueLabel}</span>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
        {stateMessage ? (
          <div className={`h-full flex items-center justify-center text-sm font-medium ${error ? 'text-red-500' : 'text-zinc-500'}`}>
            <span className={loading ? 'animate-pulse' : ''}>{stateMessage}</span>
          </div>
        ) : (
          data.map((item, i) => {
            const key = item[nameKey];
            const val = Number(item[valueKey] || 0);
            const countryCode = String(item?.country_code || '').trim().toUpperCase();
            const hasFlagIcon = /^[A-Z]{2}$/.test(countryCode);
            const fallbackFlag = String(item?.flag || '').trim();
            const displayLabel = hasFlagIcon ? String(item?.country_name || key || '') : String(key || '');
            const secondary = Number(item[secondaryKey] || 0);
            const tertiary = tertiaryKey ? Number(item[tertiaryKey] || 0) : null;
            const quaternary = quaternaryKey ? Number(item[quaternaryKey] || 0) : null;
            const quinary = quinaryKey ? Number(item[quinaryKey] || 0) : null;
            const isHidden = hiddenKeys.includes(key);
            const percentage = maxValue > 0 ? (val / maxValue) * 100 : 0;
            const isHighSecondary = !hideSecondarySeverity && secondary > secondaryHighThreshold;
            const isHighTertiary = Boolean(tertiaryKey) && !hideTertiarySeverity && Number(tertiary || 0) > secondaryHighThreshold;
            const isHighQuaternary = Boolean(quaternaryKey) && !hideQuaternarySeverity && Number(quaternary || 0) > secondaryHighThreshold;
            const isHighQuinary = Boolean(quinaryKey) && !hideQuinarySeverity && Number(quinary || 0) > secondaryHighThreshold;

            const renderedName = typeof renderName === 'function' ? renderName(item) : null;

            return (
              <div key={i} onClick={() => toggleKey(key)} className={`group cursor-pointer transition-all ${isHidden ? 'opacity-30' : 'opacity-100'}`}>
                <div className="flex justify-between items-center text-[11px] mb-1.5">
                  {renderedName ? (
                    <span title={String(item?.country_name || key || '')} className={`truncate flex flex-1 items-center gap-2 pr-4 ${isHidden ? 'line-through text-zinc-400' : 'text-zinc-700 font-normal'}`}>{renderedName}</span>
                  ) : (
                    <span title={String(key || '')} className={`truncate flex flex-1 items-center gap-2 pr-4 ${hasFlagIcon || fallbackFlag ? 'font-sans top-list-flag-label tracking-normal' : 'font-mono'} ${isHidden ? 'line-through text-zinc-400' : 'text-zinc-700 font-normal'}`}>
                      {hasFlagIcon ? <span aria-hidden="true" className={`fi fi-${countryCode.toLowerCase()} top-list-flag-icon`} /> : (fallbackFlag ? <span aria-hidden="true" className="top-list-flag-fallback">{fallbackFlag}</span> : null)}
                      <span className="min-w-0 truncate">{displayLabel}</span>
                    </span>
                  )}
                  <div className="flex gap-4 items-center shrink-0">
                    <span className={`font-mono px-1.5 py-0.5 rounded w-24 text-right ${isHighSecondary ? 'bg-red-50 text-red-600' : 'bg-zinc-50 text-zinc-500'}`}>{formatSecondaryValue(secondary)}</span>
                    {tertiaryKey ? (
                      <span className={`font-mono px-1.5 py-0.5 rounded w-24 text-right ${isHighTertiary ? 'bg-red-50 text-red-600' : 'bg-zinc-50 text-zinc-500'}`}>{formatTertiaryValue(tertiary)}</span>
                    ) : null}
                    {quaternaryKey ? (
                      <span className={`font-mono px-1.5 py-0.5 rounded w-24 text-right ${isHighQuaternary ? 'bg-red-50 text-red-600' : 'bg-zinc-50 text-zinc-500'}`}>{formatQuaternaryValue(quaternary)}</span>
                    ) : null}
                    {quinaryKey ? (
                      <span className={`font-mono px-1.5 py-0.5 rounded w-24 text-right ${isHighQuinary ? 'bg-red-50 text-red-600' : 'bg-zinc-50 text-zinc-500'}`}>{formatQuinaryValue(quinary)}</span>
                    ) : null}
                    <span className={primaryValueClassName}>{formatPrimaryValue(val)}</span>
                  </div>
                </div>
                <div className="w-full bg-zinc-100 h-1.5 rounded-full overflow-hidden">
                  <div className="bg-blue-500 h-full rounded-full transition-all duration-700 ease-out" style={{ width: isHidden ? '0%' : `${percentage}%` }}></div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
