const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { StockFootageService } = require('../utils/stock-footage-service');
const { RankedShortsService } = require('../utils/ranked-shorts-service');
const { MusicBedService } = require('../utils/music-bed-service');
const { DESTINATIONS } = require('../utils/destination-rotation');

const VIRAL_COUNT = 7;

function resolveTarget() {
  const rawDate = String(process.env.SHORTS_TARGET_DATE || '').trim();
  const rawPublishAt = String(process.env.SHORTS_PUBLISH_AT || '').trim();
  const publishAt = rawPublishAt ? new Date(rawPublishAt) : new Date();
  if (Number.isNaN(publishAt.getTime())) {
    throw new Error(`Invalid SHORTS_PUBLISH_AT: ${rawPublishAt}`);
  }
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
    ? rawDate
    : publishAt.toISOString().slice(0, 10);
  return { publishAt, targetDate };
}

function dayIndexFor(targetDate) {
  const dayMs = Date.parse(`${targetDate}T00:00:00Z`);
  return Math.floor((Number.isFinite(dayMs) ? dayMs : Date.now()) / 86400000);
}

// First slot that uses the current rotation: 2026-11-15 13:30 UTC (19:00 IST),
// the next empty slot when the list was refreshed. Anchoring on a fixed slot
// keeps the destination deterministic for a given publish time across reruns.
const ROTATION_START_SLOT = dayIndexFor('2026-11-15') * 2 + 1;

