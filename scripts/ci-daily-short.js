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

function pickDestination(slot) {
  if (process.env.SHORTS_TOPIC) return String(process.env.SHORTS_TOPIC).trim();
  const dayIndex = Math.floor(Date.now() / 86400000);
  return DESTINATIONS[(dayIndex * 2 + slot) % DESTINATIONS.length];
}

(async () => {
  const slot = Number(process.env.SHORTS_SLOT) === 1 ? 1 : 0;
  const dryRun = String(process.env.SHORTS_DRY_RUN || '').toLowerCase() === 'true';
  const topic = pickDestination(slot);
  console.log(`Destination: ${topic} (slot ${slot}${dryRun ? ', dry run' : ''})`);

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
      musicMood: slot === 1 ? 'tropical' : 'uplifting',
      privacyStatus: 'public'
    });
    console.log(`Episode: ${episode.id}`);
    console.log(`Title: ${episode.title}`);

    const rendered = await ranked.render(episode.id);
    console.log(`Rendered ${rendered.duration}s: ${rendered.assets?.video?.path}`);

    if (dryRun) {
      console.log('Dry run - skipping approval and the YouTube upload');
      return;
    }

    await ranked.approve(rendered.id, {
      confirmed: true,
      publishTime: new Date().toISOString(),
      privacyStatus: 'public'
    });
    const published = await ranked.publishNow(rendered.id);
    console.log(`Published: ${published.youtubeUrl || published.youtubeId || published.id}`);
  } finally {
    await db.close().catch(() => {});
  }
})().catch(error => {
  console.error(`CI Short failed: ${error.message}`);
  process.exit(1);
});
