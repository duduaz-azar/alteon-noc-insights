import { useState, useEffect } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4'];

export default function CategoryChart({ title, endpoint, reloadKey, nameKey, valueKey, query }) {
  const [data, setData] = useState([]);
  const [hiddenKeys, setHiddenKeys] = useState([]);
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

  const toggleKey = (e) => {
    const key = e.value;
    setHiddenKeys(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const legendPayload = data.map((item, index) => ({
    value: item[nameKey], type: 'circle', id: item[nameKey],
    color: hiddenKeys.includes(item[nameKey]) ? '#cbd5e1' : COLORS[index % COLORS.length],
    payload: item
  }));

  const chartData = data.filter(item => !hiddenKeys.includes(item[nameKey]));
  const stateMessage = loading
    ? 'Loading...'
    : error
      ? error
      : data.length === 0
        ? 'No data for selected range.'
        : '';

  return (
    <div className="bg-transparent border border-zinc-200 rounded-xl p-4 h-full min-h-0 shadow-sm flex flex-col">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-zinc-800 font-bold text-sm">{title}</h3>
      </div>
      <div className="flex-1 min-h-0">
        {stateMessage ? (
          <div className={`h-full flex items-center justify-center text-sm font-medium ${error ? 'text-red-500' : 'text-zinc-500'}`}>
            <span className={loading ? 'animate-pulse' : ''}>{stateMessage}</span>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie data={chartData} innerRadius={60} outerRadius={80} paddingAngle={chartData.length > 1 ? 5 : 0} dataKey={valueKey} nameKey={nameKey} stroke="none">
                {chartData.map((entry, index) => {
                  const originalIndex = data.findIndex(d => d[nameKey] === entry[nameKey]);
                  return <Cell key={`cell-${index}`} fill={COLORS[originalIndex % COLORS.length]} />;
                })}
              </Pie>
              <Tooltip contentStyle={{ borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '12px' }} />
              <Legend onClick={toggleKey} payload={legendPayload} layout="vertical" align="right" verticalAlign="middle" iconType="circle" wrapperStyle={{ fontSize: '11px', cursor: 'pointer' }}
                formatter={(value) => {
                  const item = data.find(d => d[nameKey] === value);
                  const isHidden = hiddenKeys.includes(value);
                  return <span style={{ color: isHidden ? '#cbd5e1' : '#334155', textDecoration: isHidden ? 'line-through' : 'none' }}>{value}: <span className="ml-1 font-mono text-zinc-400">{item?.[valueKey]?.toLocaleString()}</span></span>
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
