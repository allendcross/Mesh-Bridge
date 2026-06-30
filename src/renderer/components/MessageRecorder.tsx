import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';

// Durable, server-side message recorder viewer. The bridge logs every message it
// hears to disk (per day, per channel); this browses/searches/exports that record
// so a fixed station's full history can be compared against a mobile node's view.
export default function MessageRecorder() {
  const messageLog = useStore(s => s.messageLog);
  const stats = useStore(s => s.messageRecorderStats);
  const queryMessageLog = useStore(s => s.queryMessageLog);
  const getMessageRecorderStats = useStore(s => s.getMessageRecorderStats);
  const bridgeConnected = useStore(s => s.bridgeConnected);

  const [date, setDate] = useState<string>(''); // '' = all days
  const [channelIndex, setChannelIndex] = useState<number | null>(null); // null = all
  const [search, setSearch] = useState('');

  // Channels seen in the record (from stats keys "index:name").
  const channels = useMemo(() => {
    const out: Array<{ index: number; name: string }> = [];
    const by = stats?.byChannel || {};
    for (const key of Object.keys(by)) {
      const [idx, ...rest] = key.split(':');
      out.push({ index: Number(idx), name: rest.join(':') || `Channel ${idx}` });
    }
    return out.sort((a, b) => a.index - b.index);
  }, [stats]);

  const runQuery = () => queryMessageLog({ date: date || null, channelIndex, search, limit: 2000 });

  useEffect(() => { if (bridgeConnected) { getMessageRecorderStats(); runQuery(); } }, [bridgeConnected]);
  // Re-query whenever a filter changes (debounce the search box lightly).
  useEffect(() => {
    if (!bridgeConnected) return;
    const t = setTimeout(runQuery, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [date, channelIndex, search, bridgeConnected]);

  const records = messageLog.records;

  const exportFile = (kind: 'jsonl' | 'csv') => {
    let content = '', mime = 'text/plain';
    if (kind === 'jsonl') {
      content = records.map(r => JSON.stringify(r)).join('\n');
      mime = 'application/x-ndjson';
    } else {
      const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const head = ['ts', 'channel', 'channelName', 'fromId', 'fromName', 'to', 'text', 'blocked', 'forwarded'];
      content = [head.join(','), ...records.map(r => head.map(h => esc((r as any)[h])).join(','))].join('\n');
      mime = 'text/csv';
    }
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mesh-messages${date ? `-${date}` : ''}${channelIndex != null ? `-ch${channelIndex}` : ''}.${kind}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const fmtTime = (ts: string) => {
    const d = new Date(ts);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">Message Recorder</h2>
        <p className="text-slate-400">Durable, server-side log of every message the station hears — survives restarts, not tied to this browser.</p>
      </div>

      {/* Stats overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-4">
          <div className="text-2xl font-bold text-white">{stats?.total?.toLocaleString() ?? '—'}</div>
          <div className="text-xs text-slate-400">total recorded</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold text-white">{stats?.days ?? '—'}</div>
          <div className="text-xs text-slate-400">days on record</div>
        </div>
        <div className="card p-4">
          <div className="text-sm font-bold text-white">{stats?.oldest || '—'} → {stats?.newest || '—'}</div>
          <div className="text-xs text-slate-400">range (retain {stats?.retentionDays ?? '?'}d)</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold text-white">{records.length.toLocaleString()}</div>
          <div className="text-xs text-slate-400">in current view</div>
        </div>
      </div>

      {/* Filters */}
      <div className="card p-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Channel</label>
          <select value={channelIndex ?? ''} onChange={e => setChannelIndex(e.target.value === '' ? null : Number(e.target.value))} className="input text-sm">
            <option value="">All channels</option>
            {channels.map(c => <option key={c.index} value={c.index}>{c.name} (ch {c.index})</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Day</label>
          <select value={date} onChange={e => setDate(e.target.value)} className="input text-sm">
            <option value="">All days</option>
            {(messageLog.days || []).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-[180px]">
          <label className="block text-xs text-slate-400 mb-1">Search text / sender</label>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="filter…" className="input w-full text-sm" />
        </div>
        <button onClick={() => exportFile('csv')} disabled={!records.length} className="px-3 py-2 rounded bg-slate-700 hover:bg-slate-600 text-white text-sm disabled:opacity-50">⬇ CSV</button>
        <button onClick={() => exportFile('jsonl')} disabled={!records.length} className="px-3 py-2 rounded bg-slate-700 hover:bg-slate-600 text-white text-sm disabled:opacity-50">⬇ JSONL</button>
      </div>

      {/* Records table */}
      <div className="card p-0 overflow-hidden">
        <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-900 text-slate-400 text-xs">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-left px-3 py-2 font-medium">Channel</th>
                <th className="text-left px-3 py-2 font-medium">From</th>
                <th className="text-left px-3 py-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {records.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-500">
                  {bridgeConnected ? 'No recorded messages match this filter yet.' : 'Bridge disconnected.'}
                </td></tr>
              )}
              {records.map((r, i) => (
                <tr key={`${r.id}-${i}`} className={`hover:bg-slate-800/50 ${r.blocked ? 'opacity-60' : ''}`}>
                  <td className="px-3 py-1.5 text-slate-400 whitespace-nowrap font-mono text-xs">{fmtTime(r.ts)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <span className={`text-xs px-1.5 py-0.5 rounded ${r.channel === 0 ? 'bg-slate-700 text-slate-300' : 'bg-purple-600/30 text-purple-300'}`}>{r.channelName}</span>
                  </td>
                  <td className="px-3 py-1.5 text-slate-300 whitespace-nowrap">{r.fromName || r.fromId}</td>
                  <td className="px-3 py-1.5 text-white">{r.text}{r.blocked && <span className="ml-2 text-xs text-amber-500">(blocked)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
