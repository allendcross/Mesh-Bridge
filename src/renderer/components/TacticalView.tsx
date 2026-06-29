import { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { forward as mgrsForward, toPoint as mgrsToPoint } from 'mgrs';
import { MeshNode, Radio, Aircraft, TakContact, StationLocation } from '../types';
import { useStore } from '../store/useStore';

interface TacticalViewProps {
  nodes: MeshNode[];
  radios: Radio[];
  aircraft?: Aircraft[];
  takContacts?: TakContact[];
  stationLocation?: StationLocation | null;
}

// ATAK standard team colors → hex (for TAK contact markers).
const TAK_TEAM_COLORS: Record<string, string> = {
  White: '#f8fafc', Yellow: '#facc15', Orange: '#fb923c', Magenta: '#f472b6',
  Red: '#ef4444', Maroon: '#b91c1c', Purple: '#a855f7', 'Dark Blue': '#1d4ed8',
  Blue: '#3b82f6', Cyan: '#22d3ee', Teal: '#14b8a6', Green: '#22c55e',
  'Dark Green': '#15803d', Brown: '#92400e',
};
const takColor = (c: TakContact): string =>
  c.kind === 'marker' ? '#f59e0b' : (TAK_TEAM_COLORS[c.team || ''] || '#a855f7');

// ~40 mile view radius for the initial auto-center (80 mile / 128.7 km square).
const STATION_VIEW_METERS = 80 * 1609.34;

// ADS-B display tuning: drop positions older than STALE, fade them from FADE_START.
const AIRCRAFT_STALE_SEC = 15;
const AIRCRAFT_FADE_START_SEC = 10;

interface GPSTrack {
  nodeId: string;
  positions: Array<{
    latitude: number;
    longitude: number;
    timestamp: Date;
  }>;
}

interface TacticalChannel {
  name: string;
  psk: string;
  index: number;
  description: string;
}

// One-shot fit to nodes on first load. Fits only once so the map doesn't snap
// back to the node bounds on every re-render (aircraft updates re-render ~every 2s,
// which previously fought the user's pan/zoom).
function AutoFitBounds({ nodes }: { nodes: MeshNode[] }) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current) return;
    const nodesWithPos = nodes.filter(n => n.position);
    if (nodesWithPos.length === 0) return;

    const bounds = L.latLngBounds(
      nodesWithPos.map(n => [n.position!.latitude, n.position!.longitude])
    );
    map.fitBounds(bounds, { padding: [50, 50] });
    fitted.current = true;
  }, [nodes, map]);

  return null;
}

// One-shot fit to aircraft when there are no positioned nodes to anchor the map.
// Fits only once (per mount) so the view doesn't jump on every 2s aircraft refresh.
function AircraftInitialFit({ aircraft, hasPositionedNodes }: { aircraft: Aircraft[]; hasPositionedNodes: boolean }) {
  const map = useMap();
  const fitted = useRef(false);

  useEffect(() => {
    if (fitted.current || hasPositionedNodes || aircraft.length === 0) return;
    const bounds = L.latLngBounds(aircraft.map(a => [a.lat, a.lon]));
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 11 });
    fitted.current = true;
  }, [aircraft, hasPositionedNodes, map]);

  return null;
}

// Fly the map to a contact when one is selected in the sidebar.
function FlyTo({ target }: { target: [number, number] | null }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo(target, Math.max(map.getZoom(), 13), { duration: 1 });
  }, [target, map]);
  return null;
}

// One-shot auto-center on the server/relay location at ~40 mile radius.
function StationFit({ station }: { station: StationLocation | null | undefined }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !station) return;
    map.fitBounds(L.latLng(station.lat, station.lon).toBounds(STATION_VIEW_METERS));
    fitted.current = true;
  }, [station, map]);
  return null;
}

// Report the map cursor's lat/lng up to the component for the coordinate readout.
function MouseCoords({ onMove }: { onMove: (latlng: { lat: number; lng: number } | null) => void }) {
  useMapEvents({
    mousemove: (e) => onMove({ lat: e.latlng.lat, lng: e.latlng.lng }),
    mouseout: () => onMove(null),
  });
  return null;
}

// Re-measure the map whenever `trigger` changes (e.g. the sidebar opens/closes
// and the map's width changes), so Leaflet doesn't leave grey gutters.
function InvalidateSize({ trigger }: { trigger: unknown }) {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 80);
    return () => clearTimeout(t);
  }, [trigger, map]);
  return null;
}

type ContactSource = 'meshtastic' | 'adsb' | 'tak';
interface Contact {
  id: string;
  source: ContactSource;
  name: string;
  sub: string;
  meta: string;
  color: string;
  hasPosition: boolean;
  lat?: number;
  lon?: number;
}

interface AircraftTrail {
  icao: string;
  emergency: boolean;
  positions: Array<{ lat: number; lon: number; t: number }>;
}

