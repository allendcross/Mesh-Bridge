/**
 * AdsbService
 *
 * Polls an ADS-B aircraft source on an interval, normalizes the result into a
 * common CoT-friendly Aircraft shape, and hands it to a broadcast callback so
 * the bridge can push it to WebSocket clients.
 *
 * Two source modes (both reduce to "fetch JSON -> normalize"):
 *   - 'dump1090': a local/LAN dump1090 (legacy / FlightRadar24 image) JSON URL,
 *                 e.g. http://192.168.0.27/dump1090/data/aircraft.json
 *   - 'network':  the free airplanes.live point API (REST by lat/lon/radius).
 *
 * Aircraft are ephemeral and high-volume (opposite of mesh nodes). Only
 * positioned aircraft fresher than `staleSeconds` are emitted; the frontend
 * snapshot-replaces its state each tick and fades markers as they age, so the
 * map never fills with long-gone contacts.
 */

const EMERGENCY_SQUAWKS = new Set(['7500', '7600', '7700']); // hijack / radio-fail / general

export class AdsbService {
  /**
   * @param {object} opts        - { enabled, source, url, lat, lon, radiusNm, pollIntervalMs, staleSeconds, maxAircraft }
   * @param {Function} broadcast  - called with a JSON-serializable payload to push to clients
   * @param {Function} [logger]   - optional (level, msg) logger; defaults to console
   */
  constructor(opts, broadcast, logger) {
    this.opts = opts;
    this.broadcast = broadcast;
    this.log = logger || ((level, msg) => console.log(msg));
    this.timer = null;
    this.lastError = null;
    this.consecutiveErrors = 0;
  }

  start() {
    this.stop();
    if (!this.opts.enabled) {
      this.log('info', 'ℹ️  ADS-B disabled');
      return;
    }
    const interval = Math.max(1000, this.opts.pollIntervalMs || 2000);
    this.log('info', `✈️  ADS-B enabled (source: ${this.opts.source}, every ${interval}ms)`);
    // Immediate first poll, then on the interval.
    this.poll();
    this.timer = setInterval(() => this.poll(), interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Build the request URL for the configured source. */
  buildUrl() {
    if (this.opts.source === 'network') {
      const lat = this.opts.lat ?? 0;
      const lon = this.opts.lon ?? 0;
      const radius = this.opts.radiusNm || 100;
      return `https://api.airplanes.live/v2/point/${lat}/${lon}/${radius}`;
    }
    // 'dump1090' (default): poll the configured aircraft.json URL directly.
    return this.opts.url;
  }

  async poll() {
    const url = this.buildUrl();
    if (!url) {
      this.log('warn', '⚠️  ADS-B: no source URL configured');
      return;
    }
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const aircraft = this.opts.source === 'network'
        ? this.normalizeNetwork(json)
        : this.normalizeDump1090(json);

      this.consecutiveErrors = 0;
      this.lastError = null;

      this.broadcast({
        type: 'aircraft-update',
        source: this.opts.source,
        staleSeconds: this.opts.staleSeconds ?? 15,
        count: aircraft.length,
        ts: Date.now(),
        aircraft,
      });
    } catch (err) {
      this.consecutiveErrors++;
      this.lastError = err.message;
      // Don't spam the log on a persistently-down feed — warn on first failure
      // and then every 30th poll thereafter.
      if (this.consecutiveErrors === 1 || this.consecutiveErrors % 30 === 0) {
        this.log('warn', `⚠️  ADS-B poll failed (${this.consecutiveErrors}x): ${err.message}`);
      }
      // Tell clients the feed is down so the UI can clear stale aircraft.
      this.broadcast({
        type: 'aircraft-update',
        source: this.opts.source,
        staleSeconds: this.opts.staleSeconds ?? 15,
        count: 0,
        ts: Date.now(),
        aircraft: [],
        error: err.message,
      });
    }
  }

  /** Normalize legacy dump1090 / FlightRadar24-image aircraft.json. */
  normalizeDump1090(json) {
    const list = Array.isArray(json?.aircraft) ? json.aircraft : [];
    const stale = this.opts.staleSeconds ?? 15;
    const out = [];
    for (const a of list) {
      // Map-able only if it self-reported a position.
      if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
      const seenPos = typeof a.seen_pos === 'number' ? a.seen_pos : 0;
      if (seenPos > stale) continue; // drop long-gone positions server-side
      out.push(this.toAircraft({
        hex: a.hex,
        flight: a.flight,
        lat: a.lat,
        lon: a.lon,
        altFt: typeof a.altitude === 'number' ? a.altitude : undefined, // already feet
        track: typeof a.track === 'number' ? a.track : undefined,
        groundSpeedKt: typeof a.speed === 'number' ? a.speed : undefined, // already knots
        verticalRateFpm: typeof a.vert_rate === 'number' ? a.vert_rate : undefined,
        squawk: a.squawk,
        category: a.category,
        rssi: typeof a.rssi === 'number' ? a.rssi : undefined,
        seenPos,
        seen: typeof a.seen === 'number' ? a.seen : undefined,
      }));
    }
    return this.cap(out);
  }

  /** Normalize airplanes.live v2 point response. */
  normalizeNetwork(json) {
    const list = Array.isArray(json?.ac) ? json.ac : [];
    const stale = this.opts.staleSeconds ?? 15;
    const out = [];
    for (const a of list) {
      if (typeof a.lat !== 'number' || typeof a.lon !== 'number') continue;
      const seenPos = typeof a.seen_pos === 'number' ? a.seen_pos : 0;
      if (seenPos > stale) continue;
      // alt_baro may be the string "ground"
      const altFt = typeof a.alt_baro === 'number' ? a.alt_baro
        : (typeof a.alt_geom === 'number' ? a.alt_geom : undefined);
      out.push(this.toAircraft({
        hex: a.hex,
        flight: a.flight,
        lat: a.lat,
        lon: a.lon,
        altFt,
        track: typeof a.track === 'number' ? a.track : a.nav_heading,
        groundSpeedKt: typeof a.gs === 'number' ? a.gs : undefined,
        verticalRateFpm: typeof a.baro_rate === 'number' ? a.baro_rate : a.geom_rate,
        squawk: a.squawk,
        category: a.category,
        rssi: typeof a.rssi === 'number' ? a.rssi : undefined,
        seenPos,
        seen: typeof a.seen === 'number' ? a.seen : undefined,
      }));
    }
    return this.cap(out);
  }

  /** Shared field assembly + emergency derivation. */
  toAircraft(f) {
    const callsign = (f.flight || '').trim() || undefined;
    const squawk = f.squawk || undefined;
    return {
      icao: (f.hex || '').toLowerCase(),
      callsign,
      lat: f.lat,
      lon: f.lon,
      altFt: f.altFt,
      track: f.track,
      groundSpeedKt: f.groundSpeedKt,
      verticalRateFpm: f.verticalRateFpm,
      squawk,
      category: f.category,
      rssi: f.rssi,
      seenPos: f.seenPos,
      seen: f.seen,
      emergency: squawk ? EMERGENCY_SQUAWKS.has(squawk) : false,
    };
  }

  /** Cap the number of aircraft, keeping the freshest positions. */
  cap(list) {
    const max = this.opts.maxAircraft || 500;
    if (list.length <= max) return list;
    return list
      .slice()
      .sort((a, b) => (a.seenPos ?? 0) - (b.seenPos ?? 0))
      .slice(0, max);
  }
}
