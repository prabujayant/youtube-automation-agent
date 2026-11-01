const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');

// Royalty-free, viral-style music beds with verified direct MP3 sources.
// The catalog is curated from Pixabay tracks that were not Content ID
// registered when rechecked (2026-11-01), which keeps claim risk low. Pixabay's
// licence does not require attribution, but the ranked Shorts description
// builder credits the artist automatically. Tracks marked `premium` are the
// strongest, highest-energy beds and are preferred by the viral format.
const MUSIC_SOURCE = 'Pixabay';
const MUSIC_LICENSE = 'pixabay';
const MUSIC_LICENSE_SOURCE = 'Pixabay Content License — https://pixabay.com/service/license-summary/';

// mood: the travel tone that matches the destination showcase format. The two
// viral buckets keep the morning and evening Shorts on different tracks.
const CATALOG = [
  {
    track: 'Viral Trend',
    artist: 'THitNCMusic',
    mood: 'viral-uplifting',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2025/11/17/audio_d6376bf495.mp3?filename=thitncmusic-viral-trend-438252.mp3',
    page: 'https://pixabay.com/music/upbeat-viral-trend-438252/'
  },
  {
    track: 'Gym Phonk',
    artist: 'Kulakovka',
    mood: 'viral-uplifting',
    contentId: false,
    url: 'https://cdn.pixabay.com/download/audio/2026/10/14/audio_3d633891cf.mp3?filename=kulakovka-gym-phonk-620567.mp3',
    page: 'https://pixabay.com/music/phonk-gym-phonk-620567/'
  },
  {
    track: 'Instagram Reels Music',
    artist: 'BombinSound',
    mood: 'viral-uplifting',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/03/10/audio_4d0d4ca715.mp3?filename=bombinsound-instagram-reels-music-499598.mp3',
    page: 'https://pixabay.com/music/future-bass-instagram-reels-music-499598/'
  },
  {
    track: 'Upbeat Funk',
    artist: 'Kulakovka',
    mood: 'viral-uplifting',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/10/04/audio_3664c5b6e7.mp3?filename=kulakovka-upbeat-funk-614901.mp3',
    page: 'https://pixabay.com/music/funk-upbeat-funk-614901/'
  },
  {
    track: 'Deep House Sunset',
    artist: 'sunset-house-grooves',
    mood: 'viral-uplifting',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/05/22/audio_29c6fef01d.mp3?filename=sunset-house-grooves-deep-house-sunset-538759.mp3',
    page: 'https://pixabay.com/music/soft-house-deep-house-sunset-538759/'
  },
  {
    track: 'Catchy Reels School',
    artist: 'maeve-reels',
    mood: 'viral-uplifting',
    contentId: false,
    url: 'https://cdn.pixabay.com/download/audio/2026/05/05/audio_0e6cf0c032.mp3?filename=maeve-reels-catchy-reels-school-529806.mp3',
    page: 'https://pixabay.com/music/old-school-hip-hop-catchy-reels-school-529806/'
  },
  {
    track: 'Phonk Reel',
    artist: 'Kulakovka',
    mood: 'viral-tropical',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/10/04/audio_f9cd85383d.mp3?filename=kulakovka-phonk-reel-614877.mp3',
    page: 'https://pixabay.com/music/phonk-phonk-reel-614877/'
  },
  {
    track: 'Summer Party',
    artist: 'Kulakovka',
    mood: 'viral-tropical',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/10/14/audio_fa8b62ae1d.mp3?filename=kulakovka-summer-party-620566.mp3',
    page: 'https://pixabay.com/music/dance-summer-party-620566/'
  },
  {
    track: 'Tropical House Paradise',
    artist: 'sunset-house-grooves',
    mood: 'viral-tropical',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/05/22/audio_01a43c7ab6.mp3?filename=sunset-house-grooves-tropical-house-paradise-538758.mp3',
    page: 'https://pixabay.com/music/soft-house-tropical-house-paradise-538758/'
  },
  {
    track: 'Brazilian Phonk',
    artist: 'Sub_Clair',
    mood: 'viral-tropical',
    contentId: false,
    url: 'https://cdn.pixabay.com/download/audio/2026/07/22/audio_0226c2d6b9.mp3?filename=sub_clair-brazilian-phonk-571897.mp3',
    page: 'https://pixabay.com/music/phonk-brazilian-phonk-571897/'
  },
  {
    track: 'Trending Instagram Reels Music',
    artist: 'BombinSound',
    mood: 'viral-tropical',
    contentId: false,
    url: 'https://cdn.pixabay.com/download/audio/2026/03/10/audio_0efed2f5de.mp3?filename=bombinsound-trending-instagram-reels-music-499599.mp3',
    page: 'https://pixabay.com/music/future-bass-trending-instagram-reels-music-499599/'
  },
  {
    track: 'Chill Reel',
    artist: 'Kulakovka',
    mood: 'viral-tropical',
    contentId: false,
    url: 'https://cdn.pixabay.com/download/audio/2026/07/19/audio_cb944b1856.mp3?filename=kulakovka-chill-reel-570198.mp3',
    page: 'https://pixabay.com/music/house-chill-reel-570198/'
  },
  {
    track: 'Clap Party — Viral EDM Dance Anthem',
    artist: 'ChrisDjYogi',
    mood: 'viral-uplifting',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2025/10/16/audio_64e5e68f04.mp3?filename=chrisdjyogi-clap-party-viral-edm-dance-anthem-421463.mp3',
    page: 'https://pixabay.com/music/dance-clap-party-viral-edm-dance-anthem-421463/'
  },
  {
    track: 'trendy viral commercial',
    artist: 'deeznutz1',
    mood: 'viral-uplifting',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2025/05/19/audio_cf23269c42.mp3?filename=deeznutz1-trendy-viral-commercial-343863.mp3',
    page: 'https://pixabay.com/music/pop-trendy-viral-commercial-343863/'
  },
  {
    track: 'Time Labs',
    artist: '1206Elle',
    mood: 'viral-uplifting',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/07/12/audio_7c7bff3a11.mp3?filename=1206elle-time-labs-566119.mp3',
    page: 'https://pixabay.com/music/instrumental-time-labs-566119/'
  },
  {
    track: 'darkside - rally house',
    artist: 'kawaiiwork',
    mood: 'viral-tropical',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2025/09/25/audio_f28add0f09.mp3?filename=kawaiiwork-darkside-rally-house-410400.mp3',
    page: 'https://pixabay.com/music/upbeat-darkside-rally-house-410400/'
  },
  {
    track: 'kawaiiwork - High Speed (Phonk)',
    artist: 'kawaiiwork',
    mood: 'viral-tropical',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2024/10/13/audio_da69c3b509.mp3?filename=kawaiiwork-kawaiiwork-high-speed-phonk-250413.mp3',
    page: 'https://pixabay.com/music/upbeat-kawaiiwork-high-speed-phonk-250413/'
  },
  {
    track: 'MONTAGEM SEBRITMADO',
    artist: 'djkiwii_',
    mood: 'viral-tropical',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/08/05/audio_ed7b329ac4.mp3?filename=djkiwii-montagem-sebritmado-577064.mp3',
    page: 'https://pixabay.com/music/phonk-montagem-sebritmado-577064/'
  },
  {
    track: 'NOITE DA BRUXA | Brazilian 2026 Energetic Viral Trending Phonk',
    artist: 'Watermelon_Beats',
    mood: 'viral-tropical',
    contentId: false,
    premium: true,
    url: 'https://cdn.pixabay.com/download/audio/2026/01/22/audio_72d5173c22.mp3?filename=watermelon_beats-noite-da-bruxa-brazilian-2026-energetic-viral-trending-phonk-471376.mp3',
    page: 'https://pixabay.com/music/phonk-noite-da-bruxa-brazilian-2026-energetic-viral-trending-phonk-471376/'
  }
];

