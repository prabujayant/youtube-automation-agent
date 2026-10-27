const fs = require('fs').promises;
const path = require('path');
const { Logger } = require('./logger');
const { AITextService } = require('./ai-text-service');

const PEXELS_API = 'https://api.pexels.com/videos/search';
const PEXELS_LICENSE = 'Pexels License — https://www.pexels.com/license/';
const PIXABAY_API = 'https://pixabay.com/api/videos/';
const PIXABAY_LICENSE = 'Pixabay Content License — https://pixabay.com/service/license-summary/';
const DEFAULT_QUERY_COUNT = 5;
const DEFAULT_MIN_SECONDS = 2;
const DEFAULT_MAX_SECONDS = 12;

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function humanize(value) {
  const text = String(value || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Stock clip';
}

class StockFootageService {
  constructor(options = {}) {
    this.logger = options.logger || new Logger('StockFootage');
    this.provider = options.provider !== undefined
      ? options.provider
      : options.apiKey
        ? 'pexels'
        : process.env.PEXELS_API_KEY ? 'pexels' : process.env.PIXABAY_API_KEY ? 'pixabay' : null;
    this.apiKey = options.apiKey
      || (this.provider === 'pexels' ? process.env.PEXELS_API_KEY : null)
      || (this.provider === 'pixabay' ? process.env.PIXABAY_API_KEY : null)
      || null;
    this.cacheRoot = options.cacheRoot || path.join(__dirname, '..', 'data', 'footage', this.provider || 'pexels');
    this.fetch = options.fetch || globalThis.fetch;
    this.credentials = options.credentials || null;
    this.ai = options.ai || null;
    this.requestDelay = options.requestDelay === undefined ? 200 : Number(options.requestDelay);
    this.orientation = options.orientation || 'portrait';
  }

  isAvailable() {
    return Boolean(this.provider && this.apiKey) && typeof this.fetch === 'function';
  }

  getAI() {
    if (this.ai) return this.ai;
    if (!this.credentials) return null;
    try {
      const service = new AITextService(this.credentials.credentials || this.credentials);
      this.ai = service.isAvailable() ? service : null;
    } catch (_error) {
      this.ai = null;
    }
    return this.ai;
  }

  async suggestQueries(topic, count = DEFAULT_QUERY_COUNT) {
    const cleanTopic = String(topic || '').trim();
    if (!cleanTopic) return [];
    const ai = this.getAI();
    if (ai) {
      try {
        const response = await ai.generateText([
          'You write stock-footage search queries for a ranked Shorts countdown.',
          `Topic: ${cleanTopic}`,
          `Return ${count} short English search phrases (2-5 words each) that would find clear, filmable, royalty-free b-roll for this topic.`,
          'Use concrete nouns and actions. Return a JSON array of strings only.'
        ].join('\n'), { maxTokens: 300, temperature: 0.5 });
        const start = response.indexOf('[');
        const end = response.lastIndexOf(']');
        if (start !== -1 && end > start) {
          const parsed = JSON.parse(response.slice(start, end + 1));
          if (Array.isArray(parsed)) {
            const queries = parsed
              .map(item => String(item || '').replace(/^["']|["']$/g, '').trim())
              .filter(item => item.length >= 3)
              .slice(0, count);
            if (queries.length) return [...new Set([cleanTopic, ...queries])].slice(0, count + 1);
          }
        }
      } catch (error) {
        this.logger.warn(`Stock query generation failed (${error.message}); using topic variants`);
      }
    }
    const base = cleanTopic.toLowerCase();
    return [
      cleanTopic,
      `${base} close up`,
      `${base} slow motion`,
      `${base} action`,
      `${base} details`
    ].slice(0, count + 1);
  }

  fail(message, code, status = 400) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  }

  async search(query, options = {}) {
    if (!this.isAvailable()) {
      throw this.fail(
        'No stock-footage provider is configured. Set PEXELS_API_KEY or PIXABAY_API_KEY in .env',
        'STOCK_KEY_REQUIRED'
      );
    }
    const videos = this.provider === 'pixabay'
      ? await this.searchPixabay(query, options)
      : await this.searchPexels(query, options);
    return videos;
  }

  async searchPexels(query, options = {}) {
    const parameters = new globalThis.URLSearchParams({
      query: String(query),
      orientation: options.orientation || this.orientation,
      size: options.size || 'medium',
      per_page: String(Math.max(1, Math.min(80, options.perPage || 15))),
      page: String(Math.max(1, options.page || 1))
    });
    const response = await this.fetch(`${PEXELS_API}?${parameters}`, {
      headers: { Authorization: this.apiKey }
    });
    if (!response.ok) {
      throw this.fail(
        `Pexels search failed (HTTP ${response.status})`,
        response.status === 401 ? 'STOCK_KEY_INVALID' : 'STOCK_SEARCH_FAILED',
        response.status === 429 ? 429 : 400
      );
    }
    const payload = await response.json();
    return Array.isArray(payload.videos) ? payload.videos : [];
  }

  async searchPixabay(query, options = {}) {
    const parameters = new globalThis.URLSearchParams({
      key: this.apiKey,
      q: String(query),
      video_type: options.videoType || 'all',
      safesearch: 'true',
      per_page: String(Math.max(3, Math.min(200, options.perPage || 15))),
      page: String(Math.max(1, options.page || 1))
    });
    const response = await this.fetch(`${PIXABAY_API}?${parameters}`);
    if (!response.ok) {
      throw this.fail(
        `Pixabay search failed (HTTP ${response.status})`,
        response.status === 429 ? 'STOCK_RATE_LIMITED' : 'STOCK_SEARCH_FAILED',
        response.status === 429 ? 429 : 400
      );
    }
    const payload = await response.json();
    if (payload.error) {
      throw this.fail(
        `Pixabay search failed: ${payload.error}`,
        /key/i.test(payload.error) ? 'STOCK_KEY_INVALID' : 'STOCK_SEARCH_FAILED'
      );
    }
    return (Array.isArray(payload.hits) ? payload.hits : []).map(hit => {
      const files = Object.values(hit.videos || {})
        .filter(file => file && file.url && Number(file.width) > 0 && Number(file.height) > 0)
        .map(file => ({ file_type: 'video/mp4', width: file.width, height: file.height, link: file.url }))
        .sort((left, right) => Number(right.height) - Number(left.height));
      return {
        id: hit.id,
        duration: hit.duration,
        url: hit.pageURL,
        user: { name: hit.user },
        tags: hit.tags,
        video_files: files
      };
    });
  }

  selectFile(video) {
    const files = (video.video_files || [])
      .filter(file => String(file.file_type || 'video/mp4') === 'video/mp4' && file.link)
      .filter(file => Number(file.width) > 0 && Number(file.height) > 0);
    if (!files.length) return null;
    const portrait = files.filter(file => Number(file.height) >= Number(file.width));
    const pool = portrait.length ? portrait : files;
    return pool
      .slice()
      .sort((left, right) => Number(right.height) - Number(left.height))[0];
  }

  toClip(video, query, options = {}) {
    const file = this.selectFile(video);
    if (!file) return null;
    const duration = Number(video.duration || 0);
    if (duration < (options.minSeconds || DEFAULT_MIN_SECONDS)) return null;
    const target = Math.min(
      Number(options.maxSeconds || DEFAULT_MAX_SECONDS),
      Math.max(3, duration - 0.5)
    );
    const names = { pexels: 'Pexels', pixabay: 'Pixabay' };
    const tags = String(video.tags || '')
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);
    const title = tags.length ? humanize(tags.slice(0, 3).join(' ')) : humanize(query);
    return {
      id: String(video.id),
      provider: this.provider,
      query,
      file: file.link,
      width: Number(file.width),
      height: Number(file.height),
      duration: Number(duration.toFixed(2)),
      title,
      notes: `${names[this.provider]} clip #${video.id}${video.user?.name ? ` by ${video.user.name}` : ''}${tags.length ? ` — tags: ${tags.join(', ')}` : ''}`,
      license: 'licensed',
      licenseSource: this.provider === 'pixabay' ? PIXABAY_LICENSE : PEXELS_LICENSE,
      sourcePage: video.url || null,
      author: video.user?.name || null,
      score: Math.round((target * 10) + Math.min(40, Number(file.height) / 60)),
      start: Number(Math.max(0, Math.min(duration - target, (duration - target) / 2)).toFixed(2)),
      clipSeconds: Number(target.toFixed(2))
    };
  }

  async download(clip) {
    await fs.mkdir(this.cacheRoot, { recursive: true });
    const extension = path.extname(new URL(clip.file).pathname) || '.mp4';
    const target = path.join(this.cacheRoot, `${clip.provider}-${clip.id}-${clip.height}${extension}`);
    try {
      const stats = await fs.stat(target);
      if (stats.isFile() && stats.size > 0) return { path: target, cached: true };
    } catch (_error) {
      // not cached yet
    }
    const response = await this.fetch(clip.file);
    if (!response.ok) {
      throw this.fail(
        `${clip.provider} download failed (HTTP ${response.status})`,
        'STOCK_DOWNLOAD_FAILED'
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error('The stock provider returned an empty clip');
    await fs.writeFile(target, buffer);
    return { path: target, cached: false };
  }

  async collectClips(input = {}) {
    const topic = String(input.topic || '').trim();
    if (!topic) throw new Error('A topic is required to collect stock footage');
    const count = Math.max(2, Math.min(10, Number(input.count) || 6));
    const queries = Array.isArray(input.queries) && input.queries.length
      ? input.queries.map(query => String(query).trim()).filter(Boolean)
      : await this.suggestQueries(topic, DEFAULT_QUERY_COUNT);
    const minSeconds = Number(input.minSeconds || DEFAULT_MIN_SECONDS);
    const maxSeconds = Number(input.maxSeconds || DEFAULT_MAX_SECONDS);
    const perQuery = Math.max(count, Math.min(20, Number(input.perQuery) || count * 2));

    const clips = [];
    const seen = new Set();
    for (const query of queries) {
      if (clips.length >= count) break;
      const videos = await this.search(query, { perPage: perQuery });
      for (const video of videos) {
        if (clips.length >= count) break;
        if (seen.has(String(video.id))) continue;
        const clip = this.toClip(video, query, { minSeconds, maxSeconds });
        if (!clip) continue;
        seen.add(clip.id);
        clips.push(clip);
      }
      if (this.requestDelay > 0 && clips.length < count) {
        await sleep(this.requestDelay);
      }
    }

    if (clips.length < 2) {
      throw this.fail(
        `${this.provider || 'The stock provider'} returned fewer than two usable portrait clips for this topic`,
        'STOCK_NOT_ENOUGH_CLIPS',
        409
      );
    }

    // Identical titles produce identical captions in a countdown; number repeats.
    const titleCounts = new Map();
    for (const clip of clips) {
      const seen = titleCounts.get(clip.title) || 0;
      titleCounts.set(clip.title, seen + 1);
      if (seen > 0) clip.title = `${clip.title} (take ${seen + 1})`;
    }

    const downloaded = [];
    for (const clip of clips) {
      const result = await this.download(clip);
      downloaded.push({
        file: result.path,
        title: clip.title,
        notes: `${clip.notes}. Source: ${clip.sourcePage || clip.licenseSource}`,
        license: clip.license,
        licenseSource: clip.licenseSource,
        score: clip.score,
        start: clip.start,
        duration: clip.clipSeconds,
        sourcePage: clip.sourcePage,
        author: clip.author,
        cached: result.cached
      });
    }
    this.logger.success(`Collected ${downloaded.length} ${this.provider} clips for "${topic}"`);
    return downloaded;
  }

  static status() {
    const pexels = Boolean(process.env.PEXELS_API_KEY);
    const pixabay = Boolean(process.env.PIXABAY_API_KEY);
    return {
      provider: pexels ? 'pexels' : pixabay ? 'pixabay' : null,
      available: pexels || pixabay,
      providers: [
        { id: 'pexels', license: PEXELS_LICENSE, available: pexels },
        { id: 'pixabay', license: PIXABAY_LICENSE, available: pixabay }
      ]
    };
  }
}

module.exports = { StockFootageService, PEXELS_LICENSE, PIXABAY_LICENSE };
