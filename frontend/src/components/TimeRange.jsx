import { useState } from 'react';

export default function TimeRange({ value, onChange, onRefresh, theme }) {
  const presets = [
    { label: '1m', min: 1 },
    { label: '5m', min: 5 },
    { label: '15m', min: 15 },
    { label: '1h', min: 60 },
    { label: '6h', min: 360 },
    { label: '24h', min: 1440 },
    { label: '7d', min: 10080 },
    { label: '30d', min: 43200 },
  ];

  const [isCustomOpen, setIsCustomOpen] = useState(false);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const getCurrentMinutes = () => {
    const minutes = Number(value?.minutes);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 60;
  };

  const formatDateTimeLocal = (date) => {
    const pad = (part) => String(part).padStart(2, '0');
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join('-') + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  };

  const openCustomPicker = () => {
    const minutes = getCurrentMinutes();
    const to = new Date();
    const frm = new Date(to.getTime() - minutes * 60 * 1000);
    setCustomFrom(value?.mode === 'custom' && value.frm ? value.frm : formatDateTimeLocal(frm));
    setCustomTo(value?.mode === 'custom' && value.to ? value.to : formatDateTimeLocal(to));
    setIsCustomOpen(true);
  };

  const closeCustomPicker = () => {
    setIsCustomOpen(false);
  };

  const customFromTime = Date.parse(customFrom);
  const customToTime = Date.parse(customTo);
  const isCustomValid = Boolean(customFrom && customTo && Number.isFinite(customFromTime) && Number.isFinite(customToTime) && customFromTime < customToTime);

  const applyCustomRange = () => {
    if (!isCustomValid) return;
    const minutes = Math.max(1, Math.round((customToTime - customFromTime) / 60000));
    onChange({ mode: 'custom', minutes, frm: customFrom, to: customTo });
    setIsCustomOpen(false);
  };

  const selectPreset = (minutes) => {
    setIsCustomOpen(false);
    onChange({ mode: 'preset', minutes });
  };

  return (
    <div className="timerange-control relative z-[160] flex items-center gap-4">
      {/* Container background forced to dark when theme is dark */}
      <div className={`timerange-presets flex p-1.5 rounded-xl border transition-all duration-300 ${
        theme === 'dark' 
        ? 'bg-zinc-900/80 border-zinc-800 backdrop-blur-md' 
        : 'bg-white border-zinc-200 shadow-sm'
      }`}>
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => selectPreset(p.min)}
            className={`timerange-preset px-4 py-2 rounded-lg text-sm font-normal transition-all ${
              value.mode === 'preset' && value.minutes === p.min
                ? (theme === 'dark' ? 'is-active bg-zinc-800 text-white shadow-lg' : 'is-active bg-zinc-100 text-zinc-900 shadow-sm')
                : (theme === 'dark' ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700')
            }`}
          >
            {p.label}
          </button>
        ))}
        <div className="relative">
          <button
            onClick={openCustomPicker}
            className={`timerange-preset px-4 py-2 rounded-lg text-sm font-normal transition-all ${
              value.mode === 'custom'
                ? (theme === 'dark' ? 'is-active bg-zinc-800 text-white shadow-lg' : 'is-active bg-zinc-100 text-zinc-900 shadow-sm')
                : (theme === 'dark' ? 'text-zinc-500 hover:text-zinc-300' : 'text-zinc-500 hover:text-zinc-700')
            }`}
          >
            custom
          </button>

          {isCustomOpen && (
            <div className={`timerange-custom-panel absolute right-0 top-full mt-3 z-[4200] w-80 rounded-xl border p-4 shadow-2xl ${
              theme === 'dark'
                ? 'bg-zinc-950 border-zinc-800 text-zinc-100'
                : 'bg-white border-zinc-200 text-zinc-900'
            }`}>
              <div className="grid gap-3">
                <label className="grid gap-1 text-[10px] font-black uppercase tracking-widest text-zinc-500">
                  From
                  <input
                    type="datetime-local"
                    step="1"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className={`h-10 rounded-lg border px-3 text-sm font-mono outline-none ${
                      theme === 'dark'
                        ? 'bg-black border-zinc-800 text-zinc-100'
                        : 'bg-white border-zinc-200 text-zinc-900'
                    }`}
                  />
                </label>
                <label className="grid gap-1 text-[10px] font-black uppercase tracking-widest text-zinc-500">
                  To
                  <input
                    type="datetime-local"
                    step="1"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    className={`h-10 rounded-lg border px-3 text-sm font-mono outline-none ${
                      theme === 'dark'
                        ? 'bg-black border-zinc-800 text-zinc-100'
                        : 'bg-white border-zinc-200 text-zinc-900'
                    }`}
                  />
                </label>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    onClick={closeCustomPicker}
                    className={`px-4 py-2 rounded-lg text-xs font-black uppercase transition-all ${
                      theme === 'dark' ? 'text-zinc-400 hover:text-zinc-100' : 'text-zinc-500 hover:text-zinc-900'
                    }`}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={applyCustomRange}
                    disabled={!isCustomValid}
                    className={`px-4 py-2 rounded-lg text-xs font-black uppercase transition-all ${
                      isCustomValid
                        ? 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/30'
                        : 'bg-zinc-700/40 text-zinc-500 cursor-not-allowed'
                    }`}
                  >
                    Apply
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <button
        onClick={onRefresh}
        className="timerange-refresh flex items-center justify-center bg-blue-600 hover:bg-blue-700 text-white px-3 py-2.5 rounded-xl text-sm font-normal transition-all shadow-lg shadow-blue-500/30 active:scale-95"
        title="Refresh"
      >
        <img src="/brand/icons/refresh.png" alt="" className="toolbar-icon toolbar-icon-only" />
      </button>
    </div>
  );
}
