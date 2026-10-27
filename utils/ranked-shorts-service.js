const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { Logger } = require('./logger');
const { AITextService } = require('./ai-text-service');

const LICENSE_TYPES = new Set([
  'owned', 'licensed', 'cc-by', 'cc-by-sa', 'public-domain', 'permission'
]);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);
const MIN_CLIPS = 2;
const MAX_CLIPS = 10;
const MIN_CLIP_SECONDS = 1.5;
const MAX_CLIP_SECONDS = 12;
const DEFAULT_MAX_SECONDS = 60;
const HARD_MAX_SECONDS = 180;
const DEFAULT_HOOK_SECONDS = 1.6;
const SHOWCASE_DEFAULT_CLIPS = 8;
const SHOWCASE_MAX_SECONDS = 24;
const SHOWCASE_CLIP_SECONDS = 3;
const CAPTION_STYLE =
  'FontName=Arial,FontSize=18,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,' +
  'BorderStyle=1,Outline=3,Shadow=1,Alignment=2,MarginV=220';

function even(value) {
  const number = Math.max(2, Math.round(Number(value) || 0));
  return number % 2 === 0 ? number : number + 1;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || minimum));
}

function truncate(value, maximum) {
  // Preserve line breaks (YouTube descriptions rely on them) while collapsing
  // runs of spaces and tabs.
  const normalized = String(value || '')
    .split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trim()}…`;
}

function srtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds || 0) * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor((centiseconds % 360000) / 6000);
  const secs = Math.floor((centiseconds % 6000) / 100);
  const rest = centiseconds % 100;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(secs).padStart(2, '0')}.${String(rest).padStart(2, '0')}`;
}

function extractJson(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (_error) {
    return null;
  }
}

