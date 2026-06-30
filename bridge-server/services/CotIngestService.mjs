/**
 * CotIngestService
 *
 * Inbound half of the TAK integration. Subscribes to a TAK Server's CoT stream
 * over mutual-TLS (port 8089) and parses the XML CoT that other TAK clients
 * broadcast — positions (contacts), markers, drawings/shapes, and GeoChat — then
 * surfaces them to the bridge so they appear on the monitoring map. Complements
 * CotService (outbound, send-only).
 *
 * XML-only: we do NOT negotiate the TAK protobuf protocol, so the server streams
 * plain XML CoT, which we parse with light regex extraction (CoT events are
 * simple and consistent). Reconnect-with-backoff mirrors CotService's TCP feed.
 *
 * Loop prevention: the bridge also FEEDS this same server (mesh nodes + aircraft
 * via the 8087 anonymous input), and the server relays that back to the group we
 * join — so we drop our own `meshtastic-*` / `adsb-*` uids.
 */

import tls from 'tls';
import fs from 'fs';
import { join } from 'path';

// --- tiny CoT/XML helpers (CoT is flat and predictable) ---
const attr = (xml, name) => {
  const m = String(xml).match(new RegExp('\\b' + name + '="([^"]*)"'));
  return m ? m[1] : undefined;
};
const tag = (xml, name) => {
  const m = String(xml).match(new RegExp('<' + name + '\\b[^>]*>'));
  return m ? m[0] : '';
};
const tagAttr = (xml, name, a) => attr(tag(xml, name), a);
const innerText = (xml, name) => {
  const m = String(xml).match(new RegExp('<' + name + '\\b[^>]*>([\\s\\S]*?)</' + name + '>'));
  return m ? m[1] : undefined;
};
const decodeXml = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export class CotIngestService {
  /**
   * @param {object} opts - { enabled, host, port, certsPath, certName, keyPass,
   *                          includeGeoChat, includeDrawings }
   * @param {Function} onEvent - (payload) => void  (forwarded to WS broadcast)
   * @param {Function} [logger] - (level, msg)
   */
  constructor(opts, onEvent, logger) {
    this.opts = opts || {};
    this.onEvent = onEvent || (() => {});
    this.log = logger || ((level, msg) => console.log(msg));
    this.socket = null;
    this.buffer = '';
    this.stopped = true;
    this.reconnectTimer = null;
    this.identityTimer = null;
  }

  start() {
    this.stop();
    this.stopped = false;
    if (!this.opts.enabled) {
      this.log('info', 'ℹ️  TAK ingest disabled');
      return;
    }
    this.connect();
  }

  connect() {
    if (this.stopped) return;
    const { host, port, certsPath, certName } = this.opts;
    const keyPass = this.opts.keyPass || 'atakatak';

    let cert, key, ca;
    try {
      cert = fs.readFileSync(join(certsPath, `${certName}.pem`));
      key = fs.readFileSync(join(certsPath, `${certName}.key`));
      ca = fs.readFileSync(join(certsPath, 'ca.pem'));
    } catch (e) {
      this.log('warn', `⚠️  TAK ingest: cert not readable at ${certsPath}/${certName} — ${e.message}`);
      this.scheduleReconnect();
      return;
    }

    this.log('info', `🛰️  TAK ingest → ${host}:${port} (connecting…)`);
    const sock = tls.connect({
      host,
      port,
      cert,
      key,
      ca,
      passphrase: keyPass,
      rejectUnauthorized: true,
      // We dial our own private CA by IP/localhost; the server cert CN is
      // "takserver" (not the dialed host), so validate the chain against our CA
      // but don't enforce the hostname match.
      checkServerIdentity: () => undefined,
    });
    sock.setEncoding('utf8');

    sock.on('secureConnect', () => {
      this.log('info', `✅ TAK ingest connected → ${host}:${port}`);
      this.sendIdentity();
      // Re-announce so the server keeps us subscribed in the group.
      this.identityTimer = setInterval(() => this.sendIdentity(), 60000);
    });
    sock.on('data', (chunk) => this.onData(chunk));
    sock.on('error', (e) => this.log('warn', `⚠️  TAK ingest error: ${e.message}`));
    sock.on('close', () => {
      this.clearIdentityTimer();
      if (!this.stopped) {
        this.log('warn', '⚠️  TAK ingest connection closed');
        this.scheduleReconnect();
      }
    });

    this.socket = sock;
  }

  /** Announce ourselves so the server adds us to the group and streams traffic. */
  sendIdentity() {
    if (!this.socket || this.socket.destroyed) return;
    const now = new Date();
    const stale = new Date(now.getTime() + 5 * 60000);
    const iso = (d) => d.toISOString();
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<event version="2.0" uid="meshbridge-monitor" type="a-f-G-U-C" how="m-g" ` +
      `time="${iso(now)}" start="${iso(now)}" stale="${iso(stale)}">` +
      `<point lat="0" lon="0" hae="9999999.0" ce="9999999.0" le="9999999.0"/>` +
      `<detail><contact callsign="MeshBridge-Monitor"/>` +
      `<__group name="__ANON__" role="Team Member"/>` +
      `<takv device="bridge" platform="MeshBridge" version="1.0"/>` +
      `<uid Droid="MeshBridge-Monitor"/></detail></event>`;
    try { this.socket.write(xml + '\n'); } catch { /* ignore */ }
  }

  onData(chunk) {
    this.buffer += chunk;
    // Guard against unbounded growth if a frame boundary never arrives.
    if (this.buffer.length > 1_000_000) this.buffer = this.buffer.slice(-200_000);
    let idx;
    while ((idx = this.buffer.indexOf('</event>')) !== -1) {
      const end = idx + '</event>'.length;
      const frame = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const start = frame.indexOf('<event');
      if (start === -1) continue;
      this.handleEvent(frame.slice(start));
    }
  }

  handleEvent(xml) {
    try {
      const evt = tag(xml, 'event');
      const uid = attr(evt, 'uid');
      const type = attr(evt, 'type');
      if (!uid || !type) return;

      // Loop prevention: our own outbound feed relayed back by the server.
      if (uid.startsWith('meshtastic-') || uid.startsWith('adsb-') || uid === 'meshbridge-monitor') return;

      const stale = attr(evt, 'stale');
      const time = attr(evt, 'time');

      // --- delete: remove a uid from the map ---
      if (type.startsWith('t-x-d-d')) {
        const linkUid = tagAttr(xml, 'link', 'uid') || uid;
        this.onEvent({ type: 'tak-remove', uid: linkUid });
        return;
      }

      // Drop all other t-x-* tasking/control events (protocol pings like
      // t-x-takp-v, connection tests, etc.) — they aren't map objects.
      if (type.startsWith('t-x-')) return;

      // --- GeoChat ---
      if (type.startsWith('b-t-f')) {
        if (this.opts.includeGeoChat === false) return;
        // Drop the server's echo of GeoChat we ourselves relayed up from the mesh
        // (loop prevention for the chat bridge).
        if (uid.includes('meshrelay')) return;
        const chat = tag(xml, '__chat');
        this.onEvent({
          type: 'tak-chat',
          chat: {
            uid,
            room: attr(chat, 'chatroom') || 'All Chat Rooms',
            sender: attr(chat, 'senderCallsign') || tagAttr(xml, 'contact', 'callsign') || 'unknown',
            text: decodeXml(innerText(xml, 'remarks') || ''),
            time: time || new Date().toISOString(),
          },
        });
        return;
      }

      const callsign = tagAttr(xml, 'contact', 'callsign') || tagAttr(xml, 'uid', 'Droid') || uid;
      const grp = tag(xml, '__group');
      const team = attr(grp, 'name');
      const role = attr(grp, 'role');
      const remarks = decodeXml(innerText(xml, 'remarks') || '');

      // --- drawings / shapes: geometry lives in <link point="lat,lon,hae"/> ---
      if (type.startsWith('u-d')) {
        if (this.opts.includeDrawings === false) return;
        const points = [...String(xml).matchAll(/<link\b[^>]*\bpoint="([^"]+)"[^>]*>/g)]
          .map((m) => m[1].split(',').slice(0, 2).map(Number))
          .filter((p) => p.length === 2 && p.every(Number.isFinite));
        const p = tag(xml, 'point');
        const lat = parseFloat(attr(p, 'lat'));
        const lon = parseFloat(attr(p, 'lon'));
        this.onEvent({
          type: 'tak-update',
          contact: {
            uid, source: 'tak', kind: 'drawing', cotType: type, callsign,
            lat: Number.isFinite(lat) ? lat : points[0]?.[0],
            lon: Number.isFinite(lon) ? lon : points[0]?.[1],
            team, role, remarks, stale, points,
          },
        });
        return;
      }

      // --- positional: contacts (have <takv>) vs markers (no <takv>) ---
      const p = tag(xml, 'point');
      const lat = parseFloat(attr(p, 'lat'));
      const lon = parseFloat(attr(p, 'lon'));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      const takv = tag(xml, 'takv');
      const trk = tag(xml, 'track');
      const course = trk ? parseFloat(attr(trk, 'course')) : undefined;
      const speed = trk ? parseFloat(attr(trk, 'speed')) : undefined;

      this.onEvent({
        type: 'tak-update',
        contact: {
          uid, source: 'tak',
          kind: takv ? 'contact' : 'marker',
          cotType: type, callsign,
          lat, lon, team, role,
          course: Number.isFinite(course) ? course : undefined,
          speed: Number.isFinite(speed) ? speed : undefined,
          platform: attr(takv, 'platform'),
          remarks, stale,
        },
      });
    } catch (e) {
      this.log('warn', `⚠️  TAK ingest parse error: ${e.message}`);
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  clearIdentityTimer() {
    if (this.identityTimer) { clearInterval(this.identityTimer); this.identityTimer = null; }
  }

  stop() {
    this.stopped = true;
    this.buffer = '';
    this.clearIdentityTimer();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}