class MusicBedService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('MusicBed');
    this.cacheRoot = options.cacheRoot || path.join(__dirname, '..', 'data', 'footage', 'music');
    this.libraryRoot = options.libraryRoot || path.join(__dirname, '..', 'data', 'footage', 'music-library');
    this.fetch = options.fetch || globalThis.fetch;
    this.catalog = options.catalog || CATALOG;
    // Legacy fallback for custom catalogs that only provide a track name.
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
    let pool = this.catalog.filter(entry => !mood || entry.mood === mood);
    if (options.premium) {
      const premium = pool.filter(entry => entry.premium);
      if (premium.length) pool = premium;
    }
    const usable = pool.length ? pool : this.catalog;
    if (!usable.length) return null;
    const dayIndex = options.dayIndex === undefined
      ? Math.floor(Date.now() / 86400000)
      : Number(options.dayIndex);
    return usable[dayIndex % usable.length];
  }

  url(entry) {
    if (entry.url) return entry.url;
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
    const entry = this.pick(input.mood, { dayIndex: input.dayIndex, premium: input.premium });
    if (!entry) return null;
    const result = await this.download(entry);
    return { ...result, entry };
  }

  credit(entry) {
    if (!entry) return null;
    const artist = entry.artist ? ` by ${entry.artist}` : '';
    const source = entry.source || MUSIC_SOURCE;
    return `Music: "${entry.track}"${artist} — ${source} royalty-free`;
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
