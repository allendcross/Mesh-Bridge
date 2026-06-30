/**
 * MessageRecorderService
 *
 * Durable, append-only record of every mesh message the bridge hears, written to
 * daily JSONL files on disk. The bridge is an always-on station at a fixed
 * location, so this builds a complete log of the public channel (and any private
 * channel like chopstak) that survives restarts and isn't tied to a browser's
 * localStorage. Queryable + exportable so a fixed station's record can be compared
 * against a mobile node's partial view.
 *
 * One file per local day: messages-YYYY-MM-DD.jsonl, one JSON object per line.
 */

import { promises as fs } from 'fs';
import { mkdirSync } from 'fs';
import { join } from 'path';

const FILE_RE = /^messages-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export class MessageRecorderService {
  /**
   * @param {object} opts - { enabled, dir, retentionDays }
   * @param {Function} [logger] - (level, msg)
   */
  constructor(opts, logger) {
    this.opts = opts || {};
    this.dir = this.opts.dir;
    this.log = logger || ((level, msg) => console.log(msg));
    this.cleanupTimer = null;
    if (this.opts.enabled && this.dir) {
      try { mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
    }
  }

  start() {
    if (!this.opts.enabled) { this.log('info', 'ℹ️  Message recorder disabled'); return; }
    this.log('info', `📼 Message recorder → ${this.dir} (retain ${this.opts.retentionDays || 0}d)`);
    this.cleanup();
    this.cleanupTimer = setInterval(() => this.cleanup(), 6 * 60 * 60 * 1000); // every 6h
  }

  stop() {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }

  dateStr(ts) {
    const dt = ts instanceof Date ? ts : new Date(ts || Date.now());
    return dt.toISOString().slice(0, 10);
  }
  fileForDate(day) { return join(this.dir, `messages-${day}.jsonl`); }

  /** Append one record (a plain object) to today's file. */
  async record(rec) {
    if (!this.opts.enabled || !this.dir) return;
    try {
      const day = this.dateStr(rec.ts);
      await fs.appendFile(this.fileForDate(day), JSON.stringify(rec) + '\n');
    } catch (e) {
      this.log('warn', `⚠️  Message recorder write failed: ${e.message}`);
    }
  }

  /** Available record days (YYYY-MM-DD), newest first. */
  async listDays() {
    try {
      const files = await fs.readdir(this.dir);
      return files.map(f => (FILE_RE.exec(f) || [])[1]).filter(Boolean).sort().reverse();
    } catch { return []; }
  }

  /**
   * Query records newest-first.
   * @param {object} q - { date?, channelIndex?, search?, limit?, sinceMs? }
   */
  async query(q = {}) {
    const { date, channelIndex, search, limit = 500, sinceMs } = q;
    const days = date ? [date] : await this.listDays();
    const term = (search || '').toLowerCase();
    const out = [];
    for (const day of days) {
      let data;
      try { data = await fs.readFile(this.fileForDate(day), 'utf8'); } catch { continue; }
      const lines = data.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        if (channelIndex != null && rec.channel !== channelIndex) continue;
        if (sinceMs && new Date(rec.ts).getTime() < sinceMs) continue;
        if (term &&
            !(rec.text || '').toLowerCase().includes(term) &&
            !(rec.fromName || '').toLowerCase().includes(term)) continue;
        out.push(rec);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Per-channel + total counts across all days (for a quick overview). */
  async stats() {
    const days = await this.listDays();
    let total = 0;
    const byChannel = {};
    for (const day of days) {
      let data;
      try { data = await fs.readFile(this.fileForDate(day), 'utf8'); } catch { continue; }
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; }
        total++;
        const key = `${rec.channel ?? '?'}:${rec.channelName || ''}`;
        byChannel[key] = (byChannel[key] || 0) + 1;
      }
    }
    return { total, days: days.length, byChannel, oldest: days[days.length - 1], newest: days[0] };
  }

  /** Delete day-files older than retentionDays. */
  async cleanup() {
    const keep = Number(this.opts.retentionDays || 0);
    if (!keep) return;
    const cutoff = new Date(Date.now() - keep * 86400000).toISOString().slice(0, 10);
    for (const day of await this.listDays()) {
      if (day < cutoff) {
        try { await fs.unlink(this.fileForDate(day)); this.log('info', `🗑️  Pruned message log ${day}`); }
        catch { /* ignore */ }
      }
    }
  }
}
