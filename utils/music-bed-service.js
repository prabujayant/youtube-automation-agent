const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');

// Free music beds with verified, license-safe direct MP3 sources.
// Every entry is CC-BY (attribution required — the ranked Shorts description
// builder adds the music credit automatically).
const MUSIC_SOURCE = 'incompetech.com';
const MUSIC_LICENSE = 'cc-by';
const MUSIC_LICENSE_SOURCE = 'CC-BY 4.0 — https://creativecommons.org/licenses/by/4.0/ — music by Kevin MacLeod (incompetech.com)';

// mood: the travel tone that matches the destination showcase format.
const CATALOG = [
  { track: 'Carefree', mood: 'uplifting' },
  { track: 'Wallpaper', mood: 'uplifting' },
  { track: 'Digital Lemonade', mood: 'uplifting' },
  { track: 'Bright Wish', mood: 'uplifting' },
  { track: 'Daybreak', mood: 'uplifting' },
  { track: 'Morning', mood: 'ambient' },
  { track: 'Bossa Antigua', mood: 'tropical' },
  { track: 'Beachfront Celebration', mood: 'tropical' },
  { track: 'Tafi Maradi', mood: 'ambient' },
  { track: 'Daily Beetle', mood: 'playful' },
  { track: 'Fluffing a Duck', mood: 'playful' },
  { track: 'Sneaky Snitch', mood: 'playful' },
  { track: 'Monkeys Spinning Monkeys', mood: 'playful' },
  { track: 'Carnivale Intrigue', mood: 'tropical' }
];

class MusicBedService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('MusicBed');
    this.cacheRoot = options.cacheRoot || path.join(__dirname, '..', 'data', 'footage', 'music');
    this.libraryRoot = options.libraryRoot || path.join(__dirname, '..', 'data', 'footage', 'music-library');
    this.fetch = options.fetch || globalThis.fetch;
    this.catalog = options.catalog || CATALOG;
    this.baseUrl = options.baseUrl || 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/';
  }

  isAvailable() {
    return typeof this.fetch === 'function' && this.catalog.length > 0;
  }

  isConfigured() {
    return this.isAvailable();
  }

  static license() {
    return { license: MUSIC_LICENSE, licenseSource: MUSIC_LICENSE_SOURCE };
  }

  pick(mood, options = {}) {
    const pool = this.catalog.filter(entry => !mood || entry.mood === mood);
    const usable = pool.length ? pool : this.catalog;
    if (!usable.length) return null;
    const dayIndex = options.dayIndex === undefined
      ? Math.floor(Date.now() / 86400000)
      : Number(options.dayIndex);
    return usable[dayIndex % usable.length];
  }

  url(entry) {
    return `${this.baseUrl}${encodeURIComponent(entry.track)}.mp3`;
  }

  async download(entry) {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    const safe = entry.track.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const target = path.join(this.cacheRoot, `${safe}.mp3`);
    try {
      const stats = await fs.stat(target);
      if (stats.isFile() && stats.size > 100000) return { path: target, cached: true };
    } catch (_error) {
      // not cached yet
    }
    const response = await this.fetch(this.url(entry));
    if (!response.ok) {
      const error = new Error(`Music download failed for ${entry.track} (HTTP ${response.status})`);
      error.code = 'MUSIC_DOWNLOAD_FAILED';
      error.status = 400;
      throw error;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 100000) {
      const error = new Error(`Music download for ${entry.track} returned an unexpected file`);
      error.code = 'MUSIC_DOWNLOAD_FAILED';
      error.status = 400;
      throw error;
    }
    await fs.writeFile(target, buffer);
    return { path: target, cached: false };
  }

  // Tracks the channel drops into data/footage/music-library override the
  // online catalog (rotated per day) — the way to use custom or trending-style
  // songs the channel supplies itself.
  async pickLocal(mood, options = {}) {
    try {
      const files = (await fs.readdir(this.libraryRoot))
        .filter(name => /\.(mp3|m4a|wav|ogg)$/i.test(name))
        .sort();
      if (!files.length) return null;
      const dayIndex = options.dayIndex === undefined
        ? Math.floor(Date.now() / 86400000)
        : Number(options.dayIndex);
      const file = files[dayIndex % files.length];
      return { path: path.join(this.libraryRoot, file), cached: true, entry: null, localTrack: file };
    } catch (_error) {
      return null;
    }
  }

  async resolve(input = {}) {
    if (input.musicPath) return { path: input.musicPath, cached: false, entry: null };
    const local = await this.pickLocal(input.mood, { dayIndex: input.dayIndex });
    if (local) return local;
    const entry = this.pick(input.mood, { dayIndex: input.dayIndex });
    if (!entry) return null;
    const result = await this.download(entry);
    return { ...result, entry };
  }

  credit(entry) {
    if (!entry) return null;
    return `Music: "${entry.track}" by Kevin MacLeod (${MUSIC_SOURCE}) — ${MUSIC_LICENSE_SOURCE}`;
  }

  creditFor(resolved) {
    if (!resolved) return null;
    if (resolved.entry) return this.credit(resolved.entry);
    if (resolved.localTrack) {
      const name = resolved.localTrack.replace(/\.[^.]+$/i, '').replace(/[_-]+/g, ' ').trim();
      return `Music: "${name}" — from the channel music library`;
    }
    return null;
  }
}

module.exports = { MusicBedService, MUSIC_LICENSE, MUSIC_LICENSE_SOURCE, MUSIC_CATALOG: CATALOG };
