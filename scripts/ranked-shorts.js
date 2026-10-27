#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const chalk = require('chalk');
const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { PublishingSchedulingAgent } = require('../agents/publishing-scheduling-agent');
const { RankedShortsService } = require('../utils/ranked-shorts-service');
const { StockFootageService } = require('../utils/stock-footage-service');
const { MusicBedService } = require('../utils/music-bed-service');
const { checkFFmpeg, ffmpegInstallHint } = require('../utils/ffmpeg');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index++;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function numberFlag(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function printEpisode(episode, { full = false } = {}) {
  if (!episode) return;
  const lines = [
    `${chalk.bold(episode.id)}  ${chalk.cyan(episode.status)}  ${episode.title || episode.topic}`,
    `  hook: ${episode.hook || '-'}`
  ];
  if (episode.duration) lines.push(`  duration: ${Number(episode.duration).toFixed(1)}s`);
  if (episode.publishTime) lines.push(`  publish: ${episode.publishTime} (${episode.privacyStatus})`);
  if (episode.youtubeUrl) lines.push(`  url: ${episode.youtubeUrl}`);
  if (episode.error) lines.push(`  ${chalk.red(`error: ${episode.error}`)}`);
  if (full) {
    (episode.clipPlan || []).forEach(clip => {
      lines.push(`  #${clip.rank}  ${clip.caption || clip.title}  [${clip.license}]`);
    });
    if (episode.assets?.video?.path) lines.push(`  file: ${episode.assets.video.path}`);
  }
  console.log(lines.join('\n'));
}

function usage() {
  console.log([
    'Ranked Shorts (licensed clip countdowns, 9:16)',
    '',
    'Usage:',
    '  node scripts/ranked-shorts.js plan --dir <clips folder> --topic "<topic>" [options]',
    '  node scripts/ranked-shorts.js stock --topic "<topic>" [--count 6] [--format showcase] (needs PEXELS_API_KEY or PIXABAY_API_KEY)',
    '  node scripts/ranked-shorts.js render <episodeId>',
    '  node scripts/ranked-shorts.js approve <episodeId> --confirm [--at <ISO time>] [--privacy private|unlisted|public] [--now]',
    '  node scripts/ranked-shorts.js list',
    '  node scripts/ranked-shorts.js show <episodeId>',
    '',
    'Plan options:',
    '  --dir <folder>        Folder of clips plus an optional clips.json manifest',
    '  --license <type>      owned | licensed | cc-by | cc-by-sa | public-domain | permission',
    '  --source <note>       Where the licence comes from (required unless clips.json sets it)',
    '  --count <2-10>        Number of clips in the countdown (default: 7)',
    '  --format <type>       ranked (countdown #N to #1) or showcase (travel destination highlights)',
    '  --overlay "<text>"    Showcase overlay label (default: AI-generated, e.g. "♥ Venice")',
    '  --hook "<line>"       Override the opening hook',
    '  --max-seconds <10-180> Hard cap for the Short (default: 60, showcase: 24)',
    '  --fit crop|blur       Full-bleed crop (default) or blurred letterbox',
    '  --render              Also render the episode right after planning',
    '  --music <file|auto>   Music bed: a local file, or "auto" for a free CC-BY track (showcase defaults to auto)',
    '  --privacy <status>    Default privacy for the later schedule',
    '',
    'clips.json format:',
    '  {"clips":[{"file":"01.mp4","title":"Croc steals the boat","license":"owned",',
    '             "source":"self-recorded","start":2,"duration":7}]}'
  ].join('\n'));
}

function resolveMusicFlag(flag) {
  if (flag === undefined || flag === null || flag === false) return undefined;
  if (flag === 'auto') return 'auto';
  if (flag === true) return undefined;
  return path.resolve(String(flag));
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || command === 'help' || flags.help) {
    usage();
    return;
  }
  if (!await checkFFmpeg()) {
    throw new Error(ffmpegInstallHint());
  }

  const db = new Database();
  await db.initialize();
  let publishing = null;
  let service = null;

  try {
    if (command === 'list') {
      const episodes = await db.listRankedShortEpisodes(50);
      if (!episodes.length) console.log('No ranked Short episodes yet.');
      episodes.forEach(episode => printEpisode(episode));
      return;
    }

    if (command === 'show') {
      if (!positional[1]) throw new Error('Pass an episode id');
      printEpisode(await db.getRankedShortEpisode(positional[1]), { full: true });
      return;
    }

    const credentials = new CredentialManager();
    await credentials.initialize();
    publishing = new PublishingSchedulingAgent(db, credentials);
    if (!['plan', 'stock'].includes(command)) await publishing.initialize();
    service = new RankedShortsService(db, publishing, {
      logger: publishing.logger,
      credentials,
      musicBed: new MusicBedService({ logger: publishing.logger })
    });

    if (command === 'plan') {
      const clipsDir = flags.dir ? path.resolve(String(flags.dir)) : null;
      const episode = await service.plan({
        topic: flags.topic,
        format: flags.format,
        overlay: flags.overlay,
        hook: flags.hook,
        count: numberFlag(flags.count),
        clipsDir,
        license: flags.license,
        licenseSource: flags.source,
        maxSeconds: numberFlag(flags['max-seconds']),
        fit: flags.fit,
        music: resolveMusicFlag(flags.music),
        musicPath: resolveMusicFlag(flags.music) === 'auto' ? undefined : resolveMusicFlag(flags.music),
        privacyStatus: flags.privacy
      });
      printEpisode(episode, { full: true });
      if (flags.render) {
        const rendered = await service.render(episode.id);
        printEpisode(rendered, { full: true });
      }
      console.log(chalk.gray(`\nNext: node scripts/ranked-shorts.js render ${episode.id}`));
      return;
    }

    if (command === 'stock') {
      const stock = new StockFootageService({
        logger: publishing.logger,
        credentials
      });
      if (!stock.isAvailable()) {
        throw new Error('No stock provider configured. Get a free key at https://pixabay.com/api/docs/ (PIXABAY_API_KEY) or https://www.pexels.com/api/ (PEXELS_API_KEY) and add it to .env');
      }
      const queries = flags.queries
        ? String(flags.queries).split(',').map(query => query.trim()).filter(Boolean)
        : [];
      const showcase = flags.format === 'showcase';
      const autoMusic = flags.music === undefined ? (showcase ? 'auto' : undefined) : resolveMusicFlag(flags.music);
      const clips = await stock.collectClips({
        topic: flags.topic,
        count: numberFlag(flags.count) || (showcase ? 8 : undefined),
        queries: queries.length ? queries : undefined,
        maxSeconds: showcase ? 5 : undefined
      });
      const episode = await service.plan({
        topic: flags.topic,
        format: flags.format,
        overlay: flags.overlay,
        hook: flags.hook,
        count: clips.length,
        clips,
        source: stock.provider,
        queries,
        maxSeconds: numberFlag(flags['max-seconds']) || (showcase ? 24 : undefined),
        fit: flags.fit,
        music: autoMusic,
        musicPath: autoMusic === 'auto' ? undefined : autoMusic,
        privacyStatus: flags.privacy
      });
      printEpisode(episode, { full: true });
      if (flags.render) {
        const rendered = await service.render(episode.id);
        printEpisode(rendered, { full: true });
      }
      console.log(chalk.gray(`\nNext: node scripts/ranked-shorts.js render ${episode.id}`));
      return;
    }

    if (command === 'render') {
      if (!positional[1]) throw new Error('Pass an episode id');
      printEpisode(await service.render(positional[1]), { full: true });
      console.log(chalk.gray(`\nNext: node scripts/ranked-shorts.js approve ${positional[1]} --confirm`));
      return;
    }

    if (command === 'approve') {
      if (!positional[1]) throw new Error('Pass an episode id');
      if (flags.confirm !== true) throw new Error('Add --confirm to approve the clip licences and schedule');
      const episode = await service.approve(positional[1], {
        confirmed: true,
        publishTime: flags.at,
        privacyStatus: flags.privacy
      });
      printEpisode(episode, { full: true });
      if (flags.now === true) {
        printEpisode(await service.publishNow(episode.id));
      } else {
        console.log(chalk.gray('\nThe scheduler publishes this at its scheduled time. Add --now to upload immediately.'));
      }
      return;
    }

    usage();
    throw new Error(`Unknown command: ${command}`);
  } finally {
    await db.close();
  }
}

main().catch(error => {
  console.error(chalk.red(`\nRanked Shorts failed: ${error.message}`));
  process.exitCode = 1;
});
