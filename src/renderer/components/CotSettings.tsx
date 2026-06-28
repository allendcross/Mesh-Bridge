import { useState, useEffect } from 'react';
import { useStore } from '../store/useStore';

interface CotForm {
  enabled: boolean;
  multicastEnabled: boolean;
  multicastAddr: string;
  multicastPort: number;
  tcpHost: string;
  tcpPort: number;
  publishNodes: boolean;
  publishAircraft: boolean;
  teamColor: string;
  callsignPrefix: string;
  nodeStaleSec: number;
  aircraftStaleSec: number;
}

const DEFAULTS: CotForm = {
  enabled: false,
  multicastEnabled: true,
  multicastAddr: '239.2.3.1',
  multicastPort: 6969,
  tcpHost: '',
  tcpPort: 8087,
  publishNodes: true,
  publishAircraft: true,
  teamColor: 'Cyan',
  callsignPrefix: '',
  nodeStaleSec: 300,
  aircraftStaleSec: 60,
};

// ATAK/iTAK standard team colors
const TEAM_COLORS = ['White', 'Yellow', 'Orange', 'Magenta', 'Red', 'Maroon', 'Purple', 'Dark Blue', 'Blue', 'Cyan', 'Teal', 'Green', 'Dark Green', 'Brown'];

export default function CotSettings() {
  const cotConfig = useStore(state => state.cotConfig);
  const getCotConfig = useStore(state => state.getCotConfig);
  const setCotConfig = useStore(state => state.setCotConfig);

  const [form, setForm] = useState<CotForm>(DEFAULTS);
  const [saved, setSaved] = useState(false);

  useEffect(() => { getCotConfig(); }, [getCotConfig]);
  useEffect(() => { if (cotConfig) setForm(prev => ({ ...prev, ...cotConfig })); }, [cotConfig]);

  const update = (patch: Partial<CotForm>) => setForm(prev => ({ ...prev, ...patch }));

  const handleSave = () => {
    setCotConfig(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">TAK Feed (Cursor-on-Target)</h2>
        <p className="text-slate-400">Publish mesh nodes and aircraft to ATAK/iTAK — via LAN multicast and/or a TAK server.</p>
      </div>

      {/* Status / master toggle */}
      <div className={`card p-4 ${form.enabled ? 'bg-green-500/10 border border-green-500/30' : 'bg-slate-700/30 border border-slate-600'}`}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-white font-medium">🪖 TAK feed is {form.enabled ? 'ENABLED' : 'disabled'}</p>
            <p className="text-sm text-slate-300 mt-1">
              {form.multicastEnabled && `Multicast ${form.multicastAddr}:${form.multicastPort}`}
              {form.multicastEnabled && form.tcpHost && ' · '}
              {form.tcpHost && `TAK server ${form.tcpHost}:${form.tcpPort}`}
              {!form.multicastEnabled && !form.tcpHost && 'No outputs configured'}
            </p>
          </div>
          <label className="flex items-center gap-2">
            <span className={`text-sm font-medium ${form.enabled ? 'text-green-400' : 'text-slate-400'}`}>{form.enabled ? 'On' : 'Off'}</span>
            <input type="checkbox" checked={form.enabled} onChange={(e) => update({ enabled: e.target.checked })}
              className="w-5 h-5 text-green-600 bg-slate-700 border-slate-600 rounded focus:ring-green-500" />
          </label>
        </div>
      </div>

      {/* Outputs */}
      <div className="card p-6 space-y-4">
        <h3 className="text-lg font-bold text-white">Outputs</h3>

        {/* Multicast */}
        <div className="p-3 rounded-lg bg-slate-800 border border-slate-700">
          <label className="flex items-center gap-2 mb-2">
            <input type="checkbox" checked={form.multicastEnabled} onChange={(e) => update({ multicastEnabled: e.target.checked })} className="w-4 h-4" />
            <span className="text-white font-medium">📡 LAN Multicast</span>
            <span className="text-xs text-slate-400">— ATAK auto-discovers on the local subnet (won't traverse Tailscale/WAN)</span>
          </label>
          <div className="grid grid-cols-2 gap-3 ml-6">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Group address</label>
              <input type="text" value={form.multicastAddr} onChange={(e) => update({ multicastAddr: e.target.value })} className="input w-full text-sm font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Port</label>
              <input type="number" value={form.multicastPort} onChange={(e) => update({ multicastPort: parseInt(e.target.value) || 6969 })} className="input w-full text-sm" />
            </div>
          </div>
        </div>

        {/* TAK server TCP feed */}
        <div className="p-3 rounded-lg bg-slate-800 border border-slate-700">
          <div className="text-white font-medium mb-1">🖧 TAK Server (TCP feed)</div>
          <p className="text-xs text-slate-400 mb-2">
            Stream CoT to a TAK server (e.g. FreeTAKServer). Required for remote clients over Tailscale/WAN. Leave host blank to disable.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-slate-400 mb-1">Server host/IP</label>
              <input type="text" value={form.tcpHost} onChange={(e) => update({ tcpHost: e.target.value })} placeholder="127.0.0.1 (local FreeTAKServer)" className="input w-full text-sm font-mono" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Port</label>
              <input type="number" value={form.tcpPort} onChange={(e) => update({ tcpPort: parseInt(e.target.value) || 8087 })} className="input w-full text-sm" />
            </div>
          </div>
        </div>
      </div>

      {/* What to publish */}
      <div className="card p-6 space-y-4">
        <h3 className="text-lg font-bold text-white">What to publish</h3>
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.publishNodes} onChange={(e) => update({ publishNodes: e.target.checked })} className="w-4 h-4" />
            <span className="text-sm text-slate-300">📟 Mesh nodes (ground units)</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.publishAircraft} onChange={(e) => update({ publishAircraft: e.target.checked })} className="w-4 h-4" />
            <span className="text-sm text-slate-300">✈️ Aircraft (ADS-B)</span>
          </label>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Node team color</label>
            <select value={form.teamColor} onChange={(e) => update({ teamColor: e.target.value })} className="input w-full">
              {TEAM_COLORS.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Callsign prefix</label>
            <input type="text" value={form.callsignPrefix} onChange={(e) => update({ callsignPrefix: e.target.value })} placeholder="(none)" className="input w-full" />
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Node stale time (s)</label>
            <input type="number" value={form.nodeStaleSec} onChange={(e) => update({ nodeStaleSec: parseInt(e.target.value) || 300 })} className="input w-full" />
            <p className="text-xs text-slate-500 mt-1">How long a node track persists in TAK between updates.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-1">Aircraft stale time (s)</label>
            <input type="number" value={form.aircraftStaleSec} onChange={(e) => update({ aircraftStaleSec: parseInt(e.target.value) || 60 })} className="input w-full" />
            <p className="text-xs text-slate-500 mt-1">How long an aircraft track persists in TAK between updates.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={handleSave} className="btn-primary">💾 Save TAK Feed Settings</button>
        {saved && <span className="text-sm text-green-400">✓ Saved — applied to the live feed.</span>}
      </div>

      <div className="card p-4 bg-blue-500/10 border border-blue-500/30">
        <p className="text-xs text-blue-200">
          <strong>Connecting a TAK client:</strong> point ATAK/iTAK at the TAK server's host on its CoT port (TCP 8087 by default).
          On the LAN use this machine's IP; remotely, use its Tailscale address. Multicast (LAN) needs no server but only works on the same subnet.
        </p>
      </div>
    </div>
  );
}
