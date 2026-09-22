import { useState, useEffect } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export default function TimeChart({ title, endpoint, reloadKey, yLabel, series, query }) {
  const [data, setData] = useState([]);
  const [hiddenSeries, setHiddenSeries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`${endpoint}?${query}`);
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const result = await response.json();
        if (active) setData(Array.isArray(result) ? result : []);
      } catch (e) {
        if (active) {
          setData([]);
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

  const toggleSeries = (e) => {
    const { dataKey } = e;
    setHiddenSeries(prev => prev.includes(dataKey) ? prev.filter(k => k !== dataKey) : [...prev, dataKey]);
  };

  const stateMessage = loading
    ? 'Loading...'
    : error
      ? error
      : data.length === 0
        ? 'No data for selected range.'
        : '';

  return (
    <div className="bg-transparent border border-zinc-200 rounded-xl p-4 h-full min-h-0 shadow-sm flex flex-col">
      <h3 className="text-zinc-800 font-bold text-sm mb-4">{title}</h3>
      <div className="flex-1 min-h-0">
        {stateMessage ? (
          <div className={`h-full flex items-center justify-center text-sm font-medium ${error ? 'text-red-500' : 'text-zinc-500'}`}>
            <span className={loading ? 'animate-pulse' : ''}>{stateMessage}</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="ts" tick={{fontSize: 10, fill: '#94a3b8'}} tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} axisLine={false} tickLine={false} dy={10} />
              <YAxis tick={{fontSize: 10, fill: '#94a3b8'}} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '12px' }} />
              <Legend onClick={toggleSeries} iconType="circle" wrapperStyle={{ cursor: 'pointer', fontSize: '12px', paddingTop: '20px' }} verticalAlign="bottom" align="center"
                formatter={(value, entry) => {
                  const isHidden = hiddenSeries.includes(entry.dataKey);
                  return <span className={`time-chart-legend-label ${isHidden ? 'is-hidden' : ''}`}>{value}</span>;
                }}
              />
              {series.map(s => <Area key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={s.color} fill={s.color} fillOpacity={0.05} hide={hiddenSeries.includes(s.key)} strokeWidth={2} connectNulls />)}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
