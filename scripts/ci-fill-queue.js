const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { CredentialManager } = require('../utils/credential-manager');
const { google } = require('googleapis');
const { runSlot } = require('./ci-daily-short');

// The two daily publish slots (UTC): 01:30 = 07:00 IST, 13:30 = 19:00 IST.
const SLOT_MINUTES = [[1, 30], [13, 30]];

function slotOf(publishAt) {
  return publishAt.getUTCHours() >= 12 ? 1 : 0;
}

// First slot strictly after `afterMs`, so a fill run never reuses the slot that
// last published or is already scheduled.
function nextSlotAfter(afterMs) {
  const after = new Date(afterMs);
  const candidates = [];
  for (let offset = 0; offset <= 2; offset++) {
    const day = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate() + offset);
    for (const [hour, minute] of SLOT_MINUTES) {
      const candidate = day + hour * 3600000 + minute * 60000;
      if (candidate > afterMs + 60000) candidates.push(candidate);
    }
  }
  return new Date(Math.min(...candidates));
}

async function lastScheduledAt() {
  const credentials = new CredentialManager();
  await credentials.initialize();
  const auth = credentials.getYouTubeAuth();
  await auth.refreshAccessToken();
  const youtube = google.youtube({ version: 'v3', auth });
  const channel = await youtube.channels.list({ part: 'contentDetails', mine: true });
  const uploads = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return Date.now();
  const playlist = await youtube.playlistItems.list({
    part: 'contentDetails',
    playlistId: uploads,
    maxResults: 50
  });
  const ids = (playlist.data.items || [])
    .map(item => item.contentDetails?.videoId)
    .filter(Boolean);
  if (!ids.length) return Date.now();
  const videos = await youtube.videos.list({ part: 'snippet,status', id: ids.join(',') });
  const times = (videos.data.items || [])
    .filter(video => video.status?.publishAt && video.status.privacyStatus !== 'public')
    .map(video => Date.parse(video.status.publishAt))
    .filter(Number.isFinite);
  return times.length ? Math.max(...times) : Date.now();
}

async function main() {
  const count = Math.max(1, Math.min(20, Number(process.env.SHORTS_FILL_COUNT) || 10));
  const dryRun = String(process.env.SHORTS_DRY_RUN || '').toLowerCase() === 'true';
  const format = String(process.env.SHORTS_FORMAT || 'viral').toLowerCase();
  const horizonMs = Date.now() + 30 * 86400000;

  let cursor = Math.max(await lastScheduledAt(), Date.now());
  console.log(`Filling up to ${count} slots after ${new Date(cursor).toISOString()}${dryRun ? ' (dry run)' : ''}`);

  let filled = 0;
  let skipped = 0;
  for (let index = 0; index < count; index++) {
    const publishAt = nextSlotAfter(cursor);
    if (publishAt.getTime() > horizonMs) {
      console.log('Stopping: the schedule is already 30 days deep');
      break;
    }
    const slot = slotOf(publishAt);
    try {
      const result = await runSlot({ publishAt, slot, format, dryRun });
      if (result.status === 'skipped') {
        skipped++;
      } else {
        filled++;
      }
      console.log(`[fill] ${publishAt.toISOString()} -> ${result.status} ${result.videoId || result.episodeId || ''}`);
    } catch (error) {
      if (error.code === 'UPLOAD_CAP') {
        console.log(`[fill] Upload cap reached at ${publishAt.toISOString()}: ${error.message}`);
        break;
      }
      console.error(`[fill] ${publishAt.toISOString()} failed: ${error.message}`);
    }
    cursor = publishAt.getTime();
  }
  console.log(`Fill complete: ${filled} scheduled, ${skipped} already present`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Queue fill failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { nextSlotAfter, slotOf, lastScheduledAt };
