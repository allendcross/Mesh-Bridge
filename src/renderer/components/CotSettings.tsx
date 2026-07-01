import { useState, useEffect, useRef } from 'react';
import QRCode from 'qrcode';
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
  classifyNodes: boolean;
  homeLat: number | null;
  homeLon: number | null;
  chatBridgeEnabled: boolean;
  chatBridges: Array<{ channelIndex: number; direction: 'both' | 'meshToTak' | 'takToMesh'; room?: string }>;
  teamColor: string;
  callsignPrefix: string;
  nodeStaleSec: number;
  aircraftStaleSec: number;
}

const DEFAULTS: CotForm = {
  enabled: false, multicastEnabled: true, multicastAddr: '239.2.3.1', multicastPort: 6969,
  tcpHost: '', tcpPort: 8087, publishNodes: true, publishAircraft: true, classifyNodes: true,
  homeLat: null, homeLon: null, chatBridgeEnabled: false, chatBridges: [{ channelIndex: 1, direction: 'both' }],
  teamColor: 'Cyan', callsignPrefix: '', nodeStaleSec: 300, aircraftStaleSec: 60,
};
const INGEST_DEFAULTS = { enabled: false, host: '', port: 8089, certName: 'meshbridge-monitor', includeGeoChat: true, includeDrawings: true };
const TEAM_COLORS = ['White', 'Yellow', 'Orange', 'Magenta', 'Red', 'Maroon', 'Purple', 'Dark Blue', 'Blue', 'Cyan', 'Teal', 'Green', 'Dark Green', 'Brown'];

// A small colored connection dot: grey=off, amber(pulsing)=connecting, green=connected.
function Dot({ enabled, connected, title }: { enabled: boolean; connected: boolean; title?: string }) {
  const cls = !enabled ? 'bg-slate-500' : connected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse';
  return <span title={title} className={`inline-block w-2.5 h-2.5 rounded-full ${cls}`} />;
}