function topicOffset() {
  const value = Number(process.env.SHORTS_TOPIC_OFFSET);
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function pickDestination(slot, targetDate) {
  if (process.env.SHORTS_TOPIC) return String(process.env.SHORTS_TOPIC).trim();
  const globalSlot = dayIndexFor(targetDate) * 2 + slot;
  const index = globalSlot - ROTATION_START_SLOT + topicOffset();
  return DESTINATIONS[((index % DESTINATIONS.length) + DESTINATIONS.length) % DESTINATIONS.length];
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// A retry or a delayed run must never upload the same destination twice. The
// channel itself is the source of truth, including private scheduled uploads.
async function findExistingTarget(youtube, topic, publishAt) {
  if (!youtube) return null;
  const channel = await youtube.channels.list({ part: 'contentDetails', mine: true });
  const uploads = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return null;

  const playlist = await youtube.playlistItems.list({
    part: 'contentDetails',
    playlistId: uploads,
    maxResults: 50
  });
  const ids = (playlist.data.items || [])
    .map(item => item.contentDetails?.videoId)
    .filter(Boolean);
  if (!ids.length) return null;

  const videos = await youtube.videos.list({ part: 'snippet,status', id: ids.join(',') });
  const targetMs = publishAt.getTime();
  const targetDay = publishAt.toISOString().slice(0, 10);
  const wanted = normalize(topic);

  for (const video of videos.data.items || []) {
    const scheduledMs = video.status?.publishAt ? Date.parse(video.status.publishAt) : NaN;
    if (Number.isFinite(scheduledMs) && Math.abs(scheduledMs - targetMs) <= 15 * 60 * 1000) {
      return { video, reason: 'publishAt' };
    }
    const titled = normalize(video.snippet?.title);
    const publishedMs = video.snippet?.publishedAt ? Date.parse(video.snippet.publishedAt) : NaN;
    const publishedDay = Number.isFinite(publishedMs)
      ? new Date(publishedMs).toISOString().slice(0, 10)
      : '';
    if (wanted && titled.includes(wanted) && publishedDay === targetDay) {
      return { video, reason: 'title+date' };
    }
  }
  return null;
}

async function runSlot(options = {}) {
  const slot = Number(options.slot) === 1 ? 1 : 0;
  const dryRun = options.dryRun === true;
  const requestedFormat = String(options.format || '').toLowerCase();
  const format = ['showcase', 'viral', 'ranked'].includes(requestedFormat) ? requestedFormat : 'viral';
  const publishAt = options.publishAt instanceof Date ? options.publishAt : new Date(options.publishAt);
  if (Number.isNaN(publishAt.getTime())) {
    throw new Error(`Invalid publish time: ${options.publishAt}`);
  }
  const targetDate = publishAt.toISOString().slice(0, 10);
  const topic = options.topic ? String(options.topic).trim() : pickDestination(slot, targetDate);
  const scheduled = publishAt.getTime() > Date.now() + 60000;
  console.log(`Destination: ${topic} (slot ${slot}, ${format}${dryRun ? ', dry run' : ''})`);
  console.log(`Target publish: ${publishAt.toISOString()} (${scheduled ? 'scheduled' : 'immediate'})`);

  const db = new Database();
  await db.initialize();
  try {
    const credentials = new CredentialManager();
    await credentials.initialize();
    const oauth = credentials.getYouTubeAuth();
    const refreshed = await oauth.refreshAccessToken();
    if (!refreshed.credentials?.access_token) {
      throw new Error('YouTube token refresh returned no access token');
    }
    console.log(`YouTube token verified; access token valid until ${new Date(refreshed.credentials.expiry_date).toISOString()}`);
    const publishing = new PublishingSchedulingAgent(db, credentials);
    await publishing.initialize();

    const existing = await findExistingTarget(publishing.youtube, topic, publishAt);
    if (existing) {
      const videoId = existing.video.id;
      const state = existing.video.status?.publishAt ? 'scheduled' : 'published';
      console.log(`Already ${state}: https://www.youtube.com/watch?v=${videoId} (matched by ${existing.reason})`);
      return { status: 'skipped', videoId, topic, publishAt };
    }

    const logger = publishing.logger;
    const stock = new StockFootageService({ logger, credentials });
    const ranked = new RankedShortsService(db, publishing, {
      logger,
      credentials,
      musicBed: new MusicBedService({ logger })
    });

    const clips = await stock.collectClips({ topic, count: 8, maxSeconds: 5 });
    if (!clips.length) throw new Error(`No stock clips found for ${topic}`);

    const episode = await ranked.plan({
      topic,
      clips,
      count: format === 'showcase' ? 8 : VIRAL_COUNT,
      format,
      source: stock.provider,
      music: 'auto',
      musicMood: slot === 1 ? 'viral-tropical' : 'viral-uplifting',
      // Offset too, so the two channels never publish the same track in the
      // same slot.
      musicDayIndex: dayIndexFor(targetDate) + slot + topicOffset(),
      musicPremium: format === 'viral',
      privacyStatus: 'public'
    });
    console.log(`Episode: ${episode.id}`);
    console.log(`Title: ${episode.title}`);
    if (episode.assets?.musicPath) {
      console.log(`Music bed: ${path.basename(episode.assets.musicPath)}`);
    }

    const rendered = await ranked.render(episode.id);
    console.log(`Rendered ${rendered.duration}s: ${rendered.assets?.video?.path}`);

    if (dryRun) {
      console.log('Dry run - skipping approval and the YouTube upload');
      return { status: 'dry-run', episodeId: rendered.id, topic, publishAt };
    }

    await ranked.approve(rendered.id, {
      confirmed: true,
      publishTime: publishAt.toISOString(),
      privacyStatus: 'public'
    });
    let published;
    try {
      published = await ranked.publishNow(rendered.id);
    } catch (error) {
      if (/exceeded the number of videos/i.test(String(error.message))) {
        error.code = 'UPLOAD_CAP';
      }
      throw error;
    }
    const url = published.youtubeUrl || published.youtubeId || published.id;
    console.log(scheduled
      ? `Scheduled: ${url} (publishes ${publishAt.toISOString()})`
      : `Published: ${url}`);
    return { status: scheduled ? 'scheduled' : 'published', videoId: published.youtubeId || published.id, url, topic, publishAt };
  } finally {
    await db.close().catch(() => {});
  }
}

if (require.main === module) {
  (async () => {
    const { publishAt } = resolveTarget();
    const slot = Number(process.env.SHORTS_SLOT) === 1 ? 1 : 0;
    await runSlot({
      publishAt,
      slot,
      format: process.env.SHORTS_FORMAT,
      dryRun: String(process.env.SHORTS_DRY_RUN || '').toLowerCase() === 'true',
      topic: process.env.SHORTS_TOPIC
    });
  })().catch(error => {
    console.error(`CI Short failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { runSlot, pickDestination, dayIndexFor, DESTINATIONS };

