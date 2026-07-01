/**
 * CotService
 *
 * Emits Cursor-on-Target (CoT) events for mesh nodes and ADS-B aircraft so they
 * appear in ATAK/WinTAK. Sends via UDP multicast to the standard ATAK SA group
 * (239.2.3.1:6969) — any ATAK client on the same LAN auto-discovers the tracks.
 *
 * Note: multicast does NOT traverse Tailscale/WAN. Remote ATAK clients need a
 * TAK Server or a TCP CoT feed (a later enhancement); LAN ATAK works directly.
 *
 * The Aircraft/MeshNode shapes were designed to map cleanly to CoT, so this is
 * mostly a serializer.
 */

import dgram from 'dgram';
import net from 'net';
import { nodeCotType, CATEGORY_LABEL } from './nodeClassification.mjs';

const escapeXml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => (
  { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
));

export class CotService {
  /**
   * @param {object} opts - { enabled, multicastAddr, multicastPort, multicastTtl,
   *                          callsignPrefix, nodeStaleSec, aircraftStaleSec,
   *                          publishNodes, publishAircraft, teamColor, teamRole }
   * @param {Function} [logger] - (level, msg)
   */
  constructor(opts, logger) {
    this.opts = opts;
    this.log = logger || ((level, msg) => console.log(msg));
    this.socket = null;       // UDP multicast socket
    this.tcpSocket = null;    // TCP feed to a TAK server (e.g. FreeTAKServer)
    this.tcpConnected = false;
    this.tcpReconnectTimer = null;
    this.stopped = true;
    // Outbound CoT is paced through a queue so a burst (e.g. many aircraft) doesn't
    // coalesce in the TCP stream — some TAK servers (FreeTAKServer) mis-parse two
    // CoT events read together. One event per drain tick keeps each self-contained.
    this.queue = [];
    this.drainTimer = null;
  }

  start() {
    this.stop();
    this.stopped = false;
    if (!this.opts.enabled) {
      this.log('info', 'ℹ️  CoT/TAK output disabled');
      return;
    }
    // UDP multicast output (LAN ATAK auto-discovery)
    if (this.opts.multicastEnabled !== false) {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.socket.on('error', (e) => this.log('warn', `⚠️  CoT multicast error: ${e.message}`));
      this.socket.bind(() => {
        try { this.socket.setMulticastTTL(this.opts.multicastTtl || 1); } catch { /* ignore */ }
        this.log('info', `🪖 CoT multicast → ${this.opts.multicastAddr}:${this.opts.multicastPort}`);
      });
    }
    // TCP feed to a TAK server (e.g. FreeTAKServer on 8087)
    if (this.opts.tcpHost && this.opts.tcpPort) {
      this.connectTcp();
    }
    // Drain the outbound queue, one CoT event per tick.
    this.drainTimer = setInterval(() => this.drain(), 30);
  }

  connectTcp() {
    if (this.stopped) return;
    this.log('info', `🪖 CoT TCP feed → ${this.opts.tcpHost}:${this.opts.tcpPort} (connecting…)`);
    const sock = net.connect({ host: this.opts.tcpHost, port: this.opts.tcpPort });
    sock.setKeepAlive(true, 15000);
    sock.on('connect', () => {
      this.tcpConnected = true;
      this.tcpLastConnectedAt = new Date().toISOString();
      this.tcpLastError = null;
      try { sock.setNoDelay(true); } catch { /* ignore */ }
      this.log('info', `✅ CoT TCP feed connected → ${this.opts.tcpHost}:${this.opts.tcpPort}`);
    });
    const retry = () => {
      this.tcpConnected = false;
      this.tcpSocket = null;
      if (this.stopped) return;
      if (this.tcpReconnectTimer) return;
      this.tcpReconnectTimer = setTimeout(() => {
        this.tcpReconnectTimer = null;
        this.connectTcp();
      }, 5000);
    };
    sock.on('error', (e) => { this.tcpLastError = e.message; this.log('warn', `⚠️  CoT TCP feed error: ${e.message}`); });
    sock.on('close', () => { retry(); });
    this.tcpSocket = sock;
  }

