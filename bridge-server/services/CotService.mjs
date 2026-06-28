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
    this.socket = null;
  }

  start() {
    this.stop();
    if (!this.opts.enabled) {
      this.log('info', 'ℹ️  CoT/TAK output disabled');
      return;
    }
    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', (e) => this.log('warn', `⚠️  CoT socket error: ${e.message}`));
    this.socket.bind(() => {
      try { this.socket.setMulticastTTL(this.opts.multicastTtl || 1); } catch { /* ignore */ }
      this.log('info', `🪖 CoT/TAK output → ${this.opts.multicastAddr}:${this.opts.multicastPort} (multicast)`);
    });
  }

  stop() {
    if (this.socket) {
      try { this.socket.close(); } catch { /* ignore */ }
      this.socket = null;
    }
  }

  /** Send a raw CoT XML datagram. */
  send(xml) {
    if (!this.socket) return;
    const buf = Buffer.from(xml);
    this.socket.send(buf, this.opts.multicastPort, this.opts.multicastAddr, (err) => {
      if (err) this.log('warn', `⚠️  CoT send failed: ${err.message}`);
    });
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
    if (!this.opts.enabled || !this.opts.publishNodes || !this.socket) return;
    if (!node.position || typeof node.position.latitude !== 'number') return;
    const callsign = `${this.opts.callsignPrefix || ''}${node.shortName || node.longName || node.nodeId}`;
    this.send(this.buildEvent({
      uid: `meshtastic-${node.nodeId}`,
      type: 'a-f-G-U-C', // friendly ground unit, combat
      lat: node.position.latitude,
      lon: node.position.longitude,
      hae: typeof node.position.altitude === 'number' ? node.position.altitude : 9999999.0,
      staleSec: this.opts.nodeStaleSec || 300,
      callsign,
      group: { name: this.opts.teamColor || 'Cyan', role: this.opts.teamRole || 'Team Member' },
      remarks: `Meshtastic ${node.hwModel || ''} ${node.batteryLevel !== undefined ? `batt ${node.batteryLevel}%` : ''}`.trim(),
    }));
  }

  /** Publish a batch of ADS-B aircraft. */
  publishAircraft(list) {
    if (!this.opts.enabled || !this.opts.publishAircraft || !this.socket) return;
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
}