export default function TacticalView({ nodes, radios, aircraft = [], takContacts: takTracks = [], stationLocation }: TacticalViewProps) {
  const [showSidebar, setShowSidebar] = useState(true);
  const [sourceFilter, setSourceFilter] = useState<'all' | ContactSource>('all');
  const [contactSearch, setContactSearch] = useState('');
  const [flyTo, setFlyTo] = useState<[number, number] | null>(null);
  const [cursor, setCursor] = useState<{ lat: number; lng: number } | null>(null);
  const [gotoInput, setGotoInput] = useState('');
  const [gotoError, setGotoError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [teamChannel, setTeamChannel] = useState<number | null>(null); // null = all channels
  const [hideNonTeam, setHideNonTeam] = useState(false);
  const manager = useStore(state => state.manager);
  const cotConfig = useStore(state => state.cotConfig);
  const [mapLayer, setMapLayer] = useState<'osm' | 'satellite' | 'topo'>('satellite');
  const [showAircraft, setShowAircraft] = useState(true);
  const [showAircraftTrails, setShowAircraftTrails] = useState(true);
  const [aircraftTrailAge, setAircraftTrailAge] = useState(2); // minutes (aircraft move fast)
  const [aircraftTrails, setAircraftTrails] = useState<Map<string, AircraftTrail>>(new Map());
  const [showBreadcrumbs, setShowBreadcrumbs] = useState(true);
  const [breadcrumbAge, setBreadcrumbAge] = useState(60); // minutes
  const [gpsTrails, setGpsTrails] = useState<Map<string, GPSTrack>>(new Map());
  const [setupMode, setSetupMode] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [generatedChannel, setGeneratedChannel] = useState<TacticalChannel | null>(null);

  // Track GPS positions over time
  useEffect(() => {
    const newTrails = new Map(gpsTrails);

    nodes.forEach(node => {
      if (!node.position) return;

      const trail = newTrails.get(node.nodeId) || {
        nodeId: node.nodeId,
        positions: [],
      };

      // Add new position if it's different from the last one
      const lastPos = trail.positions[trail.positions.length - 1];
      const isDifferent = !lastPos ||
        Math.abs(lastPos.latitude - node.position.latitude) > 0.0001 ||
        Math.abs(lastPos.longitude - node.position.longitude) > 0.0001;

      if (isDifferent) {
        trail.positions.push({
          latitude: node.position.latitude,
          longitude: node.position.longitude,
          timestamp: new Date(),
        });

        // Keep only positions within the breadcrumb age window
        const cutoffTime = Date.now() - breadcrumbAge * 60 * 1000;
        trail.positions = trail.positions.filter(
          p => new Date(p.timestamp).getTime() > cutoffTime
        );
      }

      newTrails.set(node.nodeId, trail);
    });

    setGpsTrails(newTrails);
  }, [nodes, breadcrumbAge]);

  // Accumulate aircraft position history into short-lived trails. Aircraft arrive
  // as snapshot-replaced arrays every ~2s, so we append per-ICAO here, prune points
  // older than the (short) trail window, and drop trails for aircraft that have left.
  useEffect(() => {
    const now = Date.now();
    const cutoff = now - aircraftTrailAge * 60 * 1000;
    const next = new Map(aircraftTrails);

    for (const ac of aircraft) {
      if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number') continue;
      const trail = next.get(ac.icao) || { icao: ac.icao, emergency: false, positions: [] };
      trail.emergency = !!ac.emergency;

      const last = trail.positions[trail.positions.length - 1];
      const moved = !last ||
        Math.abs(last.lat - ac.lat) > 0.0002 ||
        Math.abs(last.lon - ac.lon) > 0.0002;
      if (moved) trail.positions.push({ lat: ac.lat, lon: ac.lon, t: now });

      next.set(ac.icao, trail);
    }

    // Prune old points and drop trails that have fully aged out (aircraft gone).
    for (const [icao, trail] of next) {
      trail.positions = trail.positions.filter(p => p.t > cutoff).slice(-300);
      if (trail.positions.length === 0) next.delete(icao);
    }

    setAircraftTrails(next);
  }, [aircraft, aircraftTrailAge]);

  // Generate secure channel configuration
  const generateTacticalChannel = () => {
    if (!channelName.trim()) {
      alert('Please enter a channel name');
      return;
    }

    // Generate random PSK (AES-256 key)
    const pskBytes = new Uint8Array(32);
    crypto.getRandomValues(pskBytes);
    const pskBase64 = btoa(String.fromCharCode(...pskBytes));

    const channel: TacticalChannel = {
      name: channelName.trim(),
      psk: pskBase64,
      index: 1, // Secondary channel
      description: `Tactical channel: ${channelName}`,
    };

    setGeneratedChannel(channel);
  };

  // Copy channel config to clipboard
  const copyChannelConfig = () => {
    if (!generatedChannel) return;

    const config = `Meshtastic Tactical Channel: ${generatedChannel.name}
Channel Index: ${generatedChannel.index}
PSK (Base64): ${generatedChannel.psk}

⚠️ SECURE THIS KEY - Anyone with this PSK can decrypt your messages!

Setup Instructions:
1. Open Meshtastic app on each device
2. Go to Settings → Channels → Add Channel
3. Name: ${generatedChannel.name}
4. PSK: ${generatedChannel.psk}
5. Save and ensure channel index is ${generatedChannel.index}

All devices must use the EXACT same PSK and channel index.`;

    navigator.clipboard.writeText(config);
    alert('Channel configuration copied to clipboard!');
  };

  // Get color for node based on status
  const getNodeColor = (node: MeshNode): string => {
    const minutesSinceHeard = (Date.now() - node.lastHeard.getTime()) / 1000 / 60;

    if (minutesSinceHeard < 5) return '#22c55e'; // Green - active (< 5 min)
    if (minutesSinceHeard < 30) return '#eab308'; // Yellow - recent (< 30 min)
    return '#ef4444'; // Red - stale (> 30 min)
  };

  // Create custom marker icon
  const createNodeIcon = (node: MeshNode) => {
    const color = getNodeColor(node);
    const isRadio = radios.some(r => r.nodeInfo?.nodeId === node.nodeId);

    return L.divIcon({
      html: `
        <div style="position: relative; text-align: center;">
          <svg width="30" height="30" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            ${isRadio ? `
              <!-- Radio/Base Station Icon -->
              <circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/>
              <path d="M8 9l4-4 4 4M12 5v10" stroke="white" stroke-width="2" stroke-linecap="round"/>
            ` : `
              <!-- Person/Handheld Icon -->
              <circle cx="12" cy="7" r="3" fill="${color}"/>
              <path d="M12 11c-3 0-5 2-5 4v5h10v-5c0-2-2-4-5-4z" fill="${color}" stroke="white" stroke-width="1"/>
            `}
          </svg>
          <div style="
            position: absolute;
            top: -25px;
            left: 50%;
            transform: translateX(-50%);
            background: ${color};
            color: white;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 10px;
            font-weight: 600;
            white-space: nowrap;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
          ">${node.shortName}</div>
        </div>
      `,
      className: '',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
  };

  // Opacity ramp: fully opaque until FADE_START, fading to ~0.35 at STALE.
  const aircraftOpacity = (seenPos: number): number => {
    if (seenPos <= AIRCRAFT_FADE_START_SEC) return 1;
    const t = (seenPos - AIRCRAFT_FADE_START_SEC) / (AIRCRAFT_STALE_SEC - AIRCRAFT_FADE_START_SEC);
    return Math.max(0.35, 1 - t * 0.65);
  };

  // Rotated plane marker, colored cyan (red if emergency squawk), faded by position age.
  const createAircraftIcon = (ac: Aircraft) => {
    const color = ac.emergency ? '#ef4444' : '#22d3ee';
    const opacity = aircraftOpacity(ac.seenPos ?? 0);
    const rotation = ac.track ?? 0;
    const label = ac.callsign || ac.icao.toUpperCase();
    const altText = ac.altFt !== undefined ? `${Math.round(ac.altFt).toLocaleString()}ft` : '';

    return L.divIcon({
      html: `
        <div style="position: relative; text-align: center; opacity: ${opacity};">
          <svg width="26" height="26" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"
               style="transform: rotate(${rotation}deg); filter: drop-shadow(0 1px 1px rgba(0,0,0,0.6));">
            <path d="M12 2 L13.5 11 L21 15 L21 16.5 L13.5 14.5 L13.5 19.5 L16 21 L16 22 L12 21 L8 22 L8 21 L10.5 19.5 L10.5 14.5 L3 16.5 L3 15 L10.5 11 Z"
                  fill="${color}" stroke="#0f172a" stroke-width="0.7"/>
          </svg>
          <div style="
            position: absolute;
            top: 22px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(15,23,42,0.85);
            color: ${color};
            padding: 1px 4px;
            border-radius: 3px;
            font-size: 9px;
            font-weight: 700;
            white-space: nowrap;
            line-height: 1.1;
          ">${label}${altText ? `<br/><span style="color:#cbd5e1;font-weight:500;">${altText}</span>` : ''}</div>
        </div>
      `,
      className: '',
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
  };

  // Inbound TAK track marker: circle for live contacts, amber diamond for dropped
  // markers, colored by ATAK team. Callsign label below.
  const createTakIcon = (c: TakContact) => {
    const color = takColor(c);
    const label = String(c.callsign || c.uid).replace(/[<>]/g, '');
    const shape = c.kind === 'marker'
      ? `<div style="width:13px;height:13px;background:${color};border:1.5px solid #0f172a;transform:rotate(45deg);box-shadow:0 1px 2px rgba(0,0,0,0.6);"></div>`
      : `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #0f172a;box-shadow:0 1px 2px rgba(0,0,0,0.6);"></div>`;
    return L.divIcon({
      html: `
        <div style="position:relative;text-align:center;">
          ${shape}
          <div style="position:absolute;top:15px;left:50%;transform:translateX(-50%);
               background:rgba(15,23,42,0.85);color:${color};padding:1px 4px;border-radius:3px;
               font-size:9px;font-weight:700;white-space:nowrap;line-height:1.1;">${label}</div>
        </div>`,
      className: '',
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  };

  const nodesWithPosition = nodes.filter(n => n.position);
  // Only show fresh, positioned aircraft (server already filters; this guards the UI too).
  const visibleAircraft = aircraft.filter(
    a => typeof a.lat === 'number' && typeof a.lon === 'number' && (a.seenPos ?? 0) <= AIRCRAFT_STALE_SEC
  );
  // Positioned TAK contacts + markers (drawings rendered separately in a later phase).
  const visibleTakTracks = takTracks.filter(
    c => c.kind !== 'drawing' && typeof c.lat === 'number' && typeof c.lon === 'number'
  );
  const defaultCenter: [number, number] = nodesWithPosition.length > 0
    ? [nodesWithPosition[0].position!.latitude, nodesWithPosition[0].position!.longitude]
    : visibleAircraft.length > 0
      ? [visibleAircraft[0].lat, visibleAircraft[0].lon]
      : [40.7128, -74.0060];

  const formatTimeAgo = (date: Date): string => {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  };

  // ===== Team channel filtering =====
  // Channels available across all connected radios (index -> display name).
  const availableChannels = (() => {
    const map = new Map<number, string>();
    radios.forEach(r => {
      (r.channels || []).forEach(ch => {
        const name = ch.settings?.name?.trim();
        // Skip fully-disabled/empty channels (role DISABLED with no name)
        if (name || ch.role !== undefined) {
          map.set(ch.index, name || `Channel ${ch.index}`);
        }
      });
    });
    // Include any channel indices seen on nodes but not in radio config.
    nodes.forEach(n => (n.channels || []).forEach(ci => {
      if (!map.has(ci)) map.set(ci, `Channel ${ci}`);
    }));
    return Array.from(map.entries()).sort((a, b) => a[0] - b[0]);
  })();

  // A node is "team" if it has been heard on the selected team channel.
  const isTeamNode = (node: MeshNode): boolean => {
    if (teamChannel === null) return true;
    if (Array.isArray(node.channels)) return node.channels.includes(teamChannel);
    return node.channelIndex === teamChannel;
  };

  // ===== Unified sidebar contacts (Meshtastic nodes + ADS-B aircraft + future TAK) =====
  const meshContacts: Contact[] = nodes
    .filter(node => !(hideNonTeam && teamChannel !== null && !isTeamNode(node)))
    .map(node => {
      const team = teamChannel !== null && isTeamNode(node);
      return {
        id: `mesh-${node.nodeId}`,
        source: 'meshtastic' as const,
        name: `${team ? '★ ' : ''}${node.longName || node.shortName || node.nodeId}`,
        sub: `${node.shortName} • ${node.nodeId}`,
        meta: formatTimeAgo(node.lastHeard),
        color: getNodeColor(node),
        hasPosition: !!node.position,
        lat: node.position?.latitude,
        lon: node.position?.longitude,
      };
    });

  const adsbContacts: Contact[] = visibleAircraft.map(ac => ({
    id: `adsb-${ac.icao}`,
    source: 'adsb',
    name: ac.callsign || ac.icao.toUpperCase(),
    sub: `ICAO ${ac.icao.toUpperCase()}${ac.squawk ? ` • SQ ${ac.squawk}` : ''}`,
    meta: [
      ac.altFt !== undefined ? `${Math.round(ac.altFt).toLocaleString()}ft` : null,
      ac.groundSpeedKt !== undefined ? `${Math.round(ac.groundSpeedKt)}kt` : null,
    ].filter(Boolean).join(' • '),
    color: ac.emergency ? '#ef4444' : '#22d3ee',
    hasPosition: true,
    lat: ac.lat,
    lon: ac.lon,
  }));

  // Inbound TAK tracks (contacts, markers) from the TAK Server CoT stream.
  const takContacts: Contact[] = takTracks
    .filter(c => typeof c.lat === 'number' && typeof c.lon === 'number')
    .map(c => ({
      id: `tak-${c.uid}`,
      source: 'tak' as const,
      name: c.callsign,
      sub: `${c.kind.toUpperCase()}${c.team ? ` • ${c.team}` : ''}`,
      meta: c.kind === 'contact' ? (c.platform || 'TAK') : (c.remarks || c.cotType),
      color: takColor(c),
      hasPosition: true,
      lat: c.lat,
      lon: c.lon,
    }));

  const allContacts = [...meshContacts, ...adsbContacts, ...takContacts];
  const counts = {
    all: allContacts.length,
    meshtastic: meshContacts.length,
    adsb: adsbContacts.length,
    tak: takContacts.length,
  };

  const search = contactSearch.trim().toLowerCase();
  const filteredContacts = allContacts
    .filter(c => sourceFilter === 'all' || c.source === sourceFilter)
    .filter(c => !search || c.name.toLowerCase().includes(search) || c.sub.toLowerCase().includes(search))
    .sort((a, b) => {
      if (a.hasPosition && !b.hasPosition) return -1;
      if (!a.hasPosition && b.hasPosition) return 1;
      return a.name.localeCompare(b.name);
    });

  const sourceTabs: Array<{ key: 'all' | ContactSource; label: string }> = [
    { key: 'all', label: 'All' },
    { key: 'meshtastic', label: 'Mesh' },
    { key: 'adsb', label: 'ADS-B' },
    { key: 'tak', label: 'TAK' },
  ];
  const sourceTag = (s: ContactSource) => (s === 'meshtastic' ? 'MESH' : s === 'adsb' ? 'ADS-B' : 'TAK');

  // Jump to the viewer's GPS location (needs a secure context: HTTPS or localhost).
  const goToMyLocation = () => {
    if (!('geolocation' in navigator)) {
      setGotoError('Geolocation is not supported by this browser.');
      return;
    }
    setLocating(true);
    setGotoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setFlyTo([pos.coords.latitude, pos.coords.longitude]);
      },
      (err) => {
        setLocating(false);
        setGotoError(
          err.code === err.PERMISSION_DENIED
            ? 'Location blocked. Browser geolocation needs HTTPS (or localhost); this page is served over http on the LAN.'
            : `Could not get your location: ${err.message}`
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Jump to a typed lat/lon, MGRS grid reference, or street address.
  const handleGoto = async () => {
    const q = gotoInput.trim();
    if (!q) return;
    setGotoError(null);

    // 1) "lat, lon" or "lat lon"
    const ll = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (ll) {
      const lat = parseFloat(ll[1]);
      const lon = parseFloat(ll[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        setFlyTo([lat, lon]);
        return;
      }
    }

    // 2) MGRS grid reference, e.g. "11SPA5792709426"
    const mgrsCandidate = q.replace(/\s+/g, '').toUpperCase();
    if (/^\d{1,2}[C-X][A-Z]{2}\d+$/.test(mgrsCandidate)) {
      try {
        const [lon, lat] = mgrsToPoint(mgrsCandidate);
        setFlyTo([lat, lon]);
        return;
      } catch {
        // not valid MGRS — fall through to address lookup
      }
    }

    // 3) Street address / place name via OpenStreetMap Nominatim
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`
      );
      const j = await res.json();
      if (Array.isArray(j) && j.length > 0) {
        setFlyTo([parseFloat(j[0].lat), parseFloat(j[0].lon)]);
        return;
      }
      setGotoError('No match found for that address.');
    } catch (e: any) {
      setGotoError(`Lookup failed: ${e.message}`);
    }
  };

  // MGRS for the cursor readout (mgrs.forward takes [lon, lat]).
  const cursorMgrs = (() => {
    if (!cursor) return '';
    try {
      return mgrsForward([cursor.lng, cursor.lat]);
    } catch {
      return '—';
    }
  })();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-3xl font-bold text-white mb-2">Tactical Awareness Kit</h2>
        <p className="text-slate-400">
          Real-time team tracking with GPS breadcrumbs and secure channel setup
        </p>
      </div>

      {/* Setup Mode Panel */}
      {setupMode ? (
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-bold text-white">🔒 Tactical Channel Setup</h3>
            <button
              onClick={() => setSetupMode(false)}
              className="text-slate-400 hover:text-white"
            >
              ✕ Close
            </button>
          </div>

          <div className="space-y-4">
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-yellow-400 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-yellow-300 mb-1">Security Notice</h4>
                  <p className="text-xs text-slate-400">
                    This will generate a cryptographically secure AES-256 key for your tactical channel.
                    Anyone with this key can decrypt your messages. Share it only with trusted team members
                    via secure means (in person, encrypted chat, etc.).
                  </p>
                </div>
              </div>
            </div>

            {!generatedChannel ? (
              <>
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">
                    Tactical Channel Name
                  </label>
                  <input
                    type="text"
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    placeholder="e.g., Alpha Team, Search & Rescue, Event Ops"
                    className="input w-full"
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Choose a descriptive name for this tactical channel
                  </p>
                </div>

                <button
                  onClick={generateTacticalChannel}
                  className="btn-primary w-full"
                >
                  🔐 Generate Secure Channel
                </button>
              </>
            ) : (
              <div className="space-y-4">
                <div className="bg-green-500/10 border border-green-500/30 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-green-300 mb-3">
                    ✅ Channel Generated: {generatedChannel.name}
                  </h4>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">
                        Channel Index
                      </label>
                      <div className="bg-slate-900 p-2 rounded font-mono text-sm text-white">
                        {generatedChannel.index}
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-400 mb-1">
                        Pre-Shared Key (PSK) - AES-256
                      </label>
                      <div className="bg-slate-900 p-2 rounded font-mono text-xs text-white break-all">
                        {generatedChannel.psk}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={copyChannelConfig}
                    className="btn-primary flex-1"
                  >
                    📋 Copy Setup Instructions
                  </button>
                  <button
                    onClick={() => {
                      setGeneratedChannel(null);
                      setChannelName('');
                    }}
                    className="bg-slate-700 text-white px-4 py-2 rounded-lg hover:bg-slate-600"
                  >
                    Generate Another
                  </button>
                </div>

                <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-blue-300 mb-2">Setup Instructions</h4>
                  <ol className="text-xs text-slate-400 space-y-2 list-decimal list-inside">
                    <li>Copy the configuration using the button above</li>
                    <li>Share securely with team members (encrypted chat, in person)</li>
                    <li>Each member opens Meshtastic app → Settings → Channels</li>
                    <li>Add new channel with exact PSK and channel index</li>
                    <li>All devices must use IDENTICAL settings to communicate</li>
                    <li>Configure radios connected to this bridge via Configuration tab</li>
                  </ol>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Stats & Controls */
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="card">
            <div className="text-sm text-slate-400">Team Members</div>
            <div className="text-3xl font-bold text-white">
              {teamChannel === null
                ? nodesWithPosition.length
                : nodesWithPosition.filter(isTeamNode).length}
            </div>
            <div className="text-xs text-slate-500">
              {teamChannel === null
                ? 'all channels, with GPS'
                : `on "${availableChannels.find(([i]) => i === teamChannel)?.[1] ?? `Channel ${teamChannel}`}"`}
            </div>
          </div>

          <div className="card">
            <div className="text-sm text-slate-400">Active (&lt; 5 min)</div>
            <div className="text-3xl font-bold text-green-400">
              {nodesWithPosition.filter(n => (Date.now() - n.lastHeard.getTime()) < 5 * 60 * 1000).length}
            </div>
            <div className="text-xs text-slate-500">transmitting</div>
          </div>

          <div className="card">
            <div className="text-sm text-slate-400">Recent (&lt; 30 min)</div>
            <div className="text-3xl font-bold text-yellow-400">
              {nodesWithPosition.filter(n => {
                const age = Date.now() - n.lastHeard.getTime();
                return age >= 5 * 60 * 1000 && age < 30 * 60 * 1000;
              }).length}
            </div>
            <div className="text-xs text-slate-500">heard recently</div>
          </div>

          <div className="card">
            <button
              onClick={() => setSetupMode(true)}
              className="w-full h-full flex flex-col items-center justify-center gap-2 hover:bg-slate-700/50 rounded-lg transition-colors"
            >
              <svg className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span className="text-sm font-medium text-white">Channel Setup</span>
              <span className="text-xs text-slate-400">Configure tactical channel</span>
            </button>
          </div>
        </div>
      )}

      {/* Map Controls */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-300">🛡️ Team:</label>
            <select
              value={teamChannel === null ? 'all' : String(teamChannel)}
              onChange={(e) => setTeamChannel(e.target.value === 'all' ? null : parseInt(e.target.value))}
              className="bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600"
            >
              <option value="all">All channels</option>
              {availableChannels.map(([index, name]) => (
                <option key={index} value={index}>{name} (ch {index})</option>
              ))}
            </select>
            {teamChannel !== null && (
              <label className="flex items-center gap-1 text-sm text-slate-300 ml-1">
                <input
                  type="checkbox"
                  checked={hideNonTeam}
                  onChange={(e) => setHideNonTeam(e.target.checked)}
                  className="w-4 h-4 text-blue-600 bg-slate-700 border-slate-600 rounded focus:ring-blue-500"
                />
                Hide non-team
              </label>
            )}
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="breadcrumbs"
              checked={showBreadcrumbs}
              onChange={(e) => setShowBreadcrumbs(e.target.checked)}
              className="w-4 h-4 text-blue-600 bg-slate-700 border-slate-600 rounded focus:ring-blue-500"
            />
            <label htmlFor="breadcrumbs" className="text-sm text-slate-300">
              Show GPS Trails
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="aircraft"
              checked={showAircraft}
              onChange={(e) => setShowAircraft(e.target.checked)}
              className="w-4 h-4 text-cyan-500 bg-slate-700 border-slate-600 rounded focus:ring-cyan-500"
            />
            <label htmlFor="aircraft" className="text-sm text-slate-300">
              ✈️ Aircraft (ADS-B)
              <span className="ml-1 text-cyan-400 font-semibold">{visibleAircraft.length}</span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="aircraftTrails"
              checked={showAircraftTrails}
              onChange={(e) => setShowAircraftTrails(e.target.checked)}
              className="w-4 h-4 text-cyan-500 bg-slate-700 border-slate-600 rounded focus:ring-cyan-500"
            />
            <label htmlFor="aircraftTrails" className="text-sm text-slate-300">
              Aircraft Trails
            </label>
            <select
              value={aircraftTrailAge}
              onChange={(e) => setAircraftTrailAge(parseInt(e.target.value))}
              className="bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600"
            >
              <option value="1">1 min</option>
              <option value="2">2 min</option>
              <option value="5">5 min</option>
              <option value="10">10 min</option>
              <option value="15">15 min</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-slate-300">Trail Age:</label>
            <select
              value={breadcrumbAge}
              onChange={(e) => setBreadcrumbAge(parseInt(e.target.value))}
              className="bg-slate-700 text-white text-sm rounded px-2 py-1 border border-slate-600"
            >
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
              <option value="60">1 hour</option>
              <option value="120">2 hours</option>
              <option value="360">6 hours</option>
              <option value="720">12 hours</option>
              <option value="1440">24 hours</option>
            </select>
          </div>

          <div className="flex gap-2 ml-auto">
            <button
              onClick={() => setMapLayer('osm')}
              className={`text-xs px-3 py-1 rounded ${mapLayer === 'osm' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}
            >
              Street
            </button>
            <button
              onClick={() => setMapLayer('satellite')}
              className={`text-xs px-3 py-1 rounded ${mapLayer === 'satellite' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}
            >
              Satellite
            </button>
            <button
              onClick={() => setMapLayer('topo')}
              className={`text-xs px-3 py-1 rounded ${mapLayer === 'topo' ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300'}`}
            >
              Topo
            </button>
          </div>
        </div>

        {/* Go-to & location tools */}
        <div className="flex flex-wrap items-center gap-3 mt-3 pt-3 border-t border-slate-700">
          <button
            onClick={goToMyLocation}
            disabled={locating}
            className="text-xs px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-600 disabled:opacity-50"
          >
            {locating ? '📡 Locating…' : '📍 My Location'}
          </button>
          {stationLocation && (
            <button
              onClick={() => setFlyTo([stationLocation.lat, stationLocation.lon])}
              className="text-xs px-3 py-1.5 rounded bg-slate-700 text-white hover:bg-slate-600"
              title={`Station${stationLocation.label ? `: ${stationLocation.label}` : ''} (${stationLocation.source})`}
            >
              🏠 Station
            </button>
          )}
          <div className="flex items-center gap-1 flex-1 min-w-[260px]">
            <input
              type="text"
              value={gotoInput}
              onChange={(e) => setGotoInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleGoto(); }}
              placeholder="Go to: address, lat,lon, or MGRS…"
              className="flex-1 bg-slate-700 text-white text-xs rounded px-2 py-1.5 border border-slate-600 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            />
            <button
              onClick={handleGoto}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500"
            >
              Go
            </button>
          </div>
          {gotoError && <span className="text-xs text-red-400 w-full">{gotoError}</span>}
        </div>
      </div>

      {/* Tactical Map + Contacts Sidebar */}
      <div className="card p-0 overflow-hidden flex relative" style={{ height: '700px' }}>
        {/* Contacts Sidebar */}
        {showSidebar && (
          <div className="w-72 flex-shrink-0 bg-slate-900/95 border-r border-slate-700 overflow-y-auto">
            <div className="p-3 border-b border-slate-700 sticky top-0 bg-slate-900/95 z-[500]">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-white text-sm">Contacts ({counts.all})</h3>
                <button
                  onClick={() => setShowSidebar(false)}
                  className="text-slate-400 hover:text-white"
                  title="Hide sidebar"
                >
                  ✕
                </button>
              </div>
              {/* Source filter */}
              <div className="grid grid-cols-4 gap-1 mb-2">
                {sourceTabs.map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setSourceFilter(tab.key)}
                    className={`text-[11px] px-1 py-1 rounded font-medium transition-colors ${
                      sourceFilter === tab.key
                        ? 'bg-blue-600 text-white'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                    title={`${tab.label} (${counts[tab.key]})`}
                  >
                    {tab.label}
                    <span className="ml-1 opacity-70">{counts[tab.key]}</span>
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder="Search contacts…"
                className="w-full bg-slate-800 text-white text-xs rounded px-2 py-1 border border-slate-600 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              />
            </div>
            <div className="divide-y divide-slate-800">
              {filteredContacts.length === 0 && (
                <div className="p-3 text-xs text-slate-500">No contacts for this filter</div>
              )}
              {filteredContacts.map(c => (
                <div
                  key={c.id}
                  onClick={() => {
                    if (c.hasPosition && c.lat != null && c.lon != null) setFlyTo([c.lat, c.lon]);
                  }}
                  className={`p-2.5 ${c.hasPosition ? 'cursor-pointer hover:bg-slate-800' : 'opacity-50'}`}
                  title={c.hasPosition ? 'Click to locate on map' : 'No location data'}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: c.color }} />
                    <span className="text-sm text-white font-medium truncate">{c.name}</span>
                    <span className="ml-auto text-[9px] uppercase tracking-wide text-slate-500 flex-shrink-0">
                      {sourceTag(c.source)}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-400 mt-0.5 ml-4 truncate">{c.sub}</div>
                  {c.meta && <div className="text-[11px] text-slate-500 mt-0.5 ml-4">{c.meta}</div>}
                  {!c.hasPosition && <div className="text-[11px] text-slate-600 mt-0.5 ml-4">No location</div>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Show-sidebar button when hidden */}
        {!showSidebar && (
          <button
            onClick={() => setShowSidebar(true)}
            className="absolute left-3 top-3 z-[500] bg-slate-900/90 text-white text-xs px-3 py-2 rounded shadow-lg border border-slate-700 hover:bg-slate-800"
          >
            📋 Contacts ({counts.all})
          </button>
        )}

        {/* Map */}
        <div className="flex-1 relative">
        <MapContainer
          center={defaultCenter}
          zoom={13}
          style={{ height: '100%', width: '100%' }}
          zoomControl={true}
        >
          <InvalidateSize trigger={showSidebar} />
          <FlyTo target={flyTo} />
          <MouseCoords onMove={setCursor} />
          <StationFit station={stationLocation} />
          <AutoFitBounds nodes={nodesWithPosition} />
          <AircraftInitialFit aircraft={visibleAircraft} hasPositionedNodes={nodesWithPosition.length > 0} />

          {mapLayer === 'osm' && (
            <TileLayer
              attribution='&copy; OpenStreetMap contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
          )}
          {mapLayer === 'satellite' && (
            <TileLayer
              attribution='Tiles &copy; Esri'
              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
              maxZoom={19}
            />
          )}
          {mapLayer === 'topo' && (
            <TileLayer
              attribution='Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap'
              url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
              maxZoom={17}
            />
          )}

          {/* GPS Breadcrumb Trails */}
          {showBreadcrumbs && Array.from(gpsTrails.values()).map(trail => {
            if (trail.positions.length < 2) return null;

            const node = nodes.find(n => n.nodeId === trail.nodeId);
            if (!node) return null;

            const color = getNodeColor(node);
            const coords: [number, number][] = trail.positions.map(p => [p.latitude, p.longitude]);

            return (
              <Polyline
                key={trail.nodeId}
                positions={coords}
                pathOptions={{
                  color: color,
                  weight: 3,
                  opacity: 0.7,
                  dashArray: '5, 10',
                }}
              />
            );
          })}

          {/* Aircraft Trails */}
          {showAircraft && showAircraftTrails && Array.from(aircraftTrails.values()).map(trail => {
            if (trail.positions.length < 2) return null;
            const coords: [number, number][] = trail.positions.map(p => [p.lat, p.lon]);
            const color = trail.emergency ? '#ef4444' : '#22d3ee';
            return (
              <Polyline
                key={`ac-trail-${trail.icao}`}
                positions={coords}
                pathOptions={{ color, weight: 2, opacity: 0.55 }}
              />
            );
          })}

          {/* Node Markers */}
          {nodesWithPosition
            .filter(node => !(hideNonTeam && teamChannel !== null && !isTeamNode(node)))
            .map(node => (
            <Marker
              key={node.nodeId}
              position={[node.position!.latitude, node.position!.longitude]}
              icon={createNodeIcon(node)}
              opacity={teamChannel !== null && !isTeamNode(node) ? 0.4 : 1}
            >
              <Popup>
                <div className="min-w-[200px]">
                  <h3 className="font-bold text-lg mb-2">{node.longName}</h3>
                  <div className="text-sm space-y-1">
                    <div><strong>Call Sign:</strong> {node.shortName}</div>
                    <div><strong>Device:</strong> {node.hwModel}</div>
                    <div><strong>Position:</strong> {node.position!.latitude.toFixed(6)}, {node.position!.longitude.toFixed(6)}</div>
                    {node.position!.altitude && (
                      <div><strong>Altitude:</strong> {node.position!.altitude}m</div>
                    )}
                    <div><strong>Last Heard:</strong> {new Date(node.lastHeard).toLocaleString()}</div>
                    {node.batteryLevel !== undefined && (
                      <div><strong>Battery:</strong> {node.batteryLevel}%</div>
                    )}
                    {node.snr !== undefined && (
                      <div><strong>Signal (SNR):</strong> {node.snr} dB</div>
                    )}
                    {node.temperature !== undefined && (
                      <div><strong>Temperature:</strong> {node.temperature.toFixed(1)}°C / {((node.temperature * 9/5) + 32).toFixed(1)}°F</div>
                    )}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}

          {/* ADS-B Aircraft */}
          {showAircraft && visibleAircraft.map(ac => (
            <Marker
              key={ac.icao}
              position={[ac.lat, ac.lon]}
              icon={createAircraftIcon(ac)}
            >
              <Popup>
                <div className="min-w-[200px]">
                  <h3 className="font-bold text-lg mb-2">
                    {ac.callsign || ac.icao.toUpperCase()}
                    {ac.emergency && <span className="ml-2 text-red-600 text-sm">⚠ EMERGENCY</span>}
                  </h3>
                  <div className="text-sm space-y-1">
                    <div><strong>ICAO:</strong> {ac.icao.toUpperCase()}</div>
                    {ac.altFt !== undefined && (
                      <div><strong>Altitude:</strong> {Math.round(ac.altFt).toLocaleString()} ft</div>
                    )}
                    {ac.groundSpeedKt !== undefined && (
                      <div><strong>Ground Speed:</strong> {Math.round(ac.groundSpeedKt)} kt</div>
                    )}
                    {ac.track !== undefined && (
                      <div><strong>Heading:</strong> {Math.round(ac.track)}°</div>
                    )}
                    {ac.verticalRateFpm !== undefined && ac.verticalRateFpm !== 0 && (
                      <div><strong>Vertical Rate:</strong> {ac.verticalRateFpm > 0 ? '↑' : '↓'} {Math.abs(ac.verticalRateFpm).toLocaleString()} ft/min</div>
                    )}
                    {ac.squawk && (
                      <div><strong>Squawk:</strong> {ac.squawk}</div>
                    )}
                    <div><strong>Position:</strong> {ac.lat.toFixed(4)}, {ac.lon.toFixed(4)}</div>
                    {ac.rssi !== undefined && (
                      <div><strong>Signal:</strong> {ac.rssi.toFixed(1)} dBFS</div>
                    )}
                    {ac.seenPos !== undefined && (
                      <div><strong>Position Age:</strong> {ac.seenPos.toFixed(1)}s</div>
                    )}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}

          {/* Inbound TAK tracks (other TAK clients' positions + dropped markers) */}
          {visibleTakTracks.map(c => (
            <Marker
              key={`tak-${c.uid}`}
              position={[c.lat as number, c.lon as number]}
              icon={createTakIcon(c)}
            >
              <Popup>
                <div className="min-w-[200px]">
                  <h3 className="font-bold text-lg mb-2">
                    {c.callsign}
                    <span className="ml-2 text-xs uppercase text-purple-600">{c.kind}</span>
                  </h3>
                  <div className="text-sm space-y-1">
                    <div><strong>Source:</strong> TAK ({c.cotType})</div>
                    {c.team && <div><strong>Team:</strong> {c.team}{c.role ? ` • ${c.role}` : ''}</div>}
                    {c.platform && <div><strong>Platform:</strong> {c.platform}</div>}
                    <div><strong>Position:</strong> {(c.lat as number).toFixed(5)}, {(c.lon as number).toFixed(5)}</div>
                    {typeof c.speed === 'number' && c.speed > 0 && (
                      <div><strong>Speed:</strong> {(c.speed * 1.94384).toFixed(0)} kt</div>
                    )}
                    {typeof c.course === 'number' && (
                      <div><strong>Course:</strong> {Math.round(c.course)}°</div>
                    )}
                    {c.remarks && <div><strong>Remarks:</strong> {c.remarks}</div>}
                    {c.stale && <div><strong>Stale:</strong> {new Date(c.stale).toLocaleTimeString()}</div>}
                  </div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>

        {/* Cursor coordinate readout */}
        {cursor && (
          <div className="absolute bottom-2 left-2 z-[500] bg-slate-900/85 text-slate-200 text-[11px] font-mono px-2 py-1 rounded border border-slate-700 pointer-events-none leading-tight">
            <div>LL: {cursor.lat.toFixed(5)}, {cursor.lng.toFixed(5)}</div>
            <div>MGRS: {cursorMgrs}</div>
          </div>
        )}
        </div>
      </div>

      {/* Legend */}
      <div className="card">
        <h3 className="text-sm font-semibold text-white mb-3">Status Legend</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-green-500"></div>
            <span className="text-sm text-slate-300">Active (&lt; 5 min ago)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-yellow-500"></div>
            <span className="text-sm text-slate-300">Recent (5-30 min ago)</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-4 h-4 rounded-full bg-red-500"></div>
            <span className="text-sm text-slate-300">Stale (&gt; 30 min ago)</span>
          </div>
        </div>
      </div>

      {/* TAK / CoT Output */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white mb-1">🪖 TAK Feed (Cursor-on-Target)</h3>
            <p className="text-xs text-slate-400">
              Broadcast mesh nodes + aircraft to ATAK on your LAN via UDP multicast.
              {cotConfig && (
                <span className="text-slate-500">
                  {' '}→ {cotConfig.multicastAddr}:{cotConfig.multicastPort}
                </span>
              )}
            </p>
            <p className="text-[11px] text-slate-500 mt-1">
              Multicast stays on the local subnet (won't traverse Tailscale/WAN). ATAK clients auto-discover it.
            </p>
          </div>
          <label className="flex items-center gap-2 flex-shrink-0">
            <span className={`text-sm font-medium ${cotConfig?.enabled ? 'text-green-400' : 'text-slate-400'}`}>
              {cotConfig?.enabled ? 'ON' : 'OFF'}
            </span>
            <input
              type="checkbox"
              checked={!!cotConfig?.enabled}
              onChange={(e) => manager.setCotConfig({ enabled: e.target.checked })}
              className="w-5 h-5 text-green-600 bg-slate-700 border-slate-600 rounded focus:ring-green-500"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