class RankedShortsService {
  constructor(db, publishing, options = {}) {
    this.db = db;
    this.publishing = publishing;
    this.logger = options.logger || new Logger('RankedShorts');
    this.dataRoot = options.dataRoot || path.join(__dirname, '..', 'data', 'ranked-shorts');
    this.width = even(options.width || 1080);
    this.height = even(options.height || 1920);
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.getDuration = options.getDuration || getMediaDuration;
    this.credentials = options.credentials || null;
    this.ai = options.ai || null;
    this.musicBed = options.musicBed || null;
    this.fontName = options.fontName || 'Arial';
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

  async list(limit = 25) {
    return this.db.listRankedShortEpisodes(limit);
  }

  async get(episodeId) {
    return this.db.getRankedShortEpisode(episodeId);
  }

  async requireEpisode(episodeId) {
    const episode = await this.db.getRankedShortEpisode(episodeId);
    if (!episode) {
      const error = new Error('Ranked Short episode not found');
      error.status = 404;
      throw error;
    }
    return episode;
  }

  async plan(input = {}) {
    const topic = String(input.topic || '').trim();
    if (!topic) throw this.badRequest('A topic is required for a ranked Short');
    const format = input.format === 'showcase' ? 'showcase' : 'ranked';
    const clips = await this.collectClips(input);
    const preferredCount = input.count
      || (format === 'showcase' ? SHOWCASE_DEFAULT_CLIPS : Math.min(7, clips.length));
    const count = clamp(preferredCount, MIN_CLIPS, Math.min(MAX_CLIPS, clips.length));
    if (count < MIN_CLIPS) {
      throw this.badRequest(`A ranked Short needs at least ${MIN_CLIPS} licensed clips`);
    }

    const episodeId = this.db.generateId('rankedshort');
    const episodeDir = path.join(this.dataRoot, episodeId);
    const sourceDir = path.join(episodeDir, 'source');
    await fs.mkdir(sourceDir, { recursive: true });

    const copied = [];
    for (const [index, clip] of clips.entries()) {
      const extension = path.extname(clip.sourcePath).toLowerCase();
      const target = path.join(sourceDir, `${String(index + 1).padStart(2, '0')}${extension}`);
      await fs.copyFile(clip.sourcePath, target);
      copied.push({ ...clip, copiedPath: target });
    }

    const maxSeconds = clamp(
      input.maxSeconds || (format === 'showcase' ? SHOWCASE_MAX_SECONDS : DEFAULT_MAX_SECONDS),
      10,
      HARD_MAX_SECONDS
    );
    let musicPath = null;
    let musicCredit = null;
    if (input.music === 'auto' && this.musicBed) {
      try {
        const resolved = await this.musicBed.resolve({ mood: input.musicMood });
        if (resolved) {
          musicPath = resolved.path;
          musicCredit = this.musicBed.creditFor(resolved);
        }
      } catch (error) {
        this.logger.warn(`Auto music unavailable (${error.message}); continuing without a music bed`);
      }
    }
    if (input.musicPath) {
      const extension = path.extname(String(input.musicPath)) || '.mp3';
      musicPath = path.join(episodeDir, `music${extension}`);
      await fs.copyFile(path.resolve(String(input.musicPath)), musicPath);
    }
    const ranked = format === 'showcase'
      ? await this.buildShowcasePlan(topic, copied, { count, overlay: input.overlay })
      : await this.rankClips(topic, copied, {
        count,
        hook: input.hook,
        countdown: input.countdown !== false
      });
    const plan = ranked.clips.slice(0, count);
    const rights = this.validateRights(plan);

    const description = this.buildDescription(topic, ranked, plan, { format, musicCredit });

    const episode = await this.db.createRankedShortEpisode({
      id: episodeId,
      topic,
      hook: ranked.hook,
      status: 'planned',
      title: ranked.title,
      description,
      tags: ranked.tags,
      clipPlan: plan,
      assets: {
        format,
        maxSeconds,
        fit: input.fit === 'blur' ? 'blur' : 'crop',
        hookSeconds: format === 'showcase' ? 0 : DEFAULT_HOOK_SECONDS,
        overlay: ranked.overlay || null,
        rights,
        musicPath,
        source: input.source || 'local',
        queries: Array.isArray(input.queries) ? input.queries : null
      },
      privacyStatus: ['private', 'unlisted', 'public'].includes(input.privacyStatus)
        ? input.privacyStatus
        : 'private'
    });

    await fs.writeFile(
      path.join(episodeDir, 'episode.json'),
      JSON.stringify({ topic, hook: ranked.hook, ranking: ranked.source, clips: plan }, null, 2),
      'utf8'
    );
    this.logger.success(`Planned ranked Short ${episodeId} with ${plan.length} licensed clips`);
    return episode;
  }

  badRequest(message, code = 'RANKED_SHORTS_INVALID') {
    const error = new Error(message);
    error.status = 400;
    error.code = code;
    return error;
  }

  async collectClips(input = {}) {
    let entries = Array.isArray(input.clips) ? input.clips : null;
    let clipsDir = input.clipsDir ? path.resolve(String(input.clipsDir)) : null;

    if (!entries && clipsDir) {
      const manifestPath = path.join(clipsDir, 'clips.json');
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        entries = Array.isArray(manifest) ? manifest : manifest.clips;
      } catch (_error) {
        entries = null;
      }
      if (!entries) {
        const files = await fs.readdir(clipsDir);
        entries = files
          .filter(file => VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()))
          .sort()
          .map(file => ({ file }));
      }
    }

    if (!Array.isArray(entries) || !entries.length) {
      throw this.badRequest('Provide clips or a clipsDir containing licensed video files');
    }

