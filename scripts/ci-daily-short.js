const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { StockFootageService } = require('../utils/stock-footage-service');
const { RankedShortsService } = require('../utils/ranked-shorts-service');
const { MusicBedService } = require('../utils/music-bed-service');

// Keep in sync with the ranked_shorts_topics rotation in the local automation.
const DESTINATIONS = [
  'Venice Italy',
  'Santorini Greece',
  'Bali Indonesia',
  'Kyoto Japan',
  'Paris France',
  'Swiss Alps Switzerland',
  'Maldives',
  'Dubai UAE',
  'New York City',
  'Amalfi Coast Italy',
  'Lisbon Portugal',
  'Reykjavik Iceland',
  'Marrakech Morocco',
  'Prague Czech Republic',
  'Cappadocia Turkey',
  'Queenstown New Zealand'
];

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

function pickDestination(slot, targetDate) {
  if (process.env.SHORTS_TOPIC) return String(process.env.SHORTS_TOPIC).trim();
  const dayMs = Date.parse(`${targetDate}T00:00:00Z`);
  const dayIndex = Math.floor((Number.isFinite(dayMs) ? dayMs : Date.now()) / 86400000);
  return DESTINATIONS[(dayIndex * 2 + slot) % DESTINATIONS.length];
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

(async () => {
  const slot = Number(process.env.SHORTS_SLOT) === 1 ? 1 : 0;
  const dryRun = String(process.env.SHORTS_DRY_RUN || '').toLowerCase() === 'true';
  const { publishAt, targetDate } = resolveTarget();
  const topic = pickDestination(slot, targetDate);
  const scheduled = publishAt.getTime() > Date.now() + 60000;
  console.log(`Destination: ${topic} (slot ${slot}${dryRun ? ', dry run' : ''})`);
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
      return;
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
      count: clips.length,
      format: 'showcase',
      source: stock.provider,
      music: 'auto',
      musicMood: slot === 1 ? 'viral-tropical' : 'viral-uplifting',
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
      return;
    }

    await ranked.approve(rendered.id, {
      confirmed: true,
      publishTime: publishAt.toISOString(),
      privacyStatus: 'public'
    });
    const published = await ranked.publishNow(rendered.id);
    const url = published.youtubeUrl || published.youtubeId || published.id;
    console.log(scheduled
      ? `Scheduled: ${url} (publishes ${publishAt.toISOString()})`
      : `Published: ${url}`);
  } finally {
    await db.close().catch(() => {});
  }
})().catch(error => {
  console.error(`CI Short failed: ${error.message}`);
  process.exit(1);
});