export default function CotSettings() {
  const cotConfig = useStore(s => s.cotConfig);
  const getCotConfig = useStore(s => s.getCotConfig);
  const setCotConfig = useStore(s => s.setCotConfig);
  const takIngestConfig = useStore(s => s.takIngestConfig);
  const getTakIngestConfig = useStore(s => s.getTakIngestConfig);
  const setTakIngestConfig = useStore(s => s.setTakIngestConfig);
  const takStatus = useStore(s => s.takStatus);
  const getTakStatus = useStore(s => s.getTakStatus);

  const [form, setForm] = useState<CotForm>(DEFAULTS);
  const [ingest, setIngest] = useState<typeof INGEST_DEFAULTS>(INGEST_DEFAULTS);

  // Consolidated connection UI state (one shared host drives both directions).
  const [serverHost, setServerHost] = useState('127.0.0.1');
  const [sendToServer, setSendToServer] = useState(false);   // outbound feed
  const [receiveFromServer, setReceiveFromServer] = useState(false); // inbound monitor
  const [lanBroadcast, setLanBroadcast] = useState(false);   // LAN multicast
  const [monitorOverride, setMonitorOverride] = useState(false); // monitor uses a different host
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const inited = useRef(false);

  useEffect(() => { getCotConfig(); getTakIngestConfig(); getTakStatus(); }, [getCotConfig, getTakIngestConfig, getTakStatus]);
  useEffect(() => { if (cotConfig) setForm(prev => ({ ...prev, ...cotConfig })); }, [cotConfig]);
  useEffect(() => { if (takIngestConfig) setIngest(prev => ({ ...prev, ...takIngestConfig })); }, [takIngestConfig]);

  // One-time init of the consolidated connection state from the loaded configs.
  useEffect(() => {
    if (inited.current || (!cotConfig && !takIngestConfig)) return;
    const fh = cotConfig?.tcpHost || '';
    const ih = takIngestConfig?.host || '';
    setServerHost(fh || ih || '127.0.0.1');
    setSendToServer(!!fh);
    setLanBroadcast(cotConfig?.multicastEnabled ?? false);
    setReceiveFromServer(takIngestConfig?.enabled ?? false);
    if (fh && ih && fh !== ih) setMonitorOverride(true);
    inited.current = true;
  }, [cotConfig, takIngestConfig]);

  const update = (patch: Partial<CotForm>) => setForm(prev => ({ ...prev, ...patch }));
  const updateIngest = (patch: Partial<typeof INGEST_DEFAULTS>) => setIngest(prev => ({ ...prev, ...patch }));

  // Per-channel chat bridge rule helpers
  const bridges = form.chatBridges || [];
  const updateBridge = (i: number, patch: Partial<CotForm['chatBridges'][number]>) =>
    update({ chatBridges: bridges.map((b, idx) => idx === i ? { ...b, ...patch } : b) });
  const addBridge = () => update({ chatBridges: [...bridges, { channelIndex: 0, direction: 'meshToTak' }] });
  const removeBridge = (i: number) => update({ chatBridges: bridges.filter((_, idx) => idx !== i) });

  // Bridge home location geocode
  const [homeAddress, setHomeAddress] = useState('');
  const [geocoding, setGeocoding] = useState(false);
  const [geoError, setGeoError] = useState('');
  const geocodeHome = async () => {
    if (!homeAddress.trim()) return;
    setGeocoding(true); setGeoError('');
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(homeAddress)}`);
      const data = await res.json();
      if (data && data[0]) update({ homeLat: parseFloat(data[0].lat), homeLon: parseFloat(data[0].lon) });
      else setGeoError('Address not found — enter lat/lon manually.');
    } catch { setGeoError('Lookup failed (no internet?) — enter lat/lon manually.'); }
    finally { setGeocoding(false); }
  };

  // Phone-onboarding (data package + enrollment QR)
  const [pkgPort, setPkgPort] = useState(8089);
  const [enrollUser, setEnrollUser] = useState('meshbridge');
  const [enrollToken, setEnrollToken] = useState('');
  const [enrollQr, setEnrollQr] = useState('');
  const phoneHost = serverHost || (typeof window !== 'undefined' ? window.location.hostname : '');
  const downloadPackage = () => {
    if (!phoneHost) return;
    window.location.href = `${window.location.origin}/api/tak-datapackage?host=${encodeURIComponent(phoneHost)}&port=${pkgPort}&name=MeshBridge`;
  };
  useEffect(() => {
    if (!phoneHost || !enrollUser || !enrollToken) { setEnrollQr(''); return; }
    const url = `tak://com.atakmap.app/enroll?host=${encodeURIComponent(phoneHost)}&username=${encodeURIComponent(enrollUser)}&token=${encodeURIComponent(enrollToken)}`;
    QRCode.toDataURL(url, { width: 280, margin: 2 }).then(setEnrollQr).catch(() => setEnrollQr(''));
  }, [phoneHost, enrollUser, enrollToken]);

  // Save everything (both connections) in one action.
  const handleSave = () => {
    const host = serverHost.trim();
    const monHost = (monitorOverride ? (ingest.host || host) : host).trim();
    setCotConfig({ ...form, enabled: sendToServer || lanBroadcast, tcpHost: sendToServer ? host : '', multicastEnabled: lanBroadcast });
    setTakIngestConfig({ ...ingest, enabled: receiveFromServer, host: monHost });
    setSaveState('saving');
    setTimeout(() => { setSaveState('saved'); setTimeout(() => setSaveState('idle'), 3000); }, 1200);
  };

  // Live status
  const st = takStatus || {};
  const feedUp = sendToServer && !!st.feedConnected;
  const monUp = receiveFromServer && !!st.ingestConnected;
  const anyOn = sendToServer || receiveFromServer || lanBroadcast;
  const anyUp = feedUp || monUp || lanBroadcast;
  const rollup = !anyOn ? { text: 'Not connected', cls: 'bg-slate-700/40 border-slate-600', dot: 'bg-slate-500' }
    : anyUp ? { text: 'Connected to TAK server', cls: 'bg-emerald-500/10 border-emerald-500/40', dot: 'bg-emerald-500' }
    : { text: 'Connecting… (check address & port)', cls: 'bg-amber-500/10 border-amber-500/40', dot: 'bg-amber-500 animate-pulse' };
  const geoChatReady = sendToServer && receiveFromServer;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-3xl font-bold text-white mb-1">TAK Server Connection</h2>
        <p className="text-slate-400 text-sm">Share your mesh nodes, aircraft, and chat with ATAK / iTAK — and show other TAK users on your map. <span className="text-slate-500">(Uses the Cursor-on-Target / CoT protocol.)</span></p>
      </div>

      {/* Rollup status */}
      <div className={`card p-4 border ${rollup.cls}`}>
        <div className="flex items-center gap-3">
          <span className={`inline-block w-3 h-3 rounded-full ${rollup.dot}`} />
          <div>
            <p className="text-white font-medium">{rollup.text}</p>
            <p className="text-xs text-slate-400 mt-0.5">
              {sendToServer && <>Send {st.feedConnected ? '✅' : '⏳'} {st.feedTarget || ''} </>}
              {receiveFromServer && <>· Monitor {st.ingestConnected ? '✅' : '⏳'} {st.ingestTarget || ''} </>}
              {lanBroadcast && <>· LAN broadcast on </>}
              {!anyOn && 'Nothing is turned on yet.'}
            </p>
          </div>
        </div>
      </div>

      {/* ===== TAK Server Connection panel ===== */}
      <div className="card p-6 space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-200 mb-1">Server address</label>
          <input type="text" value={serverHost} onChange={(e) => setServerHost(e.target.value)}
            placeholder="127.0.0.1 (co-located) or Tailscale/LAN IP" className="input w-full font-mono text-sm" />
          <p className="text-xs text-slate-500 mt-1">One address for both directions below. Use your Tailscale/LAN IP to reach a server on another machine.</p>
        </div>

        {/* Send (outbound feed) */}
        <div className="p-3 rounded-lg bg-slate-800 border border-slate-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={sendToServer} onChange={(e) => setSendToServer(e.target.checked)} className="w-4 h-4" />
            <Dot enabled={sendToServer} connected={!!st.feedConnected} title={st.feedLastError || (st.feedConnected ? 'connected' : 'not connected')} />
            <span className="text-white font-medium">Send to TAK server</span>
            <span className="text-xs text-slate-400">— push mesh nodes, aircraft &amp; chat UP to the server</span>
          </label>
          {st.feedLastError && sendToServer && !st.feedConnected && <p className="text-xs text-amber-400 mt-1 ml-6">last error: {st.feedLastError}</p>}
        </div>

        {/* Receive (inbound monitor) */}
        <div className="p-3 rounded-lg bg-slate-800 border border-slate-700 space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={receiveFromServer} onChange={(e) => setReceiveFromServer(e.target.checked)} className="w-4 h-4" />
            <Dot enabled={receiveFromServer} connected={!!st.ingestConnected} title={st.ingestLastError || (st.ingestConnected ? 'connected' : 'not connected')} />
            <span className="text-white font-medium">Receive from TAK server</span>
            <span className="text-xs text-slate-400">— show other TAK users' positions, markers &amp; chat on your map</span>
          </label>
          {receiveFromServer && (
            <div className="ml-6 space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Certificate name</label>
                  <input type="text" value={ingest.certName} onChange={(e) => updateIngest({ certName: e.target.value })} className="input text-sm font-mono w-56" />
                </div>
                <span className={`text-xs px-2 py-1 rounded mt-4 ${st.certFound ? 'bg-emerald-600/20 text-emerald-300' : 'bg-red-600/20 text-red-300'}`}>
                  {st.certFound ? '✓ cert found' : `✗ ${ingest.certName}.pem not found`}
                </span>
              </div>
              <p className="text-xs text-slate-500">The cert the bridge uses to prove its identity to the server (created when you set up the server; leave the default if unsure).</p>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={ingest.includeGeoChat} onChange={(e) => updateIngest({ includeGeoChat: e.target.checked })} className="w-4 h-4" /> Include chat (GeoChat)</label>
                <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={ingest.includeDrawings} onChange={(e) => updateIngest({ includeDrawings: e.target.checked })} className="w-4 h-4" /> Include drawings/shapes</label>
              </div>
              {st.ingestLastError && !st.ingestConnected && <p className="text-xs text-amber-400">last error: {st.ingestLastError}</p>}
            </div>
          )}
        </div>

        {/* Advanced */}
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-200 select-none">Advanced (ports &amp; overrides)</summary>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Outbound port <span className="text-slate-600">(8087 = plaintext feed)</span></label>
              <input type="number" value={form.tcpPort} onChange={(e) => update({ tcpPort: parseInt(e.target.value) || 8087 })} className="input w-full text-sm" />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Monitor port <span className="text-slate-600">(8089 = secure/TLS)</span></label>
              <input type="number" value={ingest.port} onChange={(e) => updateIngest({ port: parseInt(e.target.value) || 8089 })} className="input w-full text-sm" />
            </div>
            <div className="md:col-span-2">
              <label className="flex items-center gap-2 text-slate-300">
                <input type="checkbox" checked={monitorOverride} onChange={(e) => setMonitorOverride(e.target.checked)} className="w-4 h-4" />
                Monitor uses a different server address
              </label>
              {monitorOverride && (
                <input type="text" value={ingest.host} onChange={(e) => updateIngest({ host: e.target.value })} placeholder="monitor host/IP" className="input w-full text-sm font-mono mt-2" />
              )}
              {monitorOverride && ingest.host && ingest.host !== serverHost && (
                <p className="text-xs text-amber-400 mt-1">Monitor points at a different host than Send.</p>
              )}
            </div>
            <p className="md:col-span-2 text-xs text-slate-600">Reads <span className="font-mono">{ingest.certName}.pem/.key</span> + <span className="font-mono">ca.pem</span> from the TAK certs folder. Only one connection may use a given cert at a time.</p>
          </div>
        </details>
      </div>

      {/* ===== LAN broadcast (no server) ===== */}
      <div className="card p-4 space-y-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={lanBroadcast} onChange={(e) => setLanBroadcast(e.target.checked)} className="w-4 h-4" />
          <span className="text-white font-medium">📡 Auto-share on this Wi-Fi / LAN</span>
          <span className="text-xs text-slate-400">— no server needed</span>
        </label>
        <p className="text-xs text-slate-500 ml-6">Nearby ATAK phones on the same network find you automatically. Doesn't work over the internet or a VPN like Tailscale.</p>
        <details className="ml-6 text-sm">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-300 select-none text-xs">Advanced</summary>
          <div className="mt-2 grid grid-cols-2 gap-3 max-w-md">
            <div><label className="block text-xs text-slate-400 mb-1">Broadcast address</label><input type="text" value={form.multicastAddr} onChange={(e) => update({ multicastAddr: e.target.value })} className="input w-full text-sm font-mono" /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Port</label><input type="number" value={form.multicastPort} onChange={(e) => update({ multicastPort: parseInt(e.target.value) || 6969 })} className="input w-full text-sm" /></div>
          </div>
        </details>
      </div>

      {/* ===== What to publish ===== */}
      <div className="card p-6 space-y-3">
        <h3 className="text-lg font-bold text-white">What to share</h3>
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.publishNodes} onChange={(e) => update({ publishNodes: e.target.checked })} className="w-4 h-4" /><span className="text-sm text-slate-300">📟 Mesh nodes</span></label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.publishAircraft} onChange={(e) => update({ publishAircraft: e.target.checked })} className="w-4 h-4" /><span className="text-sm text-slate-300">✈️ Aircraft (ADS-B)</span></label>
        </div>
        <label className="flex items-start gap-2 p-3 rounded-lg bg-slate-800 border border-slate-700">
          <input type="checkbox" checked={form.classifyNodes} onChange={(e) => update({ classifyNodes: e.target.checked })} className="w-4 h-4 mt-0.5" />
          <span className="text-sm text-slate-300">🏷️ <span className="font-medium">Classify nodes by role</span>
            <span className="block text-xs text-slate-500 mt-0.5">Show each node in TAK as a sensor, relay, radio, or unit based on its Meshtastic role — instead of every node showing as a generic friendly unit.</span>
          </span>
        </label>
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-200 select-none">Advanced display options</summary>
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="block text-xs text-slate-400 mb-1">Node team color</label><select value={form.teamColor} onChange={(e) => update({ teamColor: e.target.value })} className="input w-full text-sm">{TEAM_COLORS.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            <div><label className="block text-xs text-slate-400 mb-1">Callsign prefix</label><input type="text" value={form.callsignPrefix} onChange={(e) => update({ callsignPrefix: e.target.value })} placeholder="(none)" className="input w-full text-sm" /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Keep a node on the map for (seconds)</label><input type="number" value={form.nodeStaleSec} onChange={(e) => update({ nodeStaleSec: parseInt(e.target.value) || 300 })} className="input w-full text-sm" /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Keep an aircraft on the map for (seconds)</label><input type="number" value={form.aircraftStaleSec} onChange={(e) => update({ aircraftStaleSec: parseInt(e.target.value) || 60 })} className="input w-full text-sm" /></div>
          </div>
        </details>
      </div>

      {/* ===== Bridge home location (collapsed summary) ===== */}
      <details className="card p-4">
        <summary className="cursor-pointer select-none flex items-center justify-between">
          <span className="text-white font-medium">🏠 Bridge Home Location</span>
          <span className="text-xs text-slate-400">{form.homeLat != null && form.homeLon != null ? `${form.homeLat.toFixed(4)}, ${form.homeLon.toFixed(4)}` : 'using radio GPS'}</span>
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-400">Your relay's radios are stationary here — set this so they show up in the right spot in TAK (instead of their often-wrong GPS). Blank = use the radio's GPS.</p>
          <div className="flex gap-2">
            <input type="text" value={homeAddress} onChange={(e) => setHomeAddress(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') geocodeHome(); }} placeholder="Enter an address (e.g. 6174 Denton Ranch, Las Vegas NV)" className="input flex-1 text-sm" />
            <button onClick={geocodeHome} disabled={geocoding} className="px-3 py-2 rounded bg-slate-700 hover:bg-slate-600 text-white text-sm whitespace-nowrap disabled:opacity-50">{geocoding ? 'Looking up…' : '🔎 Look up'}</button>
          </div>
          {geoError && <p className="text-xs text-amber-400">{geoError}</p>}
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs text-slate-400 mb-1">Latitude</label><input type="number" step="0.0000001" value={form.homeLat ?? ''} onChange={(e) => update({ homeLat: e.target.value === '' ? null : parseFloat(e.target.value) })} placeholder="unset" className="input w-full text-sm font-mono" /></div>
            <div><label className="block text-xs text-slate-400 mb-1">Longitude</label><input type="number" step="0.0000001" value={form.homeLon ?? ''} onChange={(e) => update({ homeLon: e.target.value === '' ? null : parseFloat(e.target.value) })} placeholder="unset" className="input w-full text-sm font-mono" /></div>
          </div>
        </div>
      </details>

      {/* ===== GeoChat text bridge ===== */}
      <div className={`card p-4 space-y-2 ${form.chatBridgeEnabled ? 'border border-cyan-500/40' : 'border border-slate-600'} ${!geoChatReady ? 'opacity-70' : ''}`}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-white font-medium">💬 GeoChat text bridge</h3>
            <p className="text-sm text-slate-400 mt-0.5">Relay chat between your mesh and TAK's built-in chat (GeoChat), both ways.</p>
          </div>
          <label className="flex items-center gap-2 flex-shrink-0">
            <span className={`text-sm font-medium ${form.chatBridgeEnabled ? 'text-cyan-300' : 'text-slate-400'}`}>{form.chatBridgeEnabled ? 'On' : 'Off'}</span>
            <input type="checkbox" disabled={!geoChatReady} checked={form.chatBridgeEnabled} onChange={(e) => update({ chatBridgeEnabled: e.target.checked })} className="w-5 h-5 text-cyan-600 bg-slate-700 border-slate-600 rounded focus:ring-cyan-500 disabled:opacity-40" />
          </label>
        </div>
        {!geoChatReady && <p className="text-xs text-amber-400">Turn on both <strong>Send to TAK server</strong> and <strong>Receive from TAK server</strong> above to use the chat bridge.</p>}
        <div className="space-y-2">
          <label className="block text-xs text-slate-400">Channels to bridge (and direction)</label>
          {bridges.length === 0 && <p className="text-xs text-slate-600">No channels — add one below.</p>}
          <div className="hidden sm:grid grid-cols-[3rem_9rem_1fr_1.5rem] gap-2 text-[10px] uppercase tracking-wide text-slate-600">
            <span>Ch</span><span>Direction</span><span>TAK chat room</span><span></span>
          </div>
          {bridges.map((b, i) => (
            <div key={i} className="grid grid-cols-[3rem_9rem_1fr_1.5rem] gap-2 items-center">
              <input type="number" min={0} max={7} value={b.channelIndex} onChange={(e) => updateBridge(i, { channelIndex: parseInt(e.target.value) || 0 })} className="input text-sm" />
              <select value={b.direction} onChange={(e) => updateBridge(i, { direction: e.target.value as any })} className="input text-sm">
                <option value="both">↔ Both ways</option>
                <option value="meshToTak">↗ Mesh → TAK</option>
                <option value="takToMesh">↘ TAK → Mesh</option>
              </select>
              <input type="text" value={b.room ?? ''} onChange={(e) => updateBridge(i, { room: e.target.value })} placeholder="(channel name)" className="input text-sm" />
              <button onClick={() => removeBridge(i)} title="Remove" className="text-slate-500 hover:text-red-400 text-sm">✕</button>
            </div>
          ))}
          <button onClick={addBridge} className="text-xs text-cyan-400 hover:text-cyan-300">+ Add channel</button>
          <p className="text-xs text-slate-500">
            Each channel goes to its own <strong>TAK chat room</strong> so you can tell them apart (blank = named after the channel, e.g. <span className="font-mono">chopstak</span> / <span className="font-mono">Public</span>). Set a room to <span className="font-mono">All Chat Rooms</span> to use TAK's global room.
            <span className="text-amber-400"> ⚠ Public channels can be busy.</span>
          </p>
        </div>
      </div>

      {/* ===== Save ===== */}
      <div className="flex items-center gap-3 sticky bottom-0 py-3 bg-gradient-to-t from-slate-950 to-transparent">
        <button onClick={handleSave} className="btn-primary">💾 Save TAK Settings</button>
        {saveState === 'saving' && <span className="text-sm text-amber-300">Saving — reconnecting…</span>}
        {saveState === 'saved' && <span className="text-sm text-emerald-400">Saved — watch the status dots above to confirm.</span>}
      </div>

      {/* ===== Connect a phone/client (collapsed) ===== */}
      <details className="card p-4">
        <summary className="cursor-pointer select-none text-white font-medium">📲 Connect a Phone or Client to the TAK Server</summary>
        <div className="mt-4 space-y-5">
          <p className="text-sm text-slate-400">These help a <em>phone or laptop</em> connect to your TAK server — separate from the bridge's own connection above. Host is prefilled from your server address (edit it to a phone-reachable address like a Tailscale IP if needed).</p>

          {/* Data package */}
          <div className="p-3 rounded-lg bg-slate-800 border border-green-500/30 space-y-2">
            <div className="text-white font-medium">Connection Package (recommended · iTAK &amp; ATAK)</div>
            <p className="text-xs text-slate-400">Download a package (certs + connection profile) and import it on the phone. The only way to connect iTAK (iOS); works for ATAK too.</p>
            <div className="flex items-end gap-2">
              <div><label className="block text-xs text-slate-400 mb-1">Port</label><input type="number" value={pkgPort} onChange={(e) => setPkgPort(parseInt(e.target.value) || 8089)} className="input w-24 text-sm" /></div>
              <button onClick={downloadPackage} disabled={!phoneHost} className="btn-primary disabled:opacity-50">⤓ Download package (.zip)</button>
            </div>
            <p className="text-xs text-slate-500">Get <span className="font-mono">MeshBridge.zip</span> onto the phone → open it → Share → iTAK/ATAK → it imports the certs and secure connection.</p>
          </div>

          {/* Enrollment QR (ATAK) */}
          <div className="p-3 rounded-lg bg-slate-800 border border-slate-700 space-y-2">
            <div className="text-white font-medium">ATAK Quick-Connect (Enrollment QR)</div>
            <p className="text-xs text-slate-400"><strong>ATAK (Android) only.</strong> Scan to enroll with a username/password. iTAK can't enroll — use the package above.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div><label className="block text-xs text-slate-400 mb-1">Username</label><input type="text" value={enrollUser} onChange={(e) => setEnrollUser(e.target.value)} className="input w-full text-sm font-mono" /></div>
              <div><label className="block text-xs text-slate-400 mb-1">Password / token</label><input type="text" value={enrollToken} onChange={(e) => setEnrollToken(e.target.value)} placeholder="the TAK Server user's password" className="input w-full text-sm font-mono" /></div>
            </div>
            {enrollQr ? (
              <div className="flex items-center gap-3">
                <div className="bg-white rounded-lg p-2"><img src={enrollQr} alt="ATAK enrollment QR" width={160} height={160} /></div>
                <p className="text-xs text-slate-500">Scan in ATAK to enroll (host {phoneHost}:8446). The QR holds credentials — treat as secret.</p>
              </div>
            ) : <p className="text-xs text-slate-500">Enter username &amp; password to generate the QR.</p>}
          </div>

          {/* Manual */}
          <div className="p-3 rounded-lg bg-slate-900 border border-slate-700 space-y-1 font-mono text-xs text-slate-200">
            <div className="font-sans text-white font-medium mb-1">Manual details</div>
            <div><span className="text-slate-500">Server: </span>{phoneHost || '192.168.0.198'}</div>
            <div><span className="text-slate-500">CoT (streaming) port: </span>8089 (TLS)</div>
            <div><span className="text-slate-500">Enrollment port: </span>8446</div>
            <div><span className="text-slate-500">Admin web UI: </span>https://{phoneHost || '192.168.0.198'}:8443 (needs admin cert)</div>
          </div>
        </div>
      </details>
    </div>
  );
}
