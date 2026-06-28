import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';

interface AdsbForm {
  enabled: boolean;
  source: 'dump1090' | 'network';
  url: string;
  lat: number | null;
  lon: number | null;
  radiusNm: number;
  pollIntervalMs: number;
  staleSeconds: number;
  maxAircraft: number;
}

const DEFAULTS: AdsbForm = {
  enabled: false,
  source: 'dump1090',
  url: 'http://192.168.0.27/dump1090/data/aircraft.json',
  lat: null,
  lon: null,
  radiusNm: 100,
  pollIntervalMs: 2000,
  staleSeconds: 15,
  maxAircraft: 500,
};

export default function AdsbSettings() {
  const adsbConfig = useStore(state => state.adsbConfig);
  const getAdsbConfig = useStore(state => state.getAdsbConfig);
  const setAdsbConfig = useStore(state => state.setAdsbConfig);
  const aircraft = useStore(state => state.aircraft);

  const [form, setForm] = useState<AdsbForm>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  // Request current config on mount
  useEffect(() => { getAdsbConfig(); }, [getAdsbConfig]);

  // Populate the form when config arrives from the bridge
  useEffect(() => {
    if (adsbConfig) setForm(prev => ({ ...prev, ...adsbConfig }));
  }, [adsbConfig]);

  const update = (patch: Partial<AdsbForm>) => setForm(prev => ({ ...prev, ...patch }));

  const handleSave = () => {
    setAdsbConfig(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">ADS-B Aircraft Feed</h2>
        <p className="text-slate-400">Pull live aircraft from a dump1090 receiver or a network API and show them on the Tactical map.</p>
      </div>

      {/* Status banner */}
      <div className={`card p-4 ${form.enabled ? 'bg-cyan-500/10 border border-cyan-500/30' : 'bg-slate-700/30 border border-slate-600'}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-white font-medium">
              ✈️ ADS-B feed is {form.enabled ? 'ENABLED' : 'disabled'}
            </p>
            <p className="text-sm text-slate-300 mt-1">
              Currently tracking <span className="font-mono text-cyan-300">{aircraft.length}</span> aircraft on the map.
            </p>
          </div>
          <label className="flex items-center gap-2">
            <span className={`text-sm font-medium ${form.enabled ? 'text-cyan-400' : 'text-slate-400'}`}>
              {form.enabled ? 'On' : 'Off'}
            </span>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
              className="w-5 h-5 text-cyan-600 bg-slate-700 border-slate-600 rounded focus:ring-cyan-500"
            />
          </label>
        </div>
      </div>

      {/* Source selection */}
      <div className="card p-6 space-y-4">
        <h3 className="text-lg font-bold text-white">Feed Source</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <button
            onClick={() => update({ source: 'dump1090' })}
            className={`text-left p-4 rounded-lg border transition-colors ${form.source === 'dump1090' ? 'bg-blue-600/20 border-blue-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}
          >
            <div className="font-medium text-white">📡 Local receiver (dump1090)</div>
            <div className="text-xs text-slate-400 mt-1">Poll an aircraft.json URL from dump1090 / readsb / FlightRadar24 / tar1090. Real-time, offline.</div>
          </button>
          <button
            onClick={() => update({ source: 'network' })}
            className={`text-left p-4 rounded-lg border transition-colors ${form.source === 'network' ? 'bg-blue-600/20 border-blue-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}
          >
            <div className="font-medium text-white">🌐 Network (airplanes.live)</div>
            <div className="text-xs text-slate-400 mt-1">Query the free airplanes.live API by location + radius. No hardware, but rate-limited.</div>
          </button>
        </div>

        {form.source === 'dump1090' ? (
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">aircraft.json URL</label>
            <input
              type="text"
              value={form.url}
              onChange={(e) => update({ url: e.target.value })}
              placeholder="http://<receiver-ip>/dump1090/data/aircraft.json"
              className="input w-full font-mono text-sm"
            />
            <p className="text-xs text-slate-500 mt-1">
              Common paths: <span className="font-mono">/dump1090/data/aircraft.json</span>,{' '}
              <span className="font-mono">/data/aircraft.json</span>,{' '}
              <span className="font-mono">/tar1090/data/aircraft.json</span>
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Latitude</label>
              <input type="number" step="0.0001" value={form.lat ?? ''} onChange={(e) => update({ lat: e.target.value === '' ? null : parseFloat(e.target.value) })} className="input w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Longitude</label>
              <input type="number" step="0.0001" value={form.lon ?? ''} onChange={(e) => update({ lon: e.target.value === '' ? null : parseFloat(e.target.value) })} className="input w-full" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Radius (nm)</label>
              <input type="number" value={form.radiusNm} onChange={(e) => update({ radiusNm: parseInt(e.target.value) || 0 })} className="input w-full" />
            </div>
          </div>
        )}
      </div>

      {/* Tuning */}
      <div className="card p-6 space-y-4">
        <h3 className="text-lg font-bold text-white">Tuning</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Poll interval (ms)</label>
            <input type="number" value={form.pollIntervalMs} onChange={(e) => update({ pollIntervalMs: parseInt(e.target.value) || 2000 })} className="input w-full" />
            <p className="text-xs text-slate-500 mt-1">How often to fetch (≥1000).</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Drop-off age (s)</label>
            <input type="number" value={form.staleSeconds} onChange={(e) => update({ staleSeconds: parseInt(e.target.value) || 15 })} className="input w-full" />
            <p className="text-xs text-slate-500 mt-1">Hide aircraft whose position is older than this.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Max aircraft</label>
            <input type="number" value={form.maxAircraft} onChange={(e) => update({ maxAircraft: parseInt(e.target.value) || 500 })} className="input w-full" />
            <p className="text-xs text-slate-500 mt-1">Safety cap on rendered aircraft.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} className="btn-primary">💾 Save ADS-B Settings</button>
        {saved && <span className="text-sm text-green-400">✓ Saved — applied to the live feed.</span>}
      </div>
    </div>
  );
}