  /** Live status of the outbound TCP feed (for the UI). */
  getFeedStatus() {
    return {
      feedEnabled: !!(this.opts.enabled && this.opts.tcpHost),
      feedConnected: !!this.tcpConnected,
      feedLastError: this.tcpLastError || null,
      feedLastConnectedAt: this.tcpLastConnectedAt || null,
      feedTarget: this.opts.tcpHost ? `${this.opts.tcpHost}:${this.opts.tcpPort}` : null,
    };
  }

  stop() {
    this.stopped = true;
    this.queue = [];
    if (this.drainTimer) { clearInterval(this.drainTimer); this.drainTimer = null; }
    if (this.tcpReconnectTimer) { clearTimeout(this.tcpReconnectTimer); this.tcpReconnectTimer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
    if (this.tcpSocket) {
      try { this.tcpSocket.destroy(); } catch { /* ignore */ }
      this.tcpSocket = null;
      this.tcpConnected = false;
    }
  }

  /** Queue a CoT event for paced delivery (drops oldest if backed up). */
  send(xml) {
    this.queue.push(xml);
    if (this.queue.length > 1000) this.queue.splice(0, this.queue.length - 1000);
  }

  /** Emit one queued CoT event to all active outputs (multicast + TCP feed). */
  drain() {
    const xml = this.queue.shift();
    if (!xml) return;
    if (this.socket) {
      const buf = Buffer.from(xml);
      this.socket.send(buf, this.opts.multicastPort, this.opts.multicastAddr, (err) => {
        if (err) this.log('warn', `⚠️  CoT multicast send failed: ${err.message}`);
      });
    }
    if (this.tcpConnected && this.tcpSocket) {
      try { this.tcpSocket.write(xml + '\n'); } catch (e) { this.log('warn', `⚠️  CoT TCP write failed: ${e.message}`); }
    }
  }

  iso(date) { return date.toISOString(); }

  /** Build a CoT <event> string. */
  buildEvent({ uid, type, lat, lon, hae, staleSec, callsign, course, speed, remarks, group }) {
    const now = new Date();
    const stale = new Date(now.getTime() + staleSec * 1000);
    const groupXml = group
      ? `<__group name="${escapeXml(group.name)}" role="${escapeXml(group.role)}"/>`
      : '';
    const trackXml = (course !== undefined || speed !== undefined)
      ? `<track course="${Number(course || 0).toFixed(1)}" speed="${Number(speed || 0).toFixed(1)}"/>`
      : '';
    const remarksXml = remarks ? `<remarks>${escapeXml(remarks)}</remarks>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<event version="2.0" uid="${escapeXml(uid)}" type="${type}" how="m-g" ` +
      `time="${this.iso(now)}" start="${this.iso(now)}" stale="${this.iso(stale)}">` +
      `<point lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}" hae="${(hae ?? 9999999.0)}" ce="9999999.0" le="9999999.0"/>` +
      `<detail>` +
      `<contact callsign="${escapeXml(callsign)}"/>` +
      groupXml + trackXml + remarksXml +
      `</detail></event>`;
  }

  /** Publish a single mesh node (must have a position). */
  publishNode(node) {
    if (!this.opts.enabled || !this.opts.publishNodes) return;
    if (!node.position || typeof node.position.latitude !== 'number') return;
    const callsign = `${this.opts.callsignPrefix || ''}${node.shortName || node.longName || node.nodeId}`;

    // Classify so the node shows in TAK as the right thing (sensor/relay/radio/unit)
    // instead of a blanket friendly combat unit. Toggle off to keep legacy behavior.
    let type = 'a-f-G-U-C';
    let category = 'unit';
    if (this.opts.classifyNodes !== false) {
      ({ category, cotType: type } = nodeCotType(node, this.opts.nodeTypes));
    }

    // Environmental readings → a readable line in the marker remarks.
    const env = [
      node.temperature != null ? `${Number(node.temperature).toFixed(1)}°C` : null,
      node.humidity != null ? `${Math.round(node.humidity)}%RH` : null,
      node.pressure != null ? `${Math.round(node.pressure)}hPa` : null,
    ].filter(Boolean).join(' ');
    const remarks = [
      `${CATEGORY_LABEL[category] || 'Node'} · ${node.hwModel || 'mesh'}`,
      node.role ? `role ${node.role}` : null,
      node.batteryLevel !== undefined ? `batt ${node.batteryLevel}%` : null,
      env || null,
    ].filter(Boolean).join(' · ');

    this.send(this.buildEvent({
      uid: `meshtastic-${node.nodeId}`,
      type,
      lat: node.position.latitude,
      lon: node.position.longitude,
      hae: typeof node.position.altitude === 'number' ? node.position.altitude : 9999999.0,
      staleSec: this.opts.nodeStaleSec || 300,
      callsign,
      group: { name: this.opts.teamColor || 'Cyan', role: this.opts.teamRole || 'Team Member' },
      remarks,
    }));
  }

  /** Publish a batch of ADS-B aircraft. */
  publishAircraft(list) {
    if (!this.opts.enabled || !this.opts.publishAircraft) return;
    for (const ac of list || []) {
      if (typeof ac.lat !== 'number' || typeof ac.lon !== 'number') continue;
      this.send(this.buildEvent({
        uid: `adsb-${ac.icao}`,
        type: ac.emergency ? 'a-h-A-C-F' : 'a-n-A-C-F', // hostile if emergency squawk, else neutral civil fixed-wing
        lat: ac.lat,
        lon: ac.lon,
        hae: typeof ac.altFt === 'number' ? ac.altFt * 0.3048 : 9999999.0, // ft -> m
        staleSec: this.opts.aircraftStaleSec || 60,
        callsign: ac.callsign || ac.icao.toUpperCase(),
        course: ac.track,
        speed: typeof ac.groundSpeedKt === 'number' ? ac.groundSpeedKt * 0.514444 : undefined, // kt -> m/s
        remarks: `ADS-B ${ac.altFt ? `${Math.round(ac.altFt)}ft ` : ''}${ac.squawk ? `sq ${ac.squawk}` : ''}`.trim(),
      }));
    }
  }

  /**
   * Publish a GeoChat (b-t-f) message to TAK so non-Meshtastic devices see it in
   * chat. Matches ATAK/TROP's exact structure so clients render the sender name
   * (not "Unknown"): a single consistent senderUid threads through the event uid,
   * <contact>, <__chat senderUid/chatgrp uid0>, <remarks source/sourceID>, and
   * <link uid>. The senderUid is the node's marker uid (meshtastic-<id>) so the
   * chat ties to the map marker — and lets the ingest drop the server's echo of
   * our own message (loop prevention).
   * @param {object} o - { senderUid, callsign, text, messageId, chatroom?, staleSec? }
   */
  publishGeoChat(o) {
    if (!this.opts.enabled) return;
    const now = new Date();
    const stale = new Date(now.getTime() + (o.staleSec || 86400) * 1000);
    const iso = (d) => d.toISOString();
    const room = escapeXml(o.chatroom || 'All Chat Rooms');
    const callsign = escapeXml(o.callsign || 'mesh');
    const suid = escapeXml(o.senderUid);
    const mid = escapeXml(o.messageId);
    const uid = `GeoChat.${suid}.${room}.${mid}`;
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<event version="2.0" uid="${uid}" type="b-t-f" how="h-g-i-g-o" ` +
      `time="${iso(now)}" start="${iso(now)}" stale="${iso(stale)}">` +
      `<point lat="0.0" lon="0.0" hae="9999999" ce="9999999" le="9999999"/>` +
      `<detail>` +
        `<contact callsign="${callsign}"/>` +
        `<__chat groupOwner="false" messageId="${mid}" chatroom="${room}" id="${room}" senderCallsign="${callsign}" senderUid="${suid}">` +
          `<chatgrp uid0="${suid}" id="${room}"/>` +
        `</__chat>` +
        `<remarks source="BAO.F.MeshBridge.${suid}" sourceID="${suid}" time="${iso(now)}">${escapeXml(o.text || '')}</remarks>` +
        `<link uid="${suid}" type="a-f-G-U-C" relation="p-p"/>` +
      `</detail></event>`;
    this.send(xml);
  }
}