    const clips = [];
    const denied = [];
    for (const entry of entries) {
      const rawFile = entry.file || entry.path;
      if (!rawFile) continue;
      const sourcePath = path.isAbsolute(rawFile)
        ? rawFile
        : path.resolve(clipsDir || process.cwd(), rawFile);
      const extension = path.extname(sourcePath).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension)) continue;

      const license = String(entry.license || input.license || '').toLowerCase();
      const licenseSource = String(entry.source || entry.licenseSource || input.licenseSource || '').trim();
      if (!LICENSE_TYPES.has(license) || !licenseSource) {
        denied.push(path.basename(sourcePath));
        continue;
      }

      let stats;
      try {
        stats = await fs.stat(sourcePath);
      } catch (_error) {
        throw this.badRequest(`Clip not found: ${path.basename(sourcePath)}`);
      }
      if (!stats.isFile() || stats.size <= 0) {
        denied.push(path.basename(sourcePath));
        continue;
      }

      clips.push({
        position: clips.length,
        sourcePath,
        originalFile: sourcePath,
        title: truncate(entry.title || entry.caption || path.basename(sourcePath, extension), 90),
        notes: truncate(entry.notes || entry.description || '', 240),
        license,
        licenseSource,
        score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : null,
        start: Math.max(0, Number(entry.start || entry.startSeconds || 0)),
        duration: clamp(entry.duration || entry.seconds || 7, MIN_CLIP_SECONDS, MAX_CLIP_SECONDS)
      });
    }

    if (denied.length) {
      const error = this.badRequest(
        `Every clip needs a licence (${[...LICENSE_TYPES].join(', ')}) and a source note. ` +
        `Resolve: ${denied.slice(0, 5).join(', ')}`,
        'RANKED_SHORTS_LICENSE_REQUIRED'
      );
      error.status = 409;
      throw error;
    }
    if (clips.length < MIN_CLIPS) {
      throw this.badRequest(`At least ${MIN_CLIPS} usable video clips are required`);
    }
    return clips;
  }

  validateRights(plan = []) {
    const problems = [];
    for (const clip of plan) {
      if (!LICENSE_TYPES.has(String(clip.license || '').toLowerCase())) {
        problems.push(`${clip.originalFile || clip.title}: licence is missing or unsupported`);
      }
      if (!String(clip.licenseSource || '').trim()) {
        problems.push(`${clip.title}: licence source is missing`);
      }
    }
    return {
      checkedAt: new Date().toISOString(),
      complete: problems.length === 0,
      problems,
      licences: plan.map(clip => ({
        file: path.basename(clip.copiedPath || clip.sourcePath || ''),
        title: clip.title,
        license: clip.license,
        licenseSource: clip.licenseSource
      }))
    };
  }

  async rankClips(topic, clips, options = {}) {
    const count = options.count || Math.min(7, clips.length);
    const ai = this.getAI();
    if (ai) {
      try {
        const candidates = clips.map((clip, index) => ({
          index,
          title: clip.title,
          notes: clip.notes || '',
          duration: clip.duration
        }));
        const prompt = [
          'You are the editor of a fast-paced ranked Shorts channel.',
          `Topic: ${topic}`,
          `Pick the ${count} strongest clips and rank them 1 (best, shown last) to ${count} (opening clip).`,
          'Rewrite each clip title as a punchy caption of at most 60 characters. Keep it factual: do not invent events, people, or claims that are not in the notes.',
          'Write one scroll-stopping hook line (max 45 characters), a YouTube Shorts title (max 90 characters), a two-sentence description, and 6-10 tags.',
          'Return JSON only, in this shape:',
          '{"ranking":[{"index":0,"rank":1,"caption":"..."}],"hook":"...","title":"...","description":"...","tags":["..."]}',
          `Clips: ${JSON.stringify(candidates)}`
        ].join('\n');
        const response = await ai.generateText(prompt, { maxTokens: 900, temperature: 0.6 });
        const parsed = extractJson(response);
        if (parsed) {
          const ranked = this.applyRanking(clips, parsed, count);
          if (ranked) {
            return this.finalizeRanking(topic, ranked, {
              hook: parsed.hook || options.hook,
              title: parsed.title,
              description: parsed.description,
              tags: parsed.tags,
              source: 'ai'
            });
          }
        }
        this.logger.warn('AI ranking was unusable; falling back to metadata ranking');
      } catch (error) {
        this.logger.warn(`AI ranking failed (${error.message}); falling back to metadata ranking`);
      }
    }
    const fallback = clips
      .slice()
      .sort((left, right) => (right.score || 0) - (left.score || 0) || left.position - right.position)
      .slice(0, count)
      .map((clip, index) => ({ ...clip, rank: index + 1, caption: truncate(clip.title, 60) }));
    return this.finalizeRanking(topic, fallback, { hook: options.hook, source: 'metadata' });
  }

  async buildShowcasePlan(topic, clips, options = {}) {
    const count = options.count || SHOWCASE_DEFAULT_CLIPS;
    const ordered = clips
      .slice()
      .sort((left, right) => (right.score || 0) - (left.score || 0) || left.position - right.position)
      .slice(0, count)
      .map((clip, index) => ({
        ...clip,
        rank: index + 1,
        duration: SHOWCASE_CLIP_SECONDS,
        caption: ''
      }));
    const metadata = await this.planShowcaseMetadata(topic);
    const ranking = this.finalizeRanking(topic, ordered, {
      hook: '',
      title: metadata.title,
      tags: metadata.tags,
      description: metadata.description,
      source: 'showcase'
    });
    ranking.overlay = metadata.overlay;
    return ranking;
  }

  async planShowcaseMetadata(topic) {
    const ai = this.getAI();
    if (ai) {
      try {
        const prompt = [
          'You brand short vertical travel "destination showcase" videos for YouTube Shorts.',
          `Destination: ${topic}`,
          'Return JSON only, in this shape:',
          '{"overlay":"♥ Venice","title":"Discover Venice: the Floating City of Canals! 🇮🇹","description":"One sentence about the destination.","tags":["travel","venice","italy"]}',
          'Rules: overlay is at most 24 characters, starts with the ♥ character, no flags or other emoji.',
          'The title must start with "Discover", mention the destination, be under 80 characters, end with an exclamation mark, and may include one or two relevant emoji flags/symbols.'
        ].join('\n');
        const response = await ai.generateText(prompt, { maxTokens: 400, temperature: 0.7 });
        const parsed = extractJson(response);
        if (parsed && parsed.title) {
          return {
            overlay: parsed.overlay || null,
            title: parsed.title,
            description: parsed.description || '',
            tags: Array.isArray(parsed.tags) ? parsed.tags : []
          };
        }
      } catch (error) {
        this.logger.warn(`Showcase branding failed (${error.message}); using template`);
      }
    }
    const short = topic.split(',')[0].trim() || topic;
    return {
      overlay: `♥ ${truncate(short, 20)}`,
      title: truncate(`Discover ${topic}!`, 90),
      description: '',
      tags: ['travel', 'shorts', ...topic.split(/[^a-z0-9]+/i).filter(word => word.length > 3).slice(0, 4)]
    };
  }

  applyRanking(clips, parsed, count) {
    if (!Array.isArray(parsed.ranking) || !parsed.ranking.length) return null;
    const used = new Set();
    const selected = [];
    for (const item of parsed.ranking) {
      const index = Number(item.index);
      if (!Number.isInteger(index) || index < 0 || index >= clips.length || used.has(index)) continue;
      used.add(index);
      const rank = clamp(item.rank || selected.length + 1, 1, count);
      selected.push({
        ...clips[index],
        rank,
        caption: truncate(item.caption || clips[index].title, 70)
      });
    }
    if (selected.length < count) {
      for (let index = 0; index < clips.length && selected.length < count; index++) {
        if (used.has(index)) continue;
        used.add(index);
        selected.push({
          ...clips[index],
          rank: selected.length + 1,
          caption: truncate(clips[index].title, 70)
        });
      }
    }
    const ranks = new Set(selected.map(clip => clip.rank));
    if (ranks.size !== selected.length) {
      selected.forEach((clip, index) => { clip.rank = index + 1; });
    }
    return selected.slice(0, count);
  }

  finalizeRanking(topic, selected, meta = {}) {
    const showcase = meta.source === 'showcase';
    const ordered = showcase
      ? selected.slice().sort((left, right) => left.rank - right.rank)
      : selected.slice().sort((left, right) => right.rank - left.rank);
    const hook = truncate(meta.hook || (showcase ? '' : 'Wait for #1'), 45);
    const title = truncate(meta.title || `${topic} #shorts`, 90);
    const tags = [...new Set([
      ...(Array.isArray(meta.tags) ? meta.tags : []),
      'shorts',
      ...(showcase ? [] : ['ranking']),
      ...topic.split(/[^a-z0-9]+/i).filter(word => word.length > 3).slice(0, 6)
    ])].map(tag => String(tag).replace(/^#/, '').trim()).filter(Boolean).slice(0, 15);
    return {
      clips: ordered,
      hook,
      title,
      tags,
      description: String(meta.description || ''),
      source: meta.source || 'metadata'
    };
  }

  buildDescription(topic, ranking, plan, options = {}) {
    const showcase = options.format === 'showcase';
    // YouTube descriptions stay human-readable: licence provenance lives in the
    // episode record, while only CC-BY footage (which requires attribution) is
    // listed clip by clip.
    const attributionRequired = plan.filter(clip => ['cc-by', 'cc-by-sa'].includes(clip.license));
    const stockSources = [...new Set(plan
      .filter(clip => !['cc-by', 'cc-by-sa'].includes(clip.license))
      .map(clip => String(clip.licenseSource || '').split(/\s+—\s+https?:\/\//)[0].trim())
      .filter(Boolean))];
    const intro = ranking.description && ranking.description.trim()
      ? ranking.description.trim()
      : showcase
        ? `Discover ${topic}.`
        : `${topic}: a ranked countdown of the ${plan.length} best moments.`;
    const tagSet = new Set((ranking.tags || [])
      .map(tag => String(tag).replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(Boolean));
    const hashtags = [
      '#shorts',
      ...[...tagSet]
        .filter(tag => tag.toLowerCase() !== 'shorts')
        .slice(0, 4)
        .map(tag => `#${tag}`)
    ].join(' ');
    return truncate(
      [
        intro,
        '',
        ...(showcase ? [`📍 ${topic}`, '🌍 Save this for your next trip!'] : []),
        ...(options.musicCredit ? [`🎵 ${options.musicCredit}`] : []),
        ...(stockSources.length ? [`📷 Footage: ${stockSources.join('; ')}`] : []),
        ...(attributionRequired.length
          ? ['', 'Footage attribution:', ...attributionRequired.map(clip =>
              `${clip.title} — ${clip.licenseSource}`
            )]
          : []),
        '',
        hashtags
      ].join('\n'),
      4900
    );
  }

  async render(episodeId) {
    const episode = await this.requireEpisode(episodeId);
    if (!Array.isArray(episode.clipPlan) || episode.clipPlan.length < MIN_CLIPS) {
      throw this.badRequest('Plan the ranked Short before rendering it');
    }
    if (['scheduled', 'published'].includes(episode.status)) {
      throw this.conflict('A scheduled or published ranked Short cannot be re-rendered');
    }
    const rights = this.validateRights(episode.clipPlan);
    if (!rights.complete) {
      const error = this.conflict(`Clip rights are incomplete: ${rights.problems.join('; ')}`);
      error.code = 'RANKED_SHORTS_LICENSE_REQUIRED';
      throw error;
    }

    const episodeDir = path.join(this.dataRoot, episode.id);
    const segmentsDir = path.join(episodeDir, 'segments');
    await fs.rm(segmentsDir, { recursive: true, force: true });
    await fs.mkdir(segmentsDir, { recursive: true });

    await this.db.updateRankedShortEpisode(episode.id, { status: 'rendering', error: null });
    try {
      const maxSeconds = clamp(episode.assets?.maxSeconds || DEFAULT_MAX_SECONDS, 10, HARD_MAX_SECONDS);
      const fit = episode.assets?.fit === 'blur' ? 'blur' : 'crop';
      const format = episode.assets?.format === 'showcase' ? 'showcase' : 'ranked';
      const hookSeconds = format === 'showcase'
        ? 0
        : clamp(episode.assets?.hookSeconds || DEFAULT_HOOK_SECONDS, 1, 3);
      const prepared = await this.allocateDurations(episode.clipPlan, maxSeconds - hookSeconds);

      const segments = [];
      const audioChecks = [];
      for (const [index, clip] of prepared.entries()) {
        const outputPath = path.join(segmentsDir, `${String(index + 1).padStart(2, '0')}.mp4`);
        const hasAudio = await this.hasAudioStream(clip.copiedPath);
        audioChecks.push({ file: path.basename(clip.copiedPath), hasAudio });
        await this.renderSegment({ ...clip, hasAudio }, outputPath, fit);
        const duration = await this.getDuration(outputPath);
        segments.push({ ...clip, segmentPath: outputPath, duration });
      }

      const inputs = segments.map(segment => segment.segmentPath);
      let captionsPath;
      if (format === 'showcase') {
        captionsPath = path.join(episodeDir, 'captions.ass');
        await fs.writeFile(captionsPath, this.buildShowcaseOverlay(episode, segments), 'utf8');
      } else {
        const hookPath = path.join(segmentsDir, '00-hook.mp4');
        await this.renderHookCard(hookPath, hookSeconds);
        inputs.unshift(hookPath);
        captionsPath = path.join(episodeDir, 'captions.srt');
        await fs.writeFile(captionsPath, this.buildCaptions(episode, segments, hookSeconds), 'utf8');
      }

      const finalPath = path.join(episodeDir, 'final.mp4');
      const musicPath = format === 'showcase' && !episode.assets?.musicPath
        ? await this.ensureDefaultMusic()
        : episode.assets?.musicPath || null;
      await this.assemble(inputs, finalPath, captionsPath, musicPath);

      const stats = await fs.stat(finalPath);
      if (!stats.isFile() || stats.size <= 0) throw new Error('FFmpeg returned an empty ranked Short');
      const duration = await this.getDuration(finalPath);

      const best = format === 'showcase' ? segments[0] : segments[segments.length - 1];
      const thumbnailPath = path.join(episodeDir, 'thumbnail.jpg');
      await this.renderThumbnail(best.segmentPath, thumbnailPath);

      const assets = {
        ...(episode.assets || {}),
        musicPath,
        video: { path: finalPath, duration, size: stats.size, simulated: false, aspectRatio: '9:16' },
        thumbnail: { path: thumbnailPath },
        captions: { path: captionsPath },
        audio: {
          embedded: true,
          verifiedAt: new Date().toISOString(),
          source: format === 'showcase' ? 'music_bed_and_clip_audio' : 'original_clip_audio',
          streams: audioChecks
        },
        rights,
        renderedAt: new Date().toISOString()
      };
      const updated = await this.db.updateRankedShortEpisode(episode.id, {
        status: 'rendered', assets, duration, error: null
      });
      this.logger.success(`Rendered ranked Short ${episode.id} (${duration.toFixed(1)}s)`);
      return updated;
    } catch (error) {
      await this.db.updateRankedShortEpisode(episode.id, { status: 'failed', error: error.message });
      throw error;
    }
  }

  async allocateDurations(plan, budget) {
    const prepared = [];
    for (const clip of plan) {
      const sourceDuration = await this.getDuration(clip.copiedPath || clip.sourcePath);
      const start = clamp(clip.start || 0, 0, Math.max(0, sourceDuration - MIN_CLIP_SECONDS));
      const available = Math.max(0, sourceDuration - start);
      const target = clamp(clip.duration || 7, MIN_CLIP_SECONDS, MAX_CLIP_SECONDS);
      prepared.push({
        ...clip,
        sourceDuration,
        start,
        seconds: Math.min(target, available)
      });
    }
    let total = prepared.reduce((sum, clip) => sum + clip.seconds, 0);
    while (total > budget && prepared.some(clip => clip.seconds > MIN_CLIP_SECONDS + 0.25)) {
      const longest = prepared.reduce((worst, clip) => clip.seconds > worst.seconds ? clip : worst, prepared[0]);
      const trim = Math.min(0.5, longest.seconds - MIN_CLIP_SECONDS, total - budget);
      longest.seconds -= trim;
      total -= trim;
    }
    return prepared.filter(clip => clip.seconds >= MIN_CLIP_SECONDS);
  }

  async hasAudioStream(filePath) {
    try {
      await this.runFFmpeg(['-hide_banner', '-i', filePath]);
      return false;
    } catch (error) {
      return /Stream #\d+:\d+.*: Audio:/i.test(String(error.stderr || ''));
    }
  }

  async renderSegment(clip, outputPath, fit) {
    const args = ['-y', '-ss', String(clip.start), '-t', String(clip.seconds), '-i', clip.copiedPath];
    const filters = [];
    const maps = [];
    if (fit === 'blur') {
      filters.push(
        `[0:v]split=2[bg][fg];` +
        `[bg]scale=${this.width}:${this.height}:force_original_aspect_ratio=increase,` +
        `crop=${this.width}:${this.height},boxblur=28:3[soft];` +
        `[fg]scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease[front];` +
        `[soft][front]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,format=yuv420p[v]`
      );
    } else {
      filters.push(
        `[0:v]scale=${this.width}:${this.height}:force_original_aspect_ratio=increase,` +
        `crop=${this.width}:${this.height},setsar=1,fps=30,format=yuv420p[v]`
      );
    }
    maps.push('-map', '[v]');

    if (clip.hasAudio === false) {
      args.push('-f', 'lavfi', '-t', String(clip.seconds), '-i', 'anullsrc=r=48000:cl=stereo');
      maps.push('-map', '1:a:0');
    } else {
      maps.push('-map', '0:a:0');
    }

    await this.runFFmpeg([
      ...args,
      '-filter_complex', filters.join(';'),
      ...maps,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-shortest', '-movflags', '+faststart', outputPath
    ]);
  }

  async renderHookCard(outputPath, seconds) {
    await this.runFFmpeg([
      '-y',
      '-f', 'lavfi', '-i', `color=c=0x0B0B12:s=${this.width}x${this.height}:r=30:d=${seconds}`,
      '-f', 'lavfi', '-i', `anullsrc=r=48000:cl=stereo:d=${seconds}`,
      '-vf', 'setsar=1,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-t', String(seconds), '-movflags', '+faststart', outputPath
    ]);
  }

  buildCaptions(episode, segments, hookSeconds) {
    const cues = [];
    let cursor = 0;
    cues.push({ start: 0, end: hookSeconds, text: episode.hook || 'Wait for #1' });
    cursor += hookSeconds;
    for (const segment of segments) {
      const text = `#${segment.rank}\n${segment.caption || segment.title}`;
      cues.push({ start: cursor, end: cursor + segment.duration, text });
      cursor += segment.duration;
    }
    return cues.map((cue, index) =>
      `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`
    ).join('\n');
  }

  buildShowcaseOverlay(episode, segments) {
    let text = truncate(episode.assets?.overlay || `♥ ${episode.topic.split(',')[0].trim()}`, 24);
    // Monochrome ♥ glyph colored red inline; the rest stays white.
    if (text.startsWith('♥')) {
      text = `{\\c&H2E2EFF&}♥{\\c&HFFFFFF&}${text.slice(1)}`;
    }
    const total = segments.reduce((sum, segment) => sum + segment.duration, 0);
    const end = assTime(total + 0.5);
    return [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${this.width}`,
      `PlayResY: ${this.height}`,
      'WrapStyle: 0',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Top,${this.fontName},64,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,4,2,8,40,40,70,1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      `Dialogue: 0,0:00:00.00,${end},Top,,0,0,0,,${text}`,
      ''
    ].join('\n');
  }

  async ensureDefaultMusic() {
    const dir = path.join(this.dataRoot, 'music');
    const target = path.join(dir, 'ambient-pad.m4a');
    try {
      const stats = await fs.stat(target);
      if (stats.isFile() && stats.size > 0) return target;
    } catch (_error) {
      // generate below
    }
    await fs.mkdir(dir, { recursive: true });
    // License-free ambient chord pad synthesized locally: A2 + E3 + A3 + E4
    // with a light pink-noise air layer, gentle tremolo and fades.
    await this.runFFmpeg([
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=110:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=164.81:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=220:duration=40',
      '-f', 'lavfi', '-i', 'sine=frequency=329.63:duration=40',
      '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.05:duration=40',
      '-filter_complex',
      '[0:a]volume=0.5[s0];[1:a]volume=0.3[s1];[2:a]volume=0.35[s2];[3:a]volume=0.22[s3];' +
        '[4:a]volume=0.12[s4];[s0][s1][s2][s3][s4]amix=inputs=5:normalize=0,' +
        'tremolo=f=0.15:d=0.25,afade=t=in:d=2,afade=t=out:st=36:d=4,volume=0.7[a]',
      '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', target
    ]);
    this.logger.success('Generated the default ambient music bed');
    return target;
  }

  async assemble(inputs, outputPath, captionsPath, musicPath = null) {
    const escaped = path.resolve(captionsPath)
      .replaceAll('\\', '/')
      .replace(':', '\\:')
      .replaceAll("'", "\\'");
    // ASS files (showcase overlay) carry their own styles; force_style would
    // override the top-center overlay with the countdown's bottom style.
    const isAss = path.extname(captionsPath).toLowerCase() === '.ass';
    const subtitles = isAss
      ? `subtitles='${escaped}'`
      : `subtitles='${escaped}':force_style='${CAPTION_STYLE.replace('FontName=Arial', `FontName=${this.fontName}`)}'`;
    const args = ['-y'];
    inputs.forEach(input => args.push('-i', input));
    let resolvedMusic = null;
    if (musicPath) {
      try {
        const stats = await fs.stat(musicPath);
        if (stats.isFile() && stats.size > 0) {
          resolvedMusic = musicPath;
          args.push('-stream_loop', '-1', '-i', musicPath);
        }
      } catch (_error) {
        this.logger.warn('Background music is missing; rendering with clip audio only');
      }
    }
    const streams = inputs.map((_input, index) => `[${index}:v][${index}:a]`).join('');
    let filter = `${streams}concat=n=${inputs.length}:v=1:a=1[vc][ac];[vc]${subtitles}[v]`;
    let audioMap = '[ac]';
    if (resolvedMusic) {
      const musicIndex = inputs.length;
      filter += `;[${musicIndex}:a]volume=0.18[bg];[ac][bg]amix=inputs=2:duration=first:dropout_transition=0[a]`;
      audioMap = '[a]';
    }
    await this.runFFmpeg([
      ...args,
      '-filter_complex', filter,
      '-map', '[v]', '-map', audioMap,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', outputPath
    ]);
  }

  async renderThumbnail(segmentPath, outputPath) {
    await this.runFFmpeg([
      '-y', '-ss', '0.5', '-i', segmentPath, '-frames:v', '1',
      '-vf', `scale=${this.width}:${this.height}:force_original_aspect_ratio=increase,` +
        `crop=${this.width}:${this.height},setsar=1`,
      '-q:v', '2', outputPath
    ]);
  }

  async approve(episodeId, input = {}) {
    if (input.confirmed !== true) {
      const error = this.conflict('Confirm the clip licences and the schedule before approving');
      error.code = 'RANKED_SHORTS_APPROVAL_REQUIRED';
      throw error;
    }
    const episode = await this.requireEpisode(episodeId);
    if (episode.status !== 'rendered') {
      const error = this.conflict('Render the ranked Short before approving it');
      throw error;
    }
    const rights = this.validateRights(episode.clipPlan);
    if (!rights.complete) {
      const error = this.conflict(`Clip rights are incomplete: ${rights.problems.join('; ')}`);
      error.code = 'RANKED_SHORTS_LICENSE_REQUIRED';
      throw error;
    }
    const videoPath = episode.assets?.video?.path;
    if (!videoPath) throw this.conflict('The rendered ranked Short is missing');
    try {
      const stats = await fs.stat(videoPath);
      if (!stats.isFile() || stats.size <= 0) throw new Error('empty');
    } catch (_error) {
      throw this.conflict('The rendered ranked Short file is missing');
    }

    const publishTime = new Date(input.publishTime || Date.now() + 86400000);
    if (Number.isNaN(publishTime.getTime())) throw this.badRequest('Choose a valid publish time');
    const privacyStatus = input.privacyStatus || episode.privacyStatus || 'private';
    if (!['private', 'unlisted', 'public'].includes(privacyStatus)) {
      throw this.badRequest('Privacy must be private, unlisted, or public');
    }

    const schedule = await this.publishing.scheduleContent({
      id: episode.id,
      script: { title: episode.title },
      seo: {
        title: episode.title,
        description: episode.description,
        tags: episode.tags
      },
      assets: {
        finalVideo: {
          path: videoPath,
          simulated: false,
          aspectRatio: '9:16',
          duration: episode.duration
        },
        audio: episode.assets?.audio || { embedded: true, verifiedAt: new Date().toISOString() },
        // Showcase episodes burn an ASS overlay; that file is not a caption
        // track and must not be uploaded to YouTube as one.
        captions: /\.(srt|vtt)$/i.test(episode.assets?.captions?.path || '')
          ? episode.assets.captions
          : null,
        thumbnail: episode.assets?.thumbnail || null
      },
      scheduledPublishTime: publishTime.toISOString(),
      priority: 60,
      privacyStatus,
      containsSyntheticMedia: input.containsSyntheticMedia === true,
      contentType: 'short',
      sourceProductionId: episode.id
    });
    if (!schedule) {
      throw this.conflict('The ranked Short could not be scheduled because its rendered media evidence is incomplete');
    }

    return this.db.updateRankedShortEpisode(episode.id, {
      status: 'scheduled',
      rightsConfirmedAt: new Date().toISOString(),
      publishTime: publishTime.toISOString(),
      privacyStatus,
      scheduleId: schedule.id,
      error: null
    });
  }

  async publishNow(episodeId) {
    const episode = await this.requireEpisode(episodeId);
    if (episode.status !== 'scheduled') {
      throw this.conflict('Schedule the ranked Short before publishing it');
    }
    if (this.publishing.loadPublishQueue) await this.publishing.loadPublishQueue();
    const entry = await this.publishing.publishContent(episode.id);
    return this.db.updateRankedShortEpisode(episode.id, {
      status: 'published',
      youtubeId: entry.youtubeId || entry.id || null,
      youtubeUrl: entry.youtubeUrl || (entry.youtubeId ? `https://www.youtube.com/shorts/${entry.youtubeId}` : null),
      error: null
    });
  }

  conflict(message) {
    const error = new Error(message);
    error.status = 409;
    return error;
  }

  async assetPath(episodeId, kind) {
    const episode = await this.requireEpisode(episodeId);
    const assets = episode.assets || {};
    const filePath = kind === 'video' ? assets.video?.path
      : kind === 'thumbnail' ? assets.thumbnail?.path
        : kind === 'captions' ? assets.captions?.path
          : null;
    if (!filePath) {
      const error = new Error('Ranked Short asset not found');
      error.status = 404;
      throw error;
    }
    const resolved = path.resolve(filePath);
    const root = path.resolve(this.dataRoot);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      const error = new Error('Ranked Short asset path is not allowed');
      error.status = 403;
      throw error;
    }
    await fs.access(resolved);
    return resolved;
  }
}

module.exports = { RankedShortsService, LICENSE_TYPES };
