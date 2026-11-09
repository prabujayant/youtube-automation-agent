const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { CredentialManager } = require('../utils/credential-manager');
const { google } = require('googleapis');
const { runSlot } = require('./ci-daily-short');

// The three daily publish slots (UTC): 01:30 = 07:00 IST, 09:30 = 15:00 IST,
// 16:30 = 22:00 IST. Keep in sync with scripts/ci-daily-short.js.
const SLOT_MINUTES = [[1, 30], [9, 30], [16, 30]];

function slotOf(publishAt) {
  const minutes = publishAt.getUTCHours() * 60 + publishAt.getUTCMinutes();
  if (minutes < 5 * 60) return 0;
  if (minutes < 13 * 60) return 1;
  return 2;
}

// First slot strictly after `afterMs`, so a fill run never reuses the slot that
// just published.
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

// Every publish time that already has a private scheduled upload. The filler
// walks forward from now and fills only the gaps, so it can retrofit a new
// cadence (for example adding a third daily slot) without duplicating slots.
async function scheduledSlots() {
  const credentials = new CredentialManager();
  await credentials.initialize();
  const auth = credentials.getYouTubeAuth();
  await auth.refreshAccessToken();
  const youtube = google.youtube({ version: 'v3', auth });
  const channel = await youtube.channels.list({ part: 'contentDetails', mine: true });
  const uploads = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) return new Set();
  const playlist = await youtube.playlistItems.list({
    part: 'contentDetails',
    playlistId: uploads,
    maxResults: 50
  });
  const ids = (playlist.data.items || [])
    .map(item => item.contentDetails?.videoId)
    .filter(Boolean);
  if (!ids.length) return new Set();
  const videos = await youtube.videos.list({ part: 'snippet,status', id: ids.join(',') });
  const scheduled = new Set();
  for (const video of videos.data.items || []) {
    if (!video.status?.publishAt || video.status.privacyStatus === 'public') continue;
    scheduled.add(new Date(video.status.publishAt).toISOString().slice(0, 16));
  }
  return scheduled;
}

async function main() {
  const count = Math.max(1, Math.min(20, Number(process.env.SHORTS_FILL_COUNT) || 10));
  const dryRun = String(process.env.SHORTS_DRY_RUN || '').toLowerCase() === 'true';
  const format = String(process.env.SHORTS_FORMAT || 'viral').toLowerCase();
  const horizonMs = Date.now() + 30 * 86400000;
  const existing = await scheduledSlots();

  console.log(`Filling up to ${count} empty slots from ${new Date().toISOString()}${dryRun ? ' (dry run)' : ''}`);

  let cursor = Date.now() - 60000;
  let filled = 0;
  let skipped = 0;
  let dryRuns = 0;
  let examined = 0;
  const maxExamined = count * 12;
  while (filled + dryRuns < count && examined < maxExamined) {
    const publishAt = nextSlotAfter(cursor);
    cursor = publishAt.getTime();
    examined++;
    if (publishAt.getTime() > horizonMs) {
      console.log('Stopping: the schedule is already 30 days deep');
      break;
    }
    const key = publishAt.toISOString().slice(0, 16);
    if (existing.has(key)) {
      skipped++;
      continue;
    }
    const slot = slotOf(publishAt);
    try {
      const result = await runSlot({ publishAt, slot, format, dryRun });
      if (result.status === 'skipped') {
        skipped++;
      } else if (result.status === 'dry-run') {
        dryRuns++;
      } else {
        filled++;
        existing.add(key);
      }
      console.log(`[fill] ${publishAt.toISOString()} -> ${result.status} ${result.videoId || result.episodeId || ''}`);
    } catch (error) {
      if (error.code === 'UPLOAD_CAP') {
        console.log(`[fill] Upload cap reached at ${publishAt.toISOString()}: ${error.message}`);
        break;
      }
      console.error(`[fill] ${publishAt.toISOString()} failed: ${error.message}`);
    }
  }
  console.log(`Fill complete: ${filled} scheduled, ${dryRuns} dry-run, ${skipped} already present`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Queue fill failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { nextSlotAfter, slotOf, scheduledSlots };
